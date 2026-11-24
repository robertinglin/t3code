import type {
  CovenAttempt,
  CovenDefinition,
  CovenEventSummary,
  CovenGateRound,
  CovenPendingApproval,
  CovenRunStatus,
  CovenRunView,
  CovenTask,
  ThreadId,
} from "@t3tools/contracts";
import { applicableCovenGates, covenGateElectorate } from "@t3tools/shared/covenRuntime";

/** A task as the run stores it: the public task plus the bookkeeping the engine needs. */
export interface CovenTaskState extends CovenTask {
  readonly clientRequestId: string | null;
  /** Index into the role's candidates the current attempt uses. */
  readonly candidateIndex: number;
  readonly transientRetries: number;
}

export interface CovenRunState {
  readonly status: CovenRunStatus;
  readonly statusReason: string | null;
  /** The status a paused run returns to on resume. */
  readonly resumeStatus: CovenRunStatus | null;
  readonly plan: CovenRunView["plan"];
  readonly leader: CovenRunView["leader"];
  readonly leaderTransitions: number;
  /** Delegations used by the current piece of work; reset when the leader completes it. */
  readonly delegations: number;
  /** When the current piece of work started. Older rows fall back to the run's start. */
  readonly cycleStartedAt?: string | undefined;
  /** When the user last resumed the run; a task's time limit counts from here at the earliest. */
  readonly resumedAt?: string | undefined;
  /** Gate rounds from earlier pieces of work, kept for the record. */
  readonly completedGates?: ReadonlyArray<CovenGateRound> | undefined;
  /**
   * The model the user picked for the leader thread when it isn't one of the lead role's. It
   * orchestrates; the lead role keeps its other duties (reviews, say) as a subagent.
   */
  readonly pickedLeader?: CovenModelRef | undefined;
  readonly tasks: ReadonlyArray<CovenTaskState>;
  readonly gates: ReadonlyArray<CovenGateRound>;
  readonly pendingApprovals: ReadonlyArray<CovenPendingApproval>;
  readonly summary: string | null;
  readonly docsPath: string | null;
}

export interface CovenModelRef {
  readonly providerInstanceId: string;
  readonly modelId: string;
}

export interface CovenRunRecord {
  readonly id: string;
  readonly leaderThreadId: ThreadId;
  readonly covenId: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly state: CovenRunState;
}

export interface CovenRunEventInput {
  readonly kind: string;
  readonly summary: string;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<CovenRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const isRunActive = (status: CovenRunStatus) => !TERMINAL_RUN_STATUSES.has(status);

/** States in which the leader may hand out new work. */
const canDelegate = (status: CovenRunStatus) => status === "running";

export const ACTIVE_TASK_STATUSES: ReadonlySet<CovenTask["status"]> = new Set([
  "queued",
  "running",
  "blocked",
]);

export function leaderRole(definition: CovenDefinition) {
  return definition.frontMatter.roles.find((role) => role.kind === "orchestrator")!;
}

/** True when the selection is one of the lead role's models. */
export function isLeadModel(
  definition: CovenDefinition,
  selection: { readonly instanceId: string; readonly model: string },
): boolean {
  return leaderRole(definition).candidates.some(
    (candidate) =>
      candidate.providerInstanceId === selection.instanceId &&
      candidate.modelId === selection.model,
  );
}

/** Roles the leader can delegate to: the workers, plus the lead role when the user's model leads. */
export function delegatableRoles(definition: CovenDefinition, state: CovenRunState) {
  return definition.frontMatter.roles.filter(
    (role) => role.kind === "worker" || state.pickedLeader !== undefined,
  );
}

export function initialRunState(input: {
  readonly definition: CovenDefinition;
  readonly leaderCandidateIndex: number;
}): CovenRunState {
  const candidate = leaderRole(input.definition).candidates[input.leaderCandidateIndex]!;
  return {
    status: input.definition.frontMatter.autonomy.initialPlanApproval ? "awaiting_plan" : "running",
    statusReason: input.definition.frontMatter.autonomy.initialPlanApproval
      ? "The leader proposes a plan for you to approve before work starts."
      : null,
    resumeStatus: null,
    plan: null,
    leader: {
      epoch: 1,
      candidateIndex: input.leaderCandidateIndex,
      providerInstanceId: candidate.providerInstanceId,
      modelId: candidate.modelId,
    },
    leaderTransitions: 0,
    delegations: 0,
    tasks: [],
    gates: [],
    pendingApprovals: [],
    summary: null,
    docsPath: null,
  };
}

export function toRunView(
  record: CovenRunRecord,
  events: ReadonlyArray<CovenEventSummary>,
): CovenRunView {
  const { state } = record;
  return {
    id: record.id,
    covenId: record.covenId,
    revision: record.revision,
    status: state.status,
    statusReason: state.statusReason,
    plan: state.plan,
    leader: state.leader,
    ...(state.pickedLeader ? { pickedLeader: state.pickedLeader } : {}),
    tasks: state.tasks.map(
      ({ clientRequestId: _c, candidateIndex: _i, transientRetries: _r, ...task }) => task,
    ),
    gates: [...(state.completedGates ?? []), ...state.gates],
    pendingApprovals: state.pendingApprovals,
    events,
    summary: state.summary,
    docsPath: state.docsPath,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

export function replaceTask(
  state: CovenRunState,
  taskId: string,
  update: (task: CovenTaskState) => CovenTaskState,
): CovenRunState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? update(task) : task)),
  };
}

