import {
  OrchestratorMcpFailure,
  OrchestratorMcpTargetOptions,
  type CovenDefinition,
  type CovenGateRound,
  type ThreadId,
} from "@t3tools/contracts";
import { parseCovenSource } from "@t3tools/shared/covenDefinition";
import {
  covenGateElectorate,
  isCoolingDown,
  pickCovenCandidate,
} from "@t3tools/shared/covenRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CovenControlService from "../../../coven/CovenControlService.ts";
import * as CovenService from "../../../coven/CovenService.ts";
import {
  delegationRefusal,
  leaderRole,
  type CovenRunRecord,
  type CovenTaskState,
} from "../../../coven/covenRunState.ts";
import { buildCovenWorkerTask } from "../../../coven/covenWorkerTask.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { CovenToolkit } from "./tools.ts";

const decodeTargetOptions = Schema.decodeUnknownEffect(OrchestratorMcpTargetOptions);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const toMcpFailure = (error: { readonly reason?: string; readonly message: string }) =>
  failure(
    error.reason === "policy-denied"
      ? "capability_denied"
      : error.reason === "not-found" || error.reason === "invalid-definition"
        ? "invalid_request"
        : "orchestration_error",
    error.message,
  );

const gateRoundView = (round: CovenGateRound) => ({
  id: round.id,
  gateId: round.gateId,
  round: round.round,
  status: round.status,
  detail: round.detail,
  votes: round.votes.map((vote) => ({
    roleId: vote.roleId,
    decision: vote.decision,
    rationale: vote.rationale,
  })),
});

const taskView = (task: CovenTaskState) => {
  const attempt = task.attempts.at(-1);
  const lastFailure = [...task.attempts].reverse().find((candidate) => candidate.failureMessage);
  return {
    id: task.id,
    roleId: task.roleId,
    title: task.title,
    status: task.status,
    childThreadId: task.childThreadId,
    model: attempt ? `${attempt.providerInstanceId} / ${attempt.modelId}` : "",
    attempts: task.attempts.length,
    lastFailure: lastFailure?.failureMessage ?? null,
  };
};

const runSnapshot = (run: CovenRunRecord, definition: CovenDefinition) => ({
  runId: run.id,
  status: run.state.status,
  statusReason: run.state.statusReason,
  plan: run.state.plan ? { status: run.state.plan.status, text: run.state.plan.text } : null,
  leader: `${run.state.leader.providerInstanceId} / ${run.state.leader.modelId}`,
  delegationsUsed: run.state.delegations,
  maxDelegations: definition.frontMatter.limits.maxDelegationsPerRun,
  tasks: run.state.tasks.map(taskView),
  gates: run.state.gates.map(gateRoundView),
  docsPath: run.state.docsPath,
});

