import {
  CommandId,
  CovenError,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ModelSelection,
  type CovenCandidate,
  type CovenDetail,
  type CovenDraft,
  type CovenGateRound,
  type CovenGateVote,
  type CovenStartBuilderInput,
  type CovenStartBuilderResult,
  type OrchestrationV2DomainEvent,
  type ThreadCovenState,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applicableCovenGates,
  classifyCovenFailure,
  COVEN_DEFAULT_COOLDOWN_MS,
  covenGateElectorate,
  evaluateCovenGate,
  pickCovenCandidate,
  type CovenGateContext,
} from "@t3tools/shared/covenRuntime";
import {
  parseCovenSource,
  slugifyCovenName,
  starterCovenSource,
} from "@t3tools/shared/covenDefinition";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { covenBuilderBrief } from "./covenBuilderPrompt.ts";
import {
  COVEN_RUN_MEMORY_FILE,
  covenRunMemoryTemplate,
  renderCovenRunDocs,
} from "./covenRunDocs.ts";
import {
  ACTIVE_TASK_STATUSES,
  isRunActive,
  leaderRole,
  openGateRound,
  passedGate,
  replaceLatestAttempt,
  replaceTask,
  toRunView,
  type CovenRunRecord,
  type CovenRunState,
  type CovenTaskState,
} from "./covenRunState.ts";
import * as CovenService from "./CovenService.ts";

export interface CovenGateRequest {
  readonly leaderThreadId: ThreadId;
  readonly gateId: string;
  readonly detail: string;
}

export interface CovenVoteInput {
  readonly threadId: ThreadId;
  readonly gateId: string;
  readonly decision: CovenGateVote["decision"];
  readonly rationale: string;
}

export interface CovenCompletion {
  readonly leaderThreadId: ThreadId;
  readonly summary: string;
  readonly context: CovenGateContext;
}

export type CovenCompletionResult =
  | { readonly completed: true }
  | {
      readonly completed: false;
      readonly reason: string;
      readonly requiredGates: ReadonlyArray<string>;
    };

const isCovenError = Schema.is(CovenError);

export class CovenControlService extends Context.Service<
  CovenControlService,
  {
    readonly setThread: (
      threadId: ThreadId,
      covenId: string,
    ) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly clearThread: (threadId: ThreadId) => Effect.Effect<ThreadCovenState, CovenError>;
    /** Deletes (archives) a coven and takes it off every thread it's attached to. */
    readonly archive: (covenId: string) => Effect.Effect<{ readonly covenId: string }, CovenError>;
    readonly controlRun: (
      threadId: ThreadId,
      action: "pause" | "resume" | "stop",
    ) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly decide: (input: {
      readonly threadId: ThreadId;
      readonly approvalId: string;
      readonly approve: boolean;
      readonly note?: string | undefined;
    }) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly proposePlan: (
      leaderThreadId: ThreadId,
      plan: string,
    ) => Effect.Effect<CovenRunState, CovenError>;
    readonly recordDecision: (
      leaderThreadId: ThreadId,
      title: string,
      body: string,
    ) => Effect.Effect<void, CovenError>;
    readonly requestGate: (input: CovenGateRequest) => Effect.Effect<CovenGateRound, CovenError>;
    readonly submitVote: (input: CovenVoteInput) => Effect.Effect<CovenGateRound, CovenError>;
    readonly completeRun: (
      input: CovenCompletion,
    ) => Effect.Effect<CovenCompletionResult, CovenError>;
    readonly reportToLeader: (
      workerThreadId: ThreadId,
      message: string,
    ) => Effect.Effect<void, CovenError>;
    readonly memoryExcerpt: (run: CovenRunRecord) => Effect.Effect<string>;
    readonly startBuilder: (
      input: CovenStartBuilderInput,
    ) => Effect.Effect<CovenStartBuilderResult, CovenError>;
    readonly saveDraft: (draftId: string) => Effect.Effect<CovenDetail, CovenError>;
  }
>()("t3/coven/CovenControlService") {}

const policyDenied = (message: string) => new CovenError({ reason: "policy-denied", message });
const notFound = (message: string) => new CovenError({ reason: "not-found", message });
const asCovenError = (message: string) => (cause: unknown) =>
  new CovenError({
    reason: "policy-denied",
    message: `${message} ${cause instanceof Error ? cause.message : ""}`.trim(),
  });

const MEMORY_EXCERPT_CHARS = 4000;
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

const candidateSelection = (candidate: CovenCandidate) =>
  decodeModelSelection({
    instanceId: candidate.providerInstanceId,
    model: candidate.modelId,
    ...(candidate.options === undefined ? {} : { options: candidate.options }),
  }).pipe(Effect.mapError(asCovenError("The model candidate is not usable.")));

const describeCandidate = (candidate: {
  readonly providerInstanceId: string;
  readonly modelId: string;
}) => `${candidate.providerInstanceId} / ${candidate.modelId}`;