export function replaceLatestAttempt(
  task: CovenTaskState,
  update: (attempt: CovenAttempt) => CovenAttempt,
): CovenTaskState {
  const last = task.attempts.at(-1);
  if (last === undefined) return task;
  return { ...task, attempts: [...task.attempts.slice(0, -1), update(last)] };
}

/** Tasks still holding a worker slot. */
export function openGateRound(state: CovenRunState, gateId: string) {
  return state.gates.find((round) => round.gateId === gateId && round.status === "open");
}

export function passedGate(state: CovenRunState, gateId: string) {
  return state.gates.some((round) => round.gateId === gateId && round.status === "passed");
}

const ASSUME_CODE_CHANGES = { codeChanged: true, tags: [], changedPaths: [] } as const;

/**
 * Whether the leader may hand work to `roleId` now. Before an implementation
 * gate passes, and while a gate is being decided, only the roles that vote on
 * it may be given work, so reviewers can review but builders wait.
 */
export function delegationRefusal(
  state: CovenRunState,
  definition: CovenDefinition,
  roleId: string,
): string | null {
  const gates = definition.frontMatter.governance.gates;
  if (state.status === "awaiting_gate") {
    const open = state.gates.filter((round) => round.status === "open");
    const electorate = open.flatMap((round) => {
      const gate = gates.find((candidate) => candidate.id === round.gateId);
      return gate === undefined ? [] : covenGateElectorate(gate);
    });
    return electorate.includes(roleId)
      ? null
      : `The run is waiting on ${open.map((round) => round.gateId).join(", ") || "a gate"}. Only ${
          electorate.join(", ") || "the user"
        } can act until it is decided.`;
  }
  if (!canDelegate(state.status)) {
    return state.status === "awaiting_plan"
      ? "The run is waiting for the user to approve the plan. Propose it with coven_propose_plan."
      : `The run is ${state.status.replace("_", " ")}; no new work can start.`;
  }
  const blocking = applicableCovenGates(gates, "before-implementation", ASSUME_CODE_CHANGES).filter(
    (gate) => !passedGate(state, gate.id),
  );
  if (blocking.length === 0) return null;
  const electorate = blocking.flatMap(covenGateElectorate);
  return electorate.includes(roleId)
    ? null
    : `Gate ${blocking.map((gate) => gate.id).join(", ")} must pass before implementation. Request it with coven_request_gate; until then only ${
        electorate.join(", ") || "reviewers"
      } can be given work.`;
}

/** How many minutes before a task's time limit its agent is told to wrap up (20 for the default 240). */
export function runtimeWarningMinutes(limitMinutes: number): number {
  return Math.min(20, Math.floor(limitMinutes / 4));
}

const CHAT_APPROVAL =
  /^(?:i\s+)?(?:approved?|lgtm|looks good(?: to me)?|sounds good|go ahead|go for it|ship it|yes|yep|yeah|ok(?:ay)?)\b/u;
const CHAT_HEDGE = /\b(?:not|don'?t|no|but|except|instead|change|wait|before)\b|\?/u;

/** A short, unhedged "approved" / "lgtm" / "go ahead" reply from the user. */
export function isChatPlanApproval(text: string): boolean {
  const reply = text.trim().toLowerCase();
  return (
    reply.length > 0 && reply.length <= 80 && CHAT_APPROVAL.test(reply) && !CHAT_HEDGE.test(reply)
  );
}

/** The run with its pending plan approved, or null when no plan is waiting on the user. */
export function approvePendingPlan(state: CovenRunState, now: string): CovenRunState | null {
  const approval = state.pendingApprovals.find((candidate) => candidate.kind === "plan");
  if (approval === undefined) return null;
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.filter((candidate) => candidate.id !== approval.id),
    plan: state.plan ? { ...state.plan, status: "approved", decidedAt: now } : null,
    status: state.status === "awaiting_plan" ? "running" : state.status,
    statusReason: null,
  };
}