const makeHandlers = (
  covensOption: Option.Option<CovenService.CovenService["Service"]>,
  controlOption: Option.Option<CovenControlService.CovenControlService["Service"]>,
  random: SecureRandom.SecureRandom["Service"],
) => {
  const services = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Coven tools");
    if (Option.isNone(covensOption) || Option.isNone(controlOption)) {
      return yield* failure("capability_denied", "Covens are not available on this server.");
    }
    return { scope: caller, covens: covensOption.value, control: controlOption.value };
  });

  const callerScope = Effect.gen(function* () {
    const { scope, covens, control } = yield* services;
    const covenScope = yield* covens
      .threadScope(scope.thread.threadId)
      .pipe(Effect.mapError(toMcpFailure));
    return { scope, covens, control, covenScope };
  });

  const leaderScope = Effect.gen(function* () {
    const context = yield* callerScope;
    const { covenScope } = context;
    if (covenScope === null || covenScope.kind !== "leader") {
      return yield* failure(
        "capability_denied",
        covenScope === null
          ? "This thread has no coven. The user picks one with /coven change <name>."
          : "Only the coven leader can do this.",
      );
    }
    const run =
      covenScope.run ??
      (yield* context.covens
        .ensureRun(context.scope.thread.threadId)
        .pipe(Effect.mapError(toMcpFailure)));
    if (run === null)
      return yield* failure("capability_denied", "This coven has no run in progress.");
    const definition =
      (yield* context.covens
        .definitionAt(run.covenId, run.revision)
        .pipe(Effect.mapError(toMcpFailure))) ?? covenScope.definition;
    return { ...context, run, definition, leaderThreadId: context.scope.thread.threadId };
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const builderDraft = Effect.gen(function* () {
    const { scope, covens } = yield* services;
    const draft = yield* covens
      .draftForThread(scope.thread.threadId)
      .pipe(Effect.mapError(toMcpFailure));
    if (draft === null) {
      return yield* failure("capability_denied", "This isn't a coven builder thread.");
    }
    return { scope, covens, draft };
  });

  return {
    coven_capabilities: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const { covens, covenScope } = yield* callerScope;
        if (covenScope === null) return { coven: null };
        const run = covenScope.run;
        const definition =
          (run
            ? yield* covens
                .definitionAt(run.covenId, run.revision)
                .pipe(Effect.mapError(toMcpFailure))
            : null) ?? covenScope.definition;
        const frontMatter = definition.frontMatter;
        const cooldowns = yield* covens.cooldowns.pipe(Effect.mapError(toMcpFailure));
        const nowMs = Date.parse(yield* nowIso);
        return {
          coven: {
            id: frontMatter.id,
            name: frontMatter.name,
            revision: run?.revision ?? covenScope.binding.revision,
            yourRole: covenScope.kind === "leader" ? leaderRole(definition).id : covenScope.roleId,
            mission: definition.instructions.mission,
            sharedGuidance: definition.instructions.sharedGuidance,
            roles: frontMatter.roles.map((role) => ({
              id: role.id,
              kind: role.kind,
              name: role.name,
              responsibility: role.responsibility,
              candidates: role.candidates.map((candidate) => ({
                providerInstanceId: candidate.providerInstanceId,
                modelId: candidate.modelId,
                coolingDownUntil: isCoolingDown(candidate, cooldowns, nowMs)
                  ? (cooldowns.find(
                      (cooldown) =>
                        cooldown.providerInstanceId === candidate.providerInstanceId &&
                        cooldown.modelId === candidate.modelId,
                    )?.resetAt ?? "unknown")
                  : null,
              })),
            })),
            gates: frontMatter.governance.gates.map((gate) => ({
              id: gate.id,
              type: gate.type,
              on: gate.on,
              voters: covenGateElectorate(gate),
            })),
            limits: {
              maxActiveWorkers: frontMatter.limits.maxActiveWorkers,
              maxDelegationsPerRun: frontMatter.limits.maxDelegationsPerRun,
              maxReviewFixRounds: frontMatter.limits.maxReviewFixRounds,
              maxRuntimeMinutes: frontMatter.limits.maxRuntimeMinutes,
            },
            planApprovalRequired: frontMatter.autonomy.initialPlanApproval,
            run: run ? runSnapshot(run, definition) : null,
          },
        };
      }),
    ),

    coven_task_status: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const { covens, covenScope } = yield* callerScope;
        if (covenScope === null || covenScope.run === null) return { run: null };
        const run = covenScope.run;
        const definition =
          (yield* covens
            .definitionAt(run.covenId, run.revision)
            .pipe(Effect.mapError(toMcpFailure))) ?? covenScope.definition;
        return { run: runSnapshot(run, definition) };
      }),
    ),

    coven_delegate_role: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { scope, covens, control, run, definition } = yield* leaderScope;
        const role = definition.frontMatter.roles.find(
          (candidate) => candidate.id === input.roleId,
        );
        if (role === undefined || role.kind !== "worker") {
          return yield* failure(
            "invalid_request",
            `The coven has no worker role "${input.roleId}". Roles: ${definition.frontMatter.roles
              .filter((candidate) => candidate.kind === "worker")
              .map((candidate) => candidate.id)
              .join(", ")}.`,
          );
        }
        if (input.clientRequestId !== undefined) {
          const existing = run.state.tasks.find(
            (task) => task.clientRequestId === input.clientRequestId,
          );
          if (existing !== undefined) {
            const attempt = existing.attempts.at(-1);
            return {
              taskId: existing.id,
              roleId: existing.roleId,
              providerInstanceId: attempt?.providerInstanceId ?? "",
              modelId: attempt?.modelId ?? "",
              replayed: true,
              childThreadId: existing.childThreadId,
            };
          }
        }
        const refusal = delegationRefusal(run.state, definition, role.id);
        if (refusal !== null) return yield* failure("capability_denied", refusal);
        const limits = definition.frontMatter.limits;
        if (run.state.delegations >= limits.maxDelegationsPerRun) {
          return yield* failure(
            "capability_denied",
            `This coven allows ${limits.maxDelegationsPerRun} delegations per run, and all are used. Ask the user before doing more.`,
          );
        }
        const running = run.state.tasks.filter((task) => task.status === "running");
        if (running.length >= limits.maxActiveWorkers) {
          return yield* failure(
            "capability_denied",
            `${running.length} workers are already running (limit ${limits.maxActiveWorkers}). Wait for one to finish.`,
          );
        }
        // Hybrid workspaces: the shared checkout has one writer at a time, and a
        // parallel writer gets its own worktree unless the leader chose otherwise.
        const sharedBusy = running.some((task) => task.workspace === "shared");
        const isolation = input.isolation ?? (sharedBusy ? "worktree" : "shared");
        if (isolation === "shared" && sharedBusy) {
          return yield* failure(
            "capability_denied",
            "Another worker is writing in the shared checkout. Wait for it, or use isolation 'worktree'.",
          );
        }
        const unknownDependency = (input.dependsOn ?? []).find(
          (id) => !run.state.tasks.some((task) => task.id === id),
        );
        if (unknownDependency !== undefined) {
          return yield* failure("invalid_request", `There is no task ${unknownDependency}.`);
        }
        const cooldowns = yield* covens.cooldowns.pipe(Effect.mapError(toMcpFailure));
        const now = yield* nowIso;
        const index = pickCovenCandidate(role.candidates, 0, cooldowns, Date.parse(now));
        if (index === null) {
          return yield* failure(
            "provider_unavailable",
            `Every model for ${role.name} is out of quota right now. Try another role, or ask the user.`,
          );
        }
        const candidate = role.candidates[index]!;
        const options =
          candidate.options === undefined
            ? undefined
            : yield* decodeTargetOptions(candidate.options).pipe(
                Effect.mapError(() =>
                  failure("invalid_request", `Role "${role.id}" has model options T3 can't use.`),
                ),
              );
        const memory = yield* control.memoryExcerpt(run);
        const gateIds = definition.frontMatter.governance.gates
          .filter((gate) => covenGateElectorate(gate).includes(role.id))
          .map((gate) => gate.id);
        const taskId = `task-${run.state.tasks.length + 1}-${(yield* random.uuidV4()).slice(0, 8)}`;
        const title = (input.title ?? input.task.split("\n")[0] ?? input.task).slice(0, 200);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegated = yield* service.delegateTask(scope, {
          task: buildCovenWorkerTask({ definition, role, task: input.task, memory, gateIds }),
          title: `${role.name}: ${title}`.slice(0, 512),
          target: {
            providerInstanceId: candidate.providerInstanceId,
            model: candidate.modelId,
            ...(options === undefined ? {} : { options }),
          },
          isolation,
          clientRequestId: `coven:${run.id}:${input.clientRequestId ?? taskId}`,
        });
        const task: CovenTaskState = {
          id: taskId,
          roleId: role.id,
          title,
          status: "running",
          workspace: isolation === "worktree" ? "isolated" : "shared",
          dependsOn: input.dependsOn ?? [],
          childThreadId: delegated.childThreadId,
          result: null,
          attempts: [
            {
              id: delegated.taskId,
              attempt: 1,
              candidateIndex: index,
              providerInstanceId: candidate.providerInstanceId,
              modelId: candidate.modelId,
              childThreadId: delegated.childThreadId,
              status: "running",
              failureClass: null,
              failureMessage: null,
              startedAt: now,
              endedAt: null,
            },
          ],
          createdAt: now,
          updatedAt: now,
          clientRequestId: input.clientRequestId ?? null,
          candidateIndex: index,
          transientRetries: 0,
        };
        yield* covens
          .updateRun(run.id, (record) =>
            Effect.succeed({
              state: {
                ...record.state,
                delegations: record.state.delegations + 1,
                tasks: [...record.state.tasks, task],
              },
              events: [
                {
                  kind: "task.delegated",
                  summary: `${role.name} took "${title}" on ${candidate.providerInstanceId} / ${candidate.modelId}.`,
                },
              ],
              result: undefined,
            }),
          )
          .pipe(Effect.mapError(toMcpFailure));
        if (delegated.childThreadId !== null) {
          yield* covens
            .registerChild(delegated.childThreadId as ThreadId, {
              runId: run.id,
              taskId,
              roleId: role.id,
            })
            .pipe(Effect.mapError(toMcpFailure));
        }
        return {
          taskId,
          roleId: role.id,
          providerInstanceId: candidate.providerInstanceId,
          modelId: candidate.modelId,
          replayed: false,
          childThreadId: delegated.childThreadId,
        };
      }),
    ),

    coven_propose_plan: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { control, leaderThreadId } = yield* leaderScope;
        const state = yield* control
          .proposePlan(leaderThreadId, input.plan)
          .pipe(Effect.mapError(toMcpFailure));
        return { status: state.status, planStatus: state.plan?.status ?? "none" };
      }),
    ),

    coven_record_decision: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { control, leaderThreadId } = yield* leaderScope;
        yield* control
          .recordDecision(leaderThreadId, input.title, input.body)
          .pipe(Effect.mapError(toMcpFailure));
        return { recorded: true };
      }),
    ),

    coven_request_gate: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { control, leaderThreadId } = yield* leaderScope;
        const round = yield* control
          .requestGate({ leaderThreadId, gateId: input.gateId, detail: input.detail })
          .pipe(Effect.mapError(toMcpFailure));
        return gateRoundView(round);
      }),
    ),

    coven_gate_submit_vote: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { scope, control } = yield* services;
        const round = yield* control
          .submitVote({
            threadId: scope.thread.threadId,
            gateId: input.gateId,
            decision: input.decision,
            rationale: input.rationale,
          })
          .pipe(Effect.mapError(toMcpFailure));
        return gateRoundView(round);
      }),
    ),

    coven_complete_run: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { control, leaderThreadId } = yield* leaderScope;
        const result = yield* control
          .completeRun({
            leaderThreadId,
            summary: input.summary,
            context: {
              codeChanged: input.codeChanged,
              changedPaths: input.changedPaths ?? [],
              tags: input.tags ?? [],
            },
          })
          .pipe(Effect.mapError(toMcpFailure));
        return result.completed
          ? { completed: true, reason: null, requiredGates: [] }
          : { completed: false, reason: result.reason, requiredGates: result.requiredGates };
      }),
    ),

    coven_report_to_leader: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { scope, control } = yield* services;
        yield* control
          .reportToLeader(scope.thread.threadId, input.message)
          .pipe(Effect.mapError(toMcpFailure));
        return { delivered: true };
      }),
    ),

    coven_builder_read_draft: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const { scope, draft } = yield* builderDraft;
        const parsed = parseCovenSource(draft.source);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service
          .capabilities(scope)
          .pipe(Effect.orElseSucceed(() => ({ providers: [] as const })));
        return {
          source: draft.source,
          version: draft.version,
          issues: parsed.ok ? [] : parsed.issues,
          providers: capabilities.providers.map((provider) => ({
            providerInstanceId: provider.providerInstanceId,
            models: provider.models.map((model) => model.id),
          })),
        };
      }),
    ),

    coven_builder_propose_patch: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { covens, draft } = yield* builderDraft;
        const parsed = parseCovenSource(input.source);
        if (!parsed.ok) {
          return { accepted: false, version: draft.version, issues: parsed.issues };
        }
        if (input.expectedVersion !== draft.version) {
          return {
            accepted: false,
            version: draft.version,
            issues: [
              {
                path: "draft",
                message: `The user changed the draft (now version ${draft.version}). Merge your change into the current file and try again.`,
              },
            ],
            currentSource: draft.source,
          };
        }
        const updated = yield* covens
          .updateDraft({
            draftId: draft.id,
            source: input.source,
            expectedVersion: input.expectedVersion,
            by: "builder",
            summary: input.summary,
          })
          .pipe(Effect.mapError(toMcpFailure));
        return { accepted: true, version: updated.version, issues: [] };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof CovenToolkit.tools>;
};

export const layer = McpToolAccess.toLayer(
  CovenToolkit,
  Effect.gen(function* () {
    const covens = yield* Effect.serviceOption(CovenService.CovenService);
    const control = yield* Effect.serviceOption(CovenControlService.CovenControlService);
    const random = yield* SecureRandom.SecureRandom;
    return makeHandlers(covens, control, random);
  }),
);