const make = Effect.gen(function* () {
  const covens = yield* CovenService.CovenService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = random.uuidV4();
  const handledRuns = yield* Ref.make(new Set<string>());

  const withWorkspace = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ThreadManagementService.ThreadManagementService | ProjectService.ProjectService
    >,
  ) =>
    effect.pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ProjectService.ProjectService, projects),
    );

  // ── Talking to threads ───────────────────────────────────────────────

  /** Sends a turn to a thread as the coven; optionally switches its model first. */
  const sendAsCoven = Effect.fn("sendAsCoven")(
    function* (
      threadId: ThreadId,
      text: string,
      options: { readonly modelSelection?: ModelSelection; readonly mode?: "auto" | "queue" } = {},
    ) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return yield* notFound(`Thread ${threadId} no longer exists.`);
      yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`coven:${yield* uuid}`),
        threadId,
        messageId: MessageId.make(`coven:${yield* uuid}`),
        text,
        attachments: [],
        mode: options.mode ?? "queue",
        ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
        createdBy: "agent",
        creationSource: "server",
      });
    },
    Effect.mapError((cause) =>
      isCovenError(cause) ? cause : asCovenError("Could not message the thread.")(cause),
    ),
  );

  const notifyLeader = (run: CovenRunRecord, text: string) =>
    sendAsCoven(run.leaderThreadId, `[Coven] ${text}`).pipe(
      Effect.catchCause((cause) => Effect.logWarning("coven: could not notify the leader", cause)),
    );

  const interrupt = Effect.fn("interrupt")(
    function* (threadId: ThreadId, reason: string) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return;
      yield* threads.interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`coven:${yield* uuid}`),
        threadId,
        reason,
      });
    },
    Effect.catchCause((cause) => Effect.logDebug("coven: interrupt skipped", cause)),
  );

  const switchThreadModel = Effect.fn("switchThreadModel")(
    function* (threadId: ThreadId, candidate: CovenCandidate) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return;
      const selection = yield* candidateSelection(candidate);
      if (
        shell.providerInstanceId === selection.instanceId &&
        shell.modelSelection.model === selection.model
      ) {
        return;
      }
      yield* threads.dispatch({
        type: modelSelectionCommandType(shell.providerInstanceId, selection),
        threadId,
        commandId: CommandId.make(`coven:${yield* uuid}`),
        modelSelection: selection,
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("coven: could not switch the model", cause)),
  );

  const requireLeader = Effect.fn("requireLeader")(function* (threadId: ThreadId) {
    const scope = yield* covens.threadScope(threadId);
    if (scope === null || scope.kind !== "leader") {
      return yield* policyDenied("This thread doesn't lead a coven.");
    }
    const run = scope.run ?? (yield* covens.ensureRun(threadId));
    if (run === null) return yield* policyDenied("This thread's coven has no run in progress.");
    const definition = yield* covens.definitionAt(run.covenId, run.revision);
    if (definition === null) return yield* notFound("The coven revision for this run is missing.");
    return { run, definition };
  });

  const event = (kind: string, summary: string) => ({ kind, summary });

  // ── Binding ──────────────────────────────────────────────────────────

  const setThread: CovenControlService["Service"]["setThread"] = Effect.fn("setThread")(
    function* (threadId, covenId) {
      yield* endRunForSwitch(threadId, covenId);
      const state = yield* covens.setThread(threadId, covenId);
      if (state.binding === null) return state;
      const definition = yield* covens.definitionAt(state.binding.covenId, state.binding.revision);
      if (definition === null) return state;
      const now = Date.parse(yield* nowIso);
      const candidates = leaderRole(definition).candidates;
      const index = pickCovenCandidate(candidates, 0, yield* covens.cooldowns, now) ?? 0;
      yield* switchThreadModel(threadId, candidates[index]!);
      return state;
    },
  );

  /** Switching covens (or turning the coven off) is the only thing that ends a coven's run. */
  const endRunForSwitch = Effect.fn("endRunForSwitch")(function* (
    threadId: ThreadId,
    nextCovenId: string | null,
  ) {
    const scope = yield* covens.threadScope(threadId);
    if (scope === null || scope.kind !== "leader" || scope.run === null) return;
    if (!isRunActive(scope.run.state.status) || scope.run.covenId === nextCovenId) return;
    yield* haltRun(scope.run, {
      end: true,
      reason: nextCovenId === null ? "You turned the coven off." : "You switched covens.",
      eventKind: "run.ended",
      eventSummary:
        nextCovenId === null
          ? `You turned off ${scope.binding.name}.`
          : `You switched away from ${scope.binding.name}.`,
    });
  });

  const clearThread: CovenControlService["Service"]["clearThread"] = Effect.fn("clearThread")(
    function* (threadId) {
      yield* endRunForSwitch(threadId, null);
      return yield* covens.clearThread(threadId);
    },
  );

  const archive: CovenControlService["Service"]["archive"] = Effect.fn("archive")(
    function* (covenId) {
      for (const threadId of yield* covens.boundThreads(covenId)) {
        yield* clearThread(threadId);
      }
      return yield* covens.archive(covenId);
    },
  );

  // ── Pause, resume, stop ──────────────────────────────────────────────

  const activeRunFor = Effect.fn("activeRunFor")(function* (threadId: ThreadId) {
    const scope = yield* covens.threadScope(threadId);
    if (
      scope === null ||
      scope.kind !== "leader" ||
      scope.run === null ||
      !isRunActive(scope.run.state.status)
    ) {
      return yield* policyDenied("This thread has no coven run in progress.");
    }
    return scope.run;
  });

  /**
   * Cancels in-flight work. A coven stays with its thread, so this only ends the run
   * itself (`end: true`) when the user switches covens or turns the coven off.
   */
  const haltRun = Effect.fn("haltRun")(function* (
    run: CovenRunRecord,
    options: {
      readonly end: boolean;
      readonly reason: string;
      readonly eventKind: string;
      readonly eventSummary: string;
    },
  ) {
    const now = yield* nowIso;
    const stopped = yield* covens.updateRun(run.id, (record) =>
      Effect.sync(() => ({
        state: {
          ...record.state,
          status: options.end
            ? ("cancelled" as const)
            : record.state.status === "awaiting_plan"
              ? ("awaiting_plan" as const)
              : ("running" as const),
          statusReason: options.end ? options.reason : null,
          resumeStatus: null,
          pendingApprovals: record.state.pendingApprovals.filter(
            (approval) => !options.end && approval.kind === "plan",
          ),
          gates: record.state.gates.map((round) =>
            round.status === "open"
              ? { ...round, status: "failed" as const, closedAt: now }
              : round,
          ),
          tasks: record.state.tasks.map((task) =>
            ACTIVE_TASK_STATUSES.has(task.status)
              ? {
                  ...replaceLatestAttempt(task, (attempt) =>
                    attempt.status === "running"
                      ? { ...attempt, status: "cancelled" as const, endedAt: now }
                      : attempt,
                  ),
                  status: "cancelled" as const,
                  updatedAt: now,
                }
              : task,
          ),
        },
        events: [event(options.eventKind, options.eventSummary)],
        result: record.state.tasks.filter((task) => task.status === "running"),
      })),
    );
    yield* interrupt(run.leaderThreadId, options.reason);
    for (const task of stopped) {
      if (task.childThreadId) yield* interrupt(task.childThreadId, options.reason);
    }
    yield* threads
      .stopDelegatedTasks({
        threadId: run.leaderThreadId,
        commandId: CommandId.make(`coven:${yield* uuid}`),
        reason: options.reason,
      })
      .pipe(Effect.catchCause((cause) => Effect.logDebug("coven: stopDelegatedTasks", cause)));
  });

  const controlRun: CovenControlService["Service"]["controlRun"] = Effect.fn("controlRun")(
    function* (threadId, action) {
      const run = yield* activeRunFor(threadId);
      const now = yield* nowIso;
      if (action === "pause") {
        const paused = yield* covens.updateRun(run.id, (record) =>
          Effect.sync(() => {
            if (record.state.status === "paused") {
              return { state: record.state, result: [] as ReadonlyArray<CovenTaskState> };
            }
            const running = record.state.tasks.filter((task) => task.status === "running");
            let state: CovenRunState = {
              ...record.state,
              status: "paused",
              statusReason: "Paused by you.",
              resumeStatus: record.state.status,
            };
            for (const task of running) {
              state = replaceTask(state, task.id, (current) => ({
                ...replaceLatestAttempt(current, (attempt) => ({
                  ...attempt,
                  status: "cancelled",
                  endedAt: now,
                })),
                status: "blocked",
                updatedAt: now,
              }));
            }
            return { state, events: [event("run.paused", "You paused the run.")], result: running };
          }),
        );
        yield* interrupt(run.leaderThreadId, "Coven run paused");
        for (const task of paused) {
          if (task.childThreadId) yield* interrupt(task.childThreadId, "Coven run paused");
        }
      } else if (action === "resume") {
        const definition = yield* covens.definitionAt(run.covenId, run.revision);
        if (definition === null)
          return yield* notFound("The coven revision for this run is missing.");
        const cooldowns = yield* covens.cooldowns;
        const nowMs = Date.parse(now);
        const resumed = yield* covens.updateRun(run.id, (record) =>
          Effect.gen(function* () {
            if (record.state.status !== "paused") {
              return yield* policyDenied("The run isn't paused.");
            }
            let state: CovenRunState = {
              ...record.state,
              status: record.state.resumeStatus ?? "running",
              statusReason: null,
              resumeStatus: null,
            };
            const restarts: Array<{ task: CovenTaskState; candidate: CovenCandidate }> = [];
            for (const task of record.state.tasks.filter(
              (candidate) => candidate.status === "blocked",
            )) {
              const role = definition.frontMatter.roles.find(
                (candidate) => candidate.id === task.roleId,
              );
              if (!role || !task.childThreadId) continue;
              const index = pickCovenCandidate(role.candidates, 0, cooldowns, nowMs);
              if (index === null) {
                return yield* policyDenied(
                  `Every model for ${role.name} is still out of quota. Clear a cooldown or wait.`,
                );
              }
              const candidate = role.candidates[index]!;
              const next: CovenTaskState = {
                ...task,
                status: "running",
                candidateIndex: index,
                updatedAt: now,
                attempts: [
                  ...task.attempts,
                  {
                    id: yield* uuid,
                    attempt: task.attempts.length + 1,
                    candidateIndex: index,
                    providerInstanceId: candidate.providerInstanceId,
                    modelId: candidate.modelId,
                    childThreadId: task.childThreadId,
                    status: "running",
                    failureClass: null,
                    failureMessage: null,
                    startedAt: now,
                    endedAt: null,
                  },
                ],
              };
              state = replaceTask(state, task.id, () => next);
              restarts.push({ task: next, candidate });
            }
            return {
              state,
              events: [event("run.resumed", "You resumed the run.")],
              result: restarts,
            };
          }),
        );
        for (const { task, candidate } of resumed) {
          const selection = yield* candidateSelection(candidate);
          yield* sendAsCoven(
            task.childThreadId!,
            "[Coven] The run was resumed. Continue your task from where you stopped.",
            { modelSelection: selection },
          ).pipe(
            Effect.catchCause((cause) => Effect.logWarning("coven: resume send failed", cause)),
          );
        }
        yield* notifyLeader(
          run,
          `The user resumed the run.${resumed.length > 0 ? ` ${resumed.length} task(s) continue.` : ""} Carry on with the plan.`,
        );
      } else {
        yield* haltRun(run, {
          end: false,
          reason: "Stopped by you.",
          eventKind: "work.stopped",
          eventSummary: "You stopped the current work. The coven is still here.",
        });
      }
      return yield* covens.threadState(threadId);
    },
  );

  // ── Plans, decisions, approvals ──────────────────────────────────────

  const proposePlan: CovenControlService["Service"]["proposePlan"] = Effect.fn("proposePlan")(
    function* (leaderThreadId, plan) {
      const { run, definition } = yield* requireLeader(leaderThreadId);
      const now = yield* nowIso;
      const needsApproval = definition.frontMatter.autonomy.initialPlanApproval;
      const approvalId = `plan-${yield* uuid}`;
      return yield* covens.updateRun(run.id, (record) =>
        Effect.gen(function* () {
          if (record.state.status !== "awaiting_plan" && record.state.status !== "running") {
            return yield* policyDenied(
              `The run is ${record.state.status}; a plan can't be proposed now.`,
            );
          }
          const approved = !needsApproval || record.state.plan?.status === "approved";
          const state: CovenRunState = {
            ...record.state,
            plan: {
              text: plan,
              status: approved ? "approved" : "proposed",
              proposedAt: now,
              decidedAt: approved ? now : null,
            },
            status: approved
              ? record.state.status === "awaiting_plan"
                ? "running"
                : record.state.status
              : "awaiting_plan",
            statusReason: approved ? null : "Waiting for you to approve the plan.",
            pendingApprovals: approved
              ? record.state.pendingApprovals.filter((approval) => approval.kind !== "plan")
              : [
                  ...record.state.pendingApprovals.filter((approval) => approval.kind !== "plan"),
                  {
                    id: approvalId,
                    kind: "plan",
                    title: "Approve the plan",
                    body: plan,
                    createdAt: now,
                  },
                ],
          };
          return {
            state,
            events: [
              event(
                "plan.proposed",
                approved
                  ? "The leader updated the plan."
                  : "The leader proposed a plan for approval.",
              ),
            ],
            result: state,
          };
        }),
      );
    },
  );

  const recordDecision: CovenControlService["Service"]["recordDecision"] = Effect.fn(
    "recordDecision",
  )(function* (leaderThreadId, title, body) {
    const { run } = yield* requireLeader(leaderThreadId);
    yield* covens.updateRun(run.id, (record) =>
      Effect.succeed({
        state: record.state,
        events: [event("decision", `${title}: ${body}`.slice(0, 2000))],
        result: undefined,
      }),
    );
  });

  const closeRound = (
    state: CovenRunState,
    roundId: string,
    status: CovenGateRound["status"],
    detail: string,
    now: string,
  ): CovenRunState => {
    const gates = state.gates.map((round) =>
      round.id === roundId
        ? { ...round, status, detail: detail || round.detail, closedAt: now }
        : round,
    );
    const stillOpen = gates.some((round) => round.status === "open");
    return {
      ...state,
      gates,
      pendingApprovals: state.pendingApprovals.filter((approval) => approval.id !== roundId),
      status: state.status === "awaiting_gate" && !stillOpen ? "running" : state.status,
      statusReason: state.status === "awaiting_gate" && !stillOpen ? null : state.statusReason,
    };
  };

  const decide: CovenControlService["Service"]["decide"] = Effect.fn("decide")(function* (input) {
    const run = yield* activeRunFor(input.threadId);
    const now = yield* nowIso;
    const note = input.note?.trim() ? ` Note from the user: ${input.note.trim()}` : "";
    const message = yield* covens.updateRun(run.id, (record) =>
      Effect.gen(function* () {
        const approval = record.state.pendingApprovals.find(
          (candidate) => candidate.id === input.approvalId,
        );
        if (approval === undefined) return yield* notFound("That approval is no longer pending.");
        if (approval.kind === "plan") {
          const state: CovenRunState = {
            ...record.state,
            pendingApprovals: record.state.pendingApprovals.filter(
              (candidate) => candidate.id !== approval.id,
            ),
            plan: record.state.plan
              ? {
                  ...record.state.plan,
                  status: input.approve ? "approved" : "rejected",
                  decidedAt: now,
                }
              : null,
            status:
              input.approve && record.state.status === "awaiting_plan"
                ? "running"
                : record.state.status,
            statusReason: input.approve ? null : "The plan was rejected; the leader revises it.",
          };
          return {
            state,
            events: [
              event(
                input.approve ? "approval.plan-approved" : "approval.plan-rejected",
                input.approve ? `You approved the plan.${note}` : `You rejected the plan.${note}`,
              ),
            ],
            result: input.approve
              ? `The user approved your plan. Start delegating.${note}`
              : `The user rejected your plan. Revise it and call coven_propose_plan again.${note}`,
          };
        }
        const round = record.state.gates.find((candidate) => candidate.id === approval.id);
        const state = closeRound(
          record.state,
          approval.id,
          input.approve ? "passed" : "failed",
          input.approve ? `Approved by you.${note}` : `Rejected by you.${note}`,
          now,
        );
        return {
          state,
          events: [
            event(
              input.approve ? "approval.gate-approved" : "approval.gate-rejected",
              `You ${input.approve ? "approved" : "rejected"} ${round?.gateId ?? "a gate"}.${note}`,
            ),
          ],
          result: `The user ${input.approve ? "approved" : "rejected"} gate ${round?.gateId ?? approval.title}.${note}`,
        };
      }),
    );
    yield* notifyLeader(run, message);
    return yield* covens.threadState(input.threadId);
  });

  // ── Gates ────────────────────────────────────────────────────────────

  const requestGate: CovenControlService["Service"]["requestGate"] = Effect.fn("requestGate")(
    function* (input) {
      const { run, definition } = yield* requireLeader(input.leaderThreadId);
      const gate = definition.frontMatter.governance.gates.find(
        (candidate) => candidate.id === input.gateId,
      );
      if (gate === undefined) {
        return yield* notFound(
          `This coven has no gate ${input.gateId}. Gates: ${definition.frontMatter.governance.gates.map((candidate) => candidate.id).join(", ") || "none"}.`,
        );
      }
      const now = yield* nowIso;
      const roundId = `gate-${yield* uuid}`;
      const maxRounds = gate.maxRounds ?? definition.frontMatter.limits.maxReviewFixRounds;
      return yield* covens.updateRun(run.id, (record) =>
        Effect.gen(function* () {
          const open = openGateRound(record.state, gate.id);
          if (open) return { state: record.state, result: open };
          if (!isRunActive(record.state.status) || record.state.status === "paused") {
            return yield* policyDenied(`The run is ${record.state.status}.`);
          }
          const previous = record.state.gates.filter((round) => round.gateId === gate.id).length;
          const exhausted = previous >= maxRounds;
          const electorate = covenGateElectorate(gate);
          const human = gate.type === "human-approval" || exhausted;
          const round: CovenGateRound = {
            id: roundId,
            gateId: gate.id,
            gateType: gate.type,
            round: previous + 1,
            status:
              exhausted && gate.onUnavailable === "block"
                ? "failed"
                : exhausted
                  ? "escalated"
                  : "open",
            detail: exhausted
              ? `This gate already ran ${previous} times (limit ${maxRounds}). ${gate.onUnavailable === "block" ? "The run is blocked." : "You decide."}`
              : input.detail,
            votes: [],
            openedAt: now,
            closedAt: null,
          };
          const blocked = exhausted && gate.onUnavailable === "block";
          const state: CovenRunState = {
            ...record.state,
            gates: [...record.state.gates, round],
            status: blocked ? "paused" : "awaiting_gate",
            statusReason: blocked
              ? `Gate ${gate.id} ran out of rounds.`
              : human
                ? `Waiting for you to decide ${gate.id}.`
                : `Waiting on ${gate.id}${electorate.length > 0 ? ` from ${electorate.join(", ")}` : ""}.`,
            resumeStatus: blocked ? "running" : record.state.resumeStatus,
            pendingApprovals:
              human && !blocked
                ? [
                    ...record.state.pendingApprovals,
                    {
                      id: roundId,
                      kind: "gate",
                      title:
                        gate.type === "human-approval"
                          ? (gate.question ?? `Approve ${gate.id}?`)
                          : `Decide ${gate.id}`,
                      body: round.detail,
                      createdAt: now,
                    },
                  ]
                : record.state.pendingApprovals,
          };
          // A round that escalated stays open for the user's decision.
          const stored =
            round.status === "escalated" ? { ...round, status: "open" as const } : round;
          return {
            state: { ...state, gates: [...record.state.gates, stored] },
            events: [
              event(
                "gate.requested",
                `Gate ${gate.id} round ${round.round} ${human ? "is waiting for you" : "opened"}.`,
              ),
            ],
            result: stored,
          };
        }),
      );
    },
  );

  const submitVote: CovenControlService["Service"]["submitVote"] = Effect.fn("submitVote")(
    function* (input) {
      const scope = yield* covens.threadScope(input.threadId);
      if (scope === null) return yield* policyDenied("This thread isn't part of a coven.");
      const run = scope.run;
      if (run === null) return yield* policyDenied("There is no coven run in progress.");
      const definition = yield* covens.definitionAt(run.covenId, run.revision);
      if (definition === null)
        return yield* notFound("The coven revision for this run is missing.");
      const gate = definition.frontMatter.governance.gates.find(
        (candidate) => candidate.id === input.gateId,
      );
      if (gate === undefined) return yield* notFound(`This coven has no gate ${input.gateId}.`);
      const roleId = scope.kind === "leader" ? leaderRole(definition).id : scope.roleId;
      const evidenceGate = gate.type === "test" || gate.type === "artifact";
      if (!evidenceGate && !covenGateElectorate(gate).includes(roleId)) {
        return yield* policyDenied(
          `${roleId} doesn't vote on ${gate.id}. Voters: ${covenGateElectorate(gate).join(", ")}.`,
        );
      }
      if (gate.type === "human-approval")
        return yield* policyDenied("Only the user decides this gate.");
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const now = yield* nowIso;
      const outcome = yield* covens.updateRun(run.id, (record) =>
        Effect.gen(function* () {
          const round = openGateRound(record.state, gate.id);
          if (round === undefined) {
            return yield* policyDenied(
              `Gate ${gate.id} isn't open. The leader opens it with coven_request_gate.`,
            );
          }
          const vote: CovenGateVote = {
            roleId,
            decision: input.decision,
            rationale: input.rationale,
            providerInstanceId: shell?.providerInstanceId ?? null,
            modelId: shell?.modelSelection.model ?? null,
            createdAt: now,
          };
          const votes = [...round.votes, vote];
          const result = evidenceGate
            ? input.decision === "approve"
              ? ({ kind: "passed", detail: input.rationale } as const)
              : ({ kind: "failed", detail: input.rationale } as const)
            : evaluateCovenGate(gate, votes);
          let state: CovenRunState = {
            ...record.state,
            gates: record.state.gates.map((candidate) =>
              candidate.id === round.id ? { ...candidate, votes } : candidate,
            ),
          };
          let closed: CovenGateRound["status"] | null = null;
          if (result.kind === "passed" || result.kind === "failed") {
            closed = result.kind;
            state = closeRound(state, round.id, result.kind, result.detail, now);
          } else if (result.kind === "tie") {
            closed = "escalated";
            state = {
              ...state,
              gates: state.gates.map((candidate) =>
                candidate.id === round.id ? { ...candidate, detail: result.detail } : candidate,
              ),
              statusReason: `Gate ${gate.id} tied; waiting for you.`,
              pendingApprovals: [
                ...state.pendingApprovals,
                {
                  id: round.id,
                  kind: "gate",
                  title: `Break the tie on ${gate.id}`,
                  body: result.detail,
                  createdAt: now,
                },
              ],
            };
          }
          const updated = state.gates.find((candidate) => candidate.id === round.id)!;
          return {
            state,
            events: [
              event("gate.vote", `${roleId} voted ${input.decision} on ${gate.id}.`),
              ...(closed
                ? [
                    event(
                      `gate.${closed}`,
                      `Gate ${gate.id} round ${round.round} ${closed}. ${"detail" in result ? result.detail : ""}`,
                    ),
                  ]
                : []),
            ],
            result: { round: updated, closed },
          };
        }),
      );
      if (outcome.closed !== null) {
        yield* notifyLeader(
          run,
          outcome.closed === "passed"
            ? `Gate ${gate.id} passed. ${outcome.round.detail}`
            : outcome.closed === "failed"
              ? `Gate ${gate.id} failed: ${outcome.round.detail} Address it, then request the gate again.`
              : `Gate ${gate.id} tied; the user breaks the tie.`,
        );
      }
      return outcome.round;
    },
  );

  const completeRun: CovenControlService["Service"]["completeRun"] = Effect.fn("completeRun")(
    function* (input) {
      const { run, definition } = yield* requireLeader(input.leaderThreadId);
      const now = yield* nowIso;
      const result = yield* covens.updateRun(run.id, (record) =>
        Effect.sync(() => {
          const active = record.state.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
          if (active.length > 0) {
            return {
              state: record.state,
              result: {
                completed: false,
                reason: `${active.length} task(s) are still open: ${active.map((task) => task.title).join(", ")}.`,
                requiredGates: [],
              } as CovenCompletionResult,
            };
          }
          const gates = definition.frontMatter.governance.gates;
          const required = [
            ...applicableCovenGates(gates, "before-completion", input.context),
            ...applicableCovenGates(gates, "before-merge", input.context),
          ].filter((gate) => !passedGate(record.state, gate.id));
          if (required.length > 0) {
            return {
              state: record.state,
              result: {
                completed: false,
                reason: "These gates must pass first. Request each with coven_request_gate.",
                requiredGates: required.map((gate) => gate.id),
              } as CovenCompletionResult,
            };
          }
          // A coven stays with its thread: finishing a piece of work starts a fresh
          // budget and gate cycle, and the next request continues with the same team.
          return {
            state: {
              ...record.state,
              status: "running" as const,
              statusReason: null,
              summary: input.summary,
              pendingApprovals: [],
              delegations: 0,
              cycleStartedAt: now,
              gates: [],
              completedGates: [...(record.state.completedGates ?? []), ...record.state.gates].slice(
                -20,
              ),
            },
            events: [event("work.completed", `Finished: ${input.summary}`)],
            result: { completed: true } as CovenCompletionResult,
          };
        }),
      );
      return result;
    },
  );

  const reportToLeader: CovenControlService["Service"]["reportToLeader"] = Effect.fn(
    "reportToLeader",
  )(function* (workerThreadId, message) {
    const scope = yield* covens.threadScope(workerThreadId);
    if (scope === null || scope.kind !== "worker")
      return yield* policyDenied("Only a coven worker can report to its leader.");
    yield* covens.updateRun(scope.run.id, (record) =>
      Effect.succeed({
        state: record.state,
        events: [event("task.report", `${scope.roleId}: ${message}`.slice(0, 2000))],
        result: undefined,
      }),
    );
    yield* sendAsCoven(
      scope.leaderThreadId,
      `[Coven] ${scope.roleId} reports (thread ${workerThreadId}):\n\n${message}`,
    );
  });

  // ── Docs folder ──────────────────────────────────────────────────────

  const runDocsDirectory = Effect.fn("runDocsDirectory")(function* (run: CovenRunRecord) {
    const root = yield* withWorkspace(threadWorkspaceRoot(run.leaderThreadId));
    return root
      ? path.join(root, "docs", "coven-runs", run.id)
      : path.join(config.stateDir, "coven-scratch", run.id);
  });

  const memoryExcerpt: CovenControlService["Service"]["memoryExcerpt"] = Effect.fn("memoryExcerpt")(
    function* (run) {
      const directory = yield* runDocsDirectory(run);
      const text = yield* fs.readFileString(path.join(directory, COVEN_RUN_MEMORY_FILE));
      return text.length > MEMORY_EXCERPT_CHARS
        ? `${text.slice(0, MEMORY_EXCERPT_CHARS)}\n…`
        : text;
    },
    Effect.orElseSucceed(() => ""),
  );

  const writeAtomically = Effect.fn("writeAtomically")(function* (file: string, content: string) {
    const temp = `${file}.${yield* uuid}.tmp`;
    yield* fs.writeFileString(temp, content);
    yield* fs.rename(temp, file);
  });

  const projectDocs = Effect.fn("projectDocs")(
    function* (runId: string) {
      const run = yield* covens.getRun(runId);
      if (run === null) return;
      const definition = yield* covens.definitionAt(run.covenId, run.revision);
      if (definition === null) return;
      const events = yield* covens.runEvents(run.id, 500);
      const view = toRunView(run, events);
      const directory = yield* runDocsDirectory(run);
      yield* fs.makeDirectory(directory, { recursive: true });
      const files = renderCovenRunDocs(view, definition, events);
      for (const [name, content] of Object.entries(files)) {
        yield* writeAtomically(path.join(directory, name), content);
      }
      const memory = path.join(directory, COVEN_RUN_MEMORY_FILE);
      if (!(yield* fs.exists(memory))) {
        yield* writeAtomically(memory, covenRunMemoryTemplate(view, definition));
      }
      if (run.state.docsPath !== directory) {
        yield* covens.updateRun(run.id, (record) =>
          Effect.succeed({ state: { ...record.state, docsPath: directory }, result: undefined }),
        );
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("coven: could not write the run docs", cause)),
  );

  // ── Failover engine ──────────────────────────────────────────────────

  const markOnce = (key: string) =>
    Ref.modify(handledRuns, (seen) => {
      if (seen.has(key)) return [false, seen] as const;
      const next = new Set(seen);
      next.add(key);
      if (next.size > 2000) next.delete(next.values().next().value!);
      return [true, next] as const;
    });

  type ChildOutcome = "completed" | "failed" | "cancelled";

  const handleChildOutcome = Effect.fn("handleChildOutcome")(function* (
    childThreadId: ThreadId,
    outcome: ChildOutcome,
    source: "delegation" | "resume",
    requestedAtMs: number | null,
  ) {
    const link = yield* covens.childLink(childThreadId);
    if (link === null) return;
    const run = yield* covens.getRun(link.runId);
    if (run === null || !isRunActive(run.state.status)) return;
    const task = run.state.tasks.find((candidate) => candidate.id === link.taskId);
    if (task === undefined || task.status !== "running") return;
    const attempt = task.attempts.at(-1);
    if (attempt === undefined) return;
    const resumed = task.attempts.length > 1 || task.transientRetries > 0;
    if (source === "delegation" && resumed) return;
    if (
      source === "resume" &&
      (!resumed || (requestedAtMs !== null && requestedAtMs < Date.parse(attempt.startedAt)))
    )
      return;
    const definition = yield* covens.definitionAt(run.covenId, run.revision);
    if (definition === null) return;
    const role = definition.frontMatter.roles.find((candidate) => candidate.id === task.roleId);
    if (role === undefined) return;
    const now = yield* nowIso;
    const nowMs = Date.parse(now);

    const finish = (
      status: "completed" | "failed" | "cancelled",
      message: string | null,
      failureClass: string | null,
    ) =>
      covens.updateRun(run.id, (record) =>
        Effect.succeed({
          state: replaceTask(record.state, task.id, (current) => ({
            ...replaceLatestAttempt(current, (latest) => ({
              ...latest,
              status:
                status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
              failureClass,
              failureMessage: message,
              endedAt: now,
            })),
            status,
            updatedAt: now,
          })),
          events: [
            event(
              `task.${status}`,
              `${role.name}: ${task.title} ${status}${message ? ` (${message})` : ""}.`,
            ),
          ],
          result: undefined,
        }),
      );

    if (outcome === "completed") {
      yield* finish("completed", null, null);
      if (source === "resume") {
        yield* notifyLeader(
          run,
          `${role.name} finished "${task.title}" after a handoff. Read thread ${childThreadId} for the result.`,
        );
      }
      return;
    }
    if (outcome === "cancelled") {
      yield* finish("cancelled", null, null);
      return;
    }

    const shell = yield* threads
      .getThreadShell(childThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    const kind = classifyCovenFailure({
      lastErrorClass: shell?.lastErrorClass ?? null,
      lastErrorCode: shell?.lastErrorCode ?? null,
      usageLimitResetAt: shell?.usageLimitResetAt ?? null,
    });
    const failureMessage = shell?.lastError ?? "The task failed.";

    if (
      kind === "transient" &&
      task.transientRetries < definition.frontMatter.limits.maxTransientRetriesPerTask
    ) {
      yield* covens.updateRun(run.id, (record) =>
        Effect.sync(() => {
          return {
            state: replaceTask(record.state, task.id, (current) => {
              const failed = replaceLatestAttempt(current, (latest) => ({
                ...latest,
                status: "failed",
                failureClass: "transient",
                failureMessage,
                endedAt: now,
              }));
              return {
                ...failed,
                transientRetries: current.transientRetries + 1,
                updatedAt: now,
                attempts: [
                  ...failed.attempts,
                  {
                    ...attempt,
                    id: `${attempt.id}-r${current.transientRetries + 1}`,
                    attempt: failed.attempts.length + 1,
                    status: "running",
                    failureClass: null,
                    failureMessage: null,
                    startedAt: now,
                    endedAt: null,
                  },
                ],
              };
            }),
            events: [
              event(
                "task.retry",
                `${role.name}: retrying "${task.title}" after a temporary error.`,
              ),
            ],
            result: undefined,
          };
        }),
      );
      yield* sendAsCoven(
        childThreadId,
        "[Coven] The last attempt hit a temporary error. Continue your task.",
      );
      return;
    }

    if (kind !== "quota") {
      yield* finish("failed", failureMessage, kind);
      yield* notifyLeader(run, `${role.name}'s task "${task.title}" failed: ${failureMessage}`);
      return;
    }

    const failedCandidate = role.candidates[task.candidateIndex] ?? {
      providerInstanceId: attempt.providerInstanceId,
      modelId: attempt.modelId,
    };
    const resetAt =
      shell?.usageLimitResetAt ??
      DateTime.formatIso(DateTime.makeUnsafe(nowMs + COVEN_DEFAULT_COOLDOWN_MS));
    yield* covens.addCooldown({
      providerInstanceId: failedCandidate.providerInstanceId,
      modelId: failedCandidate.modelId,
      resetAt,
      reason: failureMessage,
      recordedAt: now,
    });
    const nextIndex = pickCovenCandidate(role.candidates, 0, yield* covens.cooldowns, nowMs);
    if (nextIndex === null) {
      yield* covens.updateRun(run.id, (record) =>
        Effect.succeed({
          state: {
            ...replaceTask(record.state, task.id, (current) => ({
              ...replaceLatestAttempt(current, (latest) => ({
                ...latest,
                status: "failed",
                failureClass: "quota",
                failureMessage,
                endedAt: now,
              })),
              status: "blocked",
              updatedAt: now,
            })),
            status: "paused" as const,
            resumeStatus: record.state.status,
            statusReason: `Every model for ${role.name} is out of quota (first reset ${resetAt}).`,
          },
          events: [event("run.paused", `Paused: every model for ${role.name} is out of quota.`)],
          result: undefined,
        }),
      );
      yield* notifyLeader(
        run,
        `Every model for ${role.name} is out of quota, so the run is paused until the user resumes it.`,
      );
      return;
    }
    const next = role.candidates[nextIndex]!;
    yield* covens.updateRun(run.id, (record) =>
      Effect.gen(function* () {
        const attemptId = yield* uuid;
        return {
          state: replaceTask(record.state, task.id, (current) => {
            const switched = replaceLatestAttempt(current, (latest) => ({
              ...latest,
              status: "switched",
              failureClass: "quota",
              failureMessage,
              endedAt: now,
            }));
            return {
              ...switched,
              candidateIndex: nextIndex,
              updatedAt: now,
              attempts: [
                ...switched.attempts,
                {
                  id: attemptId,
                  attempt: switched.attempts.length + 1,
                  candidateIndex: nextIndex,
                  providerInstanceId: next.providerInstanceId,
                  modelId: next.modelId,
                  childThreadId,
                  status: "running",
                  failureClass: null,
                  failureMessage: null,
                  startedAt: now,
                  endedAt: null,
                },
              ],
            };
          }),
          events: [
            event(
              "handoff.model",
              `${role.name}: ${describeCandidate(failedCandidate)} ran out of quota; continuing on ${describeCandidate(next)}.`,
            ),
          ],
          result: undefined,
        };
      }),
    );
    const selection = yield* candidateSelection(next);
    yield* sendAsCoven(
      childThreadId,
      [
        `[Coven] The previous model (${describeCandidate(failedCandidate)}) ran out of quota. You are now running on ${describeCandidate(next)}.`,
        "Review what was done so far in this thread and in the workspace, then continue the task. Don't redo finished work.",
      ].join("\n"),
      { modelSelection: selection },
    ).pipe(
      Effect.catchCause((cause) =>
        finish("failed", "Could not hand the task to the fallback model.", "quota").pipe(
          Effect.andThen(Effect.logWarning("coven: fallback send failed", cause)),
        ),
      ),
    );
    yield* notifyLeader(
      run,
      `${role.name}'s model ran out of quota on "${task.title}"; it continues on ${describeCandidate(next)} in the same thread. Don't delegate it again.`,
    );
  });

  const handleLeaderFailure = Effect.fn("handleLeaderFailure")(function* (run: CovenRunRecord) {
    const shell = yield* threads
      .getThreadShell(run.leaderThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return;
    const kind = classifyCovenFailure({
      lastErrorClass: shell.lastErrorClass ?? null,
      lastErrorCode: shell.lastErrorCode ?? null,
      usageLimitResetAt: shell.usageLimitResetAt ?? null,
    });
    if (kind !== "quota") return;
    const definition = yield* covens.definitionAt(run.covenId, run.revision);
    if (definition === null) return;
    const now = yield* nowIso;
    const nowMs = Date.parse(now);
    const role = leaderRole(definition);
    const current = run.state.leader;
    yield* covens.addCooldown({
      providerInstanceId: current.providerInstanceId,
      modelId: current.modelId,
      resetAt:
        shell.usageLimitResetAt ??
        DateTime.formatIso(DateTime.makeUnsafe(nowMs + COVEN_DEFAULT_COOLDOWN_MS)),
      reason: shell.lastError ?? "Usage limit reached.",
      recordedAt: now,
    });
    const nextIndex = pickCovenCandidate(role.candidates, 0, yield* covens.cooldowns, nowMs);
    const limitReached =
      run.state.leaderTransitions >= definition.frontMatter.limits.maxLeadershipTransitionsPerRun;
    if (nextIndex === null || limitReached) {
      yield* covens.updateRun(run.id, (record) =>
        Effect.succeed({
          state: {
            ...record.state,
            status: "paused" as const,
            resumeStatus: record.state.status,
            statusReason: limitReached
              ? "The leader changed models too many times; resume when ready."
              : "Every leader model is out of quota.",
          },
          events: [event("run.paused", "Paused: the leader is out of quota.")],
          result: undefined,
        }),
      );
      return;
    }
    const next = role.candidates[nextIndex]!;
    const updated = yield* covens.updateRun(run.id, (record) =>
      Effect.succeed({
        state: {
          ...record.state,
          leaderTransitions: record.state.leaderTransitions + 1,
          leader: {
            epoch: record.state.leader.epoch + 1,
            candidateIndex: nextIndex,
            providerInstanceId: next.providerInstanceId,
            modelId: next.modelId,
          },
        },
        events: [
          event(
            "leader.handoff",
            `Leader ${describeCandidate(current)} ran out of quota; ${describeCandidate(next)} takes over.`,
          ),
        ],
        result: record,
      }),
    );
    const events = yield* covens.runEvents(run.id, 20);
    const view = toRunView(updated, events);
    const open = view.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
    const selection = yield* candidateSelection(next);
    yield* sendAsCoven(
      run.leaderThreadId,
      [
        `[Coven] Leadership handoff: ${describeCandidate(current)} ran out of quota and you (${describeCandidate(next)}) now lead this run.`,
        view.plan
          ? `Plan (${view.plan.status}):\n${view.plan.text}`
          : "No plan has been recorded yet.",
        open.length > 0
          ? `Open tasks:\n${open.map((task) => `- ${task.title} (${task.roleId}, ${task.status}${task.childThreadId ? `, thread ${task.childThreadId}` : ""})`).join("\n")}`
          : "No tasks are open.",
        "Call coven_task_status for detail, then continue. Don't re-delegate tasks that are still running.",
      ].join("\n\n"),
      { modelSelection: selection },
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("coven: leader handoff send failed", cause)),
    );
  });

  const onEvent = Effect.fn("onEvent")(
    function* (domainEvent: OrchestrationV2DomainEvent) {
      if (domainEvent.type === "subagent.updated") {
        const subagent = domainEvent.payload;
        if (subagent.childThreadId === null || subagent.origin !== "app_owned") return;
        const outcome: ChildOutcome | null =
          subagent.status === "completed"
            ? "completed"
            : subagent.status === "failed"
              ? "failed"
              : subagent.status === "cancelled"
                ? "cancelled"
                : null;
        if (outcome === null) return;
        if (!(yield* markOnce(`subagent:${subagent.id}:${outcome}`))) return;
        yield* handleChildOutcome(subagent.childThreadId, outcome, "delegation", null);
        return;
      }
      if (domainEvent.type !== "run.updated") return;
      const providerRun = domainEvent.payload;
      if (providerRun.status !== "completed" && providerRun.status !== "failed") return;
      const link = yield* covens.childLink(providerRun.threadId);
      if (link !== null) {
        if (!(yield* markOnce(`run:${providerRun.id}:${providerRun.status}`))) return;
        yield* handleChildOutcome(
          providerRun.threadId,
          providerRun.status,
          "resume",
          DateTime.toEpochMillis(providerRun.requestedAt),
        );
        return;
      }
      if (providerRun.status !== "failed") return;
      const scope = yield* covens.threadScope(providerRun.threadId);
      if (scope === null || scope.kind !== "leader" || scope.run === null) return;
      if (scope.run.state.status === "paused" || !isRunActive(scope.run.state.status)) return;
      if (!(yield* markOnce(`run:${providerRun.id}:failed`))) return;
      yield* handleLeaderFailure(scope.run);
    },
    Effect.catchCause((cause) => Effect.logWarning("coven: run engine event failed", cause)),
  );

  const sweepRuntime = Effect.gen(function* () {
    const nowMs = Date.parse(yield* nowIso);
    for (const run of yield* covens.activeRuns) {
      if (run.state.status === "paused") continue;
      // The limit bounds one piece of work, not the coven's life on the thread.
      if (!run.state.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))) continue;
      const definition = yield* covens.definitionAt(run.covenId, run.revision);
      if (definition === null) continue;
      const limitMs = definition.frontMatter.limits.maxRuntimeMinutes * 60_000;
      if (nowMs - Date.parse(run.state.cycleStartedAt ?? run.startedAt) < limitMs) continue;
      yield* covens.updateRun(run.id, (record) =>
        Effect.succeed({
          state: {
            ...record.state,
            status: "paused" as const,
            resumeStatus: record.state.status,
            statusReason: `This piece of work passed its ${definition.frontMatter.limits.maxRuntimeMinutes} minute limit.`,
          },
          events: [event("run.paused", "Paused: this piece of work reached its time limit.")],
          result: undefined,
        }),
      );
      yield* notifyLeader(
        run,
        "This piece of work reached its time limit and is paused. Stop delegating; the user decides how to continue.",
      );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("coven: runtime sweep failed", cause)));

  yield* forkParked(Stream.runForEach(threads.streamDomainEvents, onEvent));
  yield* forkParked(Stream.runForEach(covens.runChanges, projectDocs));
  yield* forkParked(Effect.repeat(sweepRuntime, Schedule.spaced("1 minute")));

  // ── Builder ──────────────────────────────────────────────────────────

  const startBuilder: CovenControlService["Service"]["startBuilder"] = Effect.fn("startBuilder")(
    function* (input) {
      const shell =
        input.fromThreadId === undefined
          ? null
          : yield* threads
              .getThreadShell(input.fromThreadId)
              .pipe(Effect.orElseSucceed(() => null));
      const projectId = shell?.projectId ?? input.projectId;
      if (projectId === undefined) {
        return yield* notFound("Open a project to build a coven.");
      }
      const base = input.baseCovenId ? yield* covens.get(input.baseCovenId) : null;
      const name = "New coven";
      const source =
        base?.source ??
        starterCovenSource({
          id: `${slugifyCovenName(name)}-${(yield* uuid).slice(0, 6)}`,
          name,
          leader: {
            providerInstanceId: input.modelSelection.instanceId,
            modelId: input.modelSelection.model,
          },
          mission: input.prompt,
        });
      const draft = yield* covens.createDraft({
        builderThreadId: null,
        baseCovenId: base?.summary.id ?? null,
        baseRevision: base?.summary.revision ?? null,
        source,
      });
      const launched = yield* launcher
        .launch({
          commandId: CommandId.make(`coven:${yield* uuid}`),
          projectId,
          title: base ? `Edit coven: ${base.summary.name}` : "Build a coven",
          modelSelection: input.modelSelection,
          runtimeMode: shell?.runtimeMode ?? input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: shell?.interactionMode ?? "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`coven:${yield* uuid}`),
            text: covenBuilderBrief({ draft, request: input.prompt, providers: [] }),
            attachments: [],
          },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(asCovenError("Could not start the coven builder.")));
      const bound = yield* covens.setDraftThread(draft.id, launched.threadId);
      return { draft: bound, builderThreadId: launched.threadId };
    },
  );

  const saveDraft: CovenControlService["Service"]["saveDraft"] = Effect.fn("saveDraft")(
    function* (draftId) {
      const draft: CovenDraft | null = yield* covens.getDraft(draftId);
      if (draft === null) return yield* notFound("That draft no longer exists.");
      const parsed = parseCovenSource(draft.source);
      if (!parsed.ok) {
        return yield* new CovenError({
          reason: "invalid-definition",
          message: "Fix the draft's problems before saving.",
          issues: parsed.issues,
        });
      }
      const sameCoven =
        draft.baseCovenId === parsed.definition.frontMatter.id && draft.baseRevision !== null;
      const detail = yield* covens.save({
        source: draft.source,
        ...(sameCoven ? { expectedRevision: draft.baseRevision! } : {}),
      });
      yield* covens.markDraftSaved(draftId, detail.summary.id, detail.summary.revision);
      return detail;
    },
  );

  return CovenControlService.of({
    setThread,
    clearThread,
    archive,
    controlRun,
    decide,
    proposePlan,
    recordDecision,
    requestGate,
    submitVote,
    completeRun,
    reportToLeader,
    memoryExcerpt,
    startBuilder,
    saveDraft,
  });
});

export const layer = Layer.effect(CovenControlService, make);
