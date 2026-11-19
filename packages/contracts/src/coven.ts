import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";

export const COVEN_SCHEMA_VERSION = "t3-coven/v1";
export const COVEN_DEFINITION_MAX_BYTES = 256 * 1024;
export const COVEN_INSTRUCTION_MAX_CHARS = 32_000;

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

export const CovenSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
).annotate({ description: "Lower kebab-case identifier, such as bug-hunt." });
export type CovenSlug = typeof CovenSlug.Type;

export const CovenId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
);
export type CovenId = typeof CovenId.Type;

export const CovenRoleId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
export type CovenRoleId = typeof CovenRoleId.Type;

const ShortText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const CovenCandidate = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CovenCandidate = typeof CovenCandidate.Type;

export const CovenRoleKind = Schema.Literals(["orchestrator", "worker"]);
export type CovenRoleKind = typeof CovenRoleKind.Type;

export const CovenRole = Schema.Struct({
  id: CovenRoleId,
  kind: CovenRoleKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  responsibility: ShortText(500),
  candidates: Schema.Array(CovenCandidate).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type CovenRole = typeof CovenRole.Type;

export const CovenGateTrigger = Schema.Literals([
  "before-implementation",
  "before-completion",
  "before-merge",
  "on-demand",
]);

export const CovenGateCondition = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("always") }),
  Schema.Struct({ kind: Schema.Literal("code-changed") }),
  Schema.Struct({ kind: Schema.Literal("task-tag"), tags: Schema.Array(TrimmedNonEmptyString) }),
  Schema.Struct({
    kind: Schema.Literal("path-match"),
    globs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  }),
]);
export type CovenGateCondition = typeof CovenGateCondition.Type;

const GateEscalation = Schema.Literals(["escalate-to-user", "block"]);

const gateCommon = {
  id: CovenRoleId,
  on: CovenGateTrigger,
  when: Schema.optional(CovenGateCondition),
  maxRounds: Schema.optional(boundedInt(1, 10)),
  onUnavailable: Schema.optional(GateEscalation),
};

export const CovenConsensusDecision = Schema.Struct({
  kind: Schema.Literals(["unanimous", "majority", "k-of-n"]),
  k: Schema.optional(Schema.NullOr(boundedInt(1, 32))),
});
export type CovenConsensusDecision = typeof CovenConsensusDecision.Type;

export const CovenConsensusGate = Schema.Struct({
  ...gateCommon,
  type: Schema.Literal("consensus"),
  voterRoleIds: Schema.Array(CovenRoleId).check(Schema.isMinLength(1)),
  quorum: Schema.optional(boundedInt(1, 32)),
  decision: CovenConsensusDecision,
  abstentions: Schema.optional(Schema.Literals(["count-as-not-approval", "exclude"])),
  vetoRoleIds: Schema.optional(Schema.Array(CovenRoleId)),
  onTie: Schema.optional(Schema.Literals(["escalate-to-user", "repeat-once"])),
});
export type CovenConsensusGate = typeof CovenConsensusGate.Type;

export const CovenReviewGate = Schema.Struct({
  ...gateCommon,
  type: Schema.Literal("review"),
  reviewerRoleIds: Schema.Array(CovenRoleId).check(Schema.isMinLength(1)),
  minimumApprovals: Schema.optional(boundedInt(1, 32)),
});

export const CovenTestGate = Schema.Struct({
  ...gateCommon,
  type: Schema.Literal("test"),
  evidence: Schema.optional(ShortText(2_000)),
});

export const CovenHumanApprovalGate = Schema.Struct({
  ...gateCommon,
  type: Schema.Literal("human-approval"),
  question: Schema.optional(ShortText(2_000)),
});

export const CovenArtifactGate = Schema.Struct({
  ...gateCommon,
  type: Schema.Literal("artifact"),
  artifact: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});

export const CovenGate = Schema.Union([
  CovenConsensusGate,
  CovenReviewGate,
  CovenTestGate,
  CovenHumanApprovalGate,
  CovenArtifactGate,
]);
export type CovenGate = typeof CovenGate.Type;

export const CovenGovernance = Schema.Struct({
  defaultWorkflow: Schema.Literal("orchestrator"),
  gates: Schema.Array(CovenGate).check(Schema.isMaxLength(16)),
});

export const CovenWorkspacePolicy = Schema.Struct({
  strategy: Schema.Literal("hybrid"),
  parallelWriters: Schema.Literal("isolated-worktrees"),
  sharedWrites: Schema.Literal("exclusive-lease"),
});

export const CovenAutonomy = Schema.Struct({
  initialPlanApproval: Schema.Boolean,
  scopeChanges: Schema.Literals(["approval-required", "leader-decides"]),
  externalSideEffects: Schema.Literal("approval-required"),
  permissionCeiling: Schema.Literal("inherit-t3"),
});

export const CovenLimits = Schema.Struct({
  maxActiveWorkers: boundedInt(1, 8),
  maxDelegationsPerRun: boundedInt(1, 200),
  maxReviewFixRounds: boundedInt(0, 20),
  maxRuntimeMinutes: boundedInt(1, 24 * 60),
  maxTransientRetriesPerTask: boundedInt(0, 5),
  maxLeadershipTransitionsPerRun: boundedInt(0, 10),
});
export type CovenLimits = typeof CovenLimits.Type;

export const DEFAULT_COVEN_LIMITS: CovenLimits = {
  maxActiveWorkers: 2,
  maxDelegationsPerRun: 12,
  maxReviewFixRounds: 3,
  maxRuntimeMinutes: 240,
  maxTransientRetriesPerTask: 2,
  maxLeadershipTransitionsPerRun: 2,
};

/** The YAML front matter of a coven definition. Unknown keys are rejected at decode time. */
export const CovenFrontMatter = Schema.Struct({
  schemaVersion: Schema.Literal(COVEN_SCHEMA_VERSION),
  id: CovenId,
  slug: CovenSlug,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  revision: boundedInt(1, 1_000_000),
  description: ShortText(300),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(80)))),
  roles: Schema.Array(CovenRole).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  governance: CovenGovernance,
  workspace: CovenWorkspacePolicy,
  autonomy: CovenAutonomy,
  limits: CovenLimits,
  extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CovenFrontMatter = typeof CovenFrontMatter.Type;

export const CovenInstructions = Schema.Struct({
  mission: Schema.String,
  sharedGuidance: Schema.String,
  roles: Schema.Record(Schema.String, Schema.String),
});
export type CovenInstructions = typeof CovenInstructions.Type;

export const CovenDefinition = Schema.Struct({
  frontMatter: CovenFrontMatter,
  instructions: CovenInstructions,
});
export type CovenDefinition = typeof CovenDefinition.Type;

export const CovenValidationIssue = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
export type CovenValidationIssue = typeof CovenValidationIssue.Type;

export const CovenSummary = Schema.Struct({
  id: CovenId,
  slug: CovenSlug,
  name: Schema.String,
  description: Schema.String,
  aliases: Schema.Array(Schema.String),
  revision: Schema.Int,
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: CovenRoleKind,
      name: Schema.String,
      primary: CovenCandidate,
      fallbackCount: Schema.Int,
    }),
  ),
  archived: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type CovenSummary = typeof CovenSummary.Type;

export const CovenRevision = Schema.Struct({
  covenId: CovenId,
  revision: Schema.Int,
  digest: Schema.String,
  source: Schema.String,
  createdAt: IsoDateTime,
});
export type CovenRevision = typeof CovenRevision.Type;

export const CovenDetail = Schema.Struct({
  summary: CovenSummary,
  source: Schema.String,
  revisions: Schema.Array(
    Schema.Struct({ revision: Schema.Int, digest: Schema.String, createdAt: IsoDateTime }),
  ),
});
export type CovenDetail = typeof CovenDetail.Type;

export const ThreadCovenBinding = Schema.Struct({
  threadId: ThreadId,
  covenId: CovenId,
  revision: Schema.Int,
  name: Schema.String,
  slug: CovenSlug,
  boundAt: IsoDateTime,
});
export type ThreadCovenBinding = typeof ThreadCovenBinding.Type;

export class CovenError extends Schema.TaggedError<CovenError>()("CovenError", {
  reason: Schema.Literals([
    "invalid-definition",
    "not-found",
    "conflict",
    "ambiguous",
    "policy-denied",
  ]),
  message: Schema.String,
  issues: Schema.optional(Schema.Array(CovenValidationIssue)),
}) {}

export const CovenRunStatus = Schema.Literals([
  "awaiting_plan",
  "running",
  "awaiting_gate",
  "switching_provider",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
]);
export type CovenRunStatus = typeof CovenRunStatus.Type;

export const CovenTaskStatus = Schema.Literals([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
]);
export type CovenTaskStatus = typeof CovenTaskStatus.Type;

export const CovenAttemptStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "switched",
  "cancelled",
]);
export type CovenAttemptStatus = typeof CovenAttemptStatus.Type;

/** One execution of a task on one candidate. Retries and fallbacks add attempts. */
export const CovenAttempt = Schema.Struct({
  id: Schema.String,
  attempt: Schema.Int,
  candidateIndex: Schema.Int,
  providerInstanceId: Schema.String,
  modelId: Schema.String,
  childThreadId: Schema.NullOr(ThreadId),
  status: CovenAttemptStatus,
  failureClass: Schema.NullOr(Schema.String),
  failureMessage: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type CovenAttempt = typeof CovenAttempt.Type;

export const CovenTask = Schema.Struct({
  id: Schema.String,
  roleId: Schema.String,
  title: Schema.String,
  status: CovenTaskStatus,
  workspace: Schema.Literals(["shared", "isolated"]),
  dependsOn: Schema.Array(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  result: Schema.NullOr(Schema.String),
  attempts: Schema.Array(CovenAttempt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CovenTask = typeof CovenTask.Type;

export const CovenVoteDecision = Schema.Literals(["approve", "reject", "abstain"]);
export type CovenVoteDecision = typeof CovenVoteDecision.Type;

export const CovenGateVote = Schema.Struct({
  roleId: Schema.String,
  decision: CovenVoteDecision,
  rationale: Schema.String,
  providerInstanceId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type CovenGateVote = typeof CovenGateVote.Type;

export const CovenGateRoundStatus = Schema.Literals(["open", "passed", "failed", "escalated"]);
export type CovenGateRoundStatus = typeof CovenGateRoundStatus.Type;

export const CovenGateRound = Schema.Struct({
  id: Schema.String,
  gateId: Schema.String,
  gateType: Schema.String,
  round: Schema.Int,
  status: CovenGateRoundStatus,
  detail: Schema.String,
  votes: Schema.Array(CovenGateVote),
  openedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type CovenGateRound = typeof CovenGateRound.Type;

/** Something only the user can decide: the initial plan, or a gate that needs a person. */
export const CovenPendingApproval = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["plan", "gate"]),
  title: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type CovenPendingApproval = typeof CovenPendingApproval.Type;

export const CovenEventSummary = Schema.Struct({
  seq: Schema.Int,
  kind: Schema.String,
  summary: Schema.String,
  createdAt: IsoDateTime,
});
export type CovenEventSummary = typeof CovenEventSummary.Type;

export const CovenCooldown = Schema.Struct({
  providerInstanceId: Schema.String,
  modelId: Schema.String,
  resetAt: Schema.NullOr(IsoDateTime),
  reason: Schema.String,
  recordedAt: IsoDateTime,
});
export type CovenCooldown = typeof CovenCooldown.Type;

export const CovenRunView = Schema.Struct({
  id: Schema.String,
  covenId: CovenId,
  revision: Schema.Int,
  status: CovenRunStatus,
  statusReason: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      status: Schema.Literals(["proposed", "approved", "rejected"]),
      proposedAt: IsoDateTime,
      decidedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
  leader: Schema.Struct({
    epoch: Schema.Int,
    candidateIndex: Schema.Int,
    providerInstanceId: Schema.String,
    modelId: Schema.String,
  }),
  tasks: Schema.Array(CovenTask),
  gates: Schema.Array(CovenGateRound),
  pendingApprovals: Schema.Array(CovenPendingApproval),
  events: Schema.Array(CovenEventSummary),
  summary: Schema.NullOr(Schema.String),
  docsPath: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type CovenRunView = typeof CovenRunView.Type;

export const ThreadCovenState = Schema.Struct({
  binding: Schema.NullOr(ThreadCovenBinding),
  /** The latest run in this thread, active or finished. */
  run: Schema.NullOr(CovenRunView),
  cooldowns: Schema.Array(CovenCooldown),
});
export type ThreadCovenState = typeof ThreadCovenState.Type;

export const CovenListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
});
export const CovenListResult = Schema.Struct({ covens: Schema.Array(CovenSummary) });
export type CovenListResult = typeof CovenListResult.Type;

export const CovenGetInput = Schema.Struct({ covenId: CovenId });

export const CovenSaveInput = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(COVEN_DEFINITION_MAX_BYTES)),
  expectedRevision: Schema.optional(Schema.Int).annotate({
    description: "The revision the edit started from; saving fails if a newer one exists.",
  }),
});

export const CovenArchiveInput = Schema.Struct({ covenId: CovenId });
export const CovenArchiveResult = Schema.Struct({ covenId: CovenId });

export const ThreadCovenInput = Schema.Struct({ threadId: ThreadId });
export const ThreadCovenSetInput = Schema.Struct({ threadId: ThreadId, covenId: CovenId });

export const CovenGetRevisionInput = Schema.Struct({ covenId: CovenId, revision: Schema.Int });

export const CovenRunControlInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["pause", "resume", "stop"]),
});

export const CovenDecideInput = Schema.Struct({
  threadId: ThreadId,
  approvalId: Schema.String,
  approve: Schema.Boolean,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
});

export const CovenClearCooldownInput = Schema.Struct({
  providerInstanceId: Schema.String,
  modelId: Schema.String,
});

/** A builder draft: the definition a builder chat and the editor work on before it is saved. */
export const CovenDraft = Schema.Struct({
  id: Schema.String,
  builderThreadId: Schema.NullOr(ThreadId),
  baseCovenId: Schema.NullOr(CovenId),
  baseRevision: Schema.NullOr(Schema.Int),
  source: Schema.String,
  version: Schema.Int,
  lastChangeBy: Schema.Literals(["user", "builder"]),
  lastChangeSummary: Schema.NullOr(Schema.String),
  savedRevision: Schema.NullOr(Schema.Int),
  updatedAt: IsoDateTime,
});
export type CovenDraft = typeof CovenDraft.Type;

export const CovenStartBuilderInput = Schema.Struct({
  /** The thread `/coven-build` was typed in; the builder thread joins its project. */
  fromThreadId: Schema.optional(ThreadId),
  /** Used when `/coven-build` is typed in a new thread that hasn't been sent yet. */
  projectId: Schema.optional(ProjectId),
  runtimeMode: Schema.optional(RuntimeMode),
  modelSelection: ModelSelection,
  prompt: Schema.String.check(Schema.isMaxLength(8_000)),
  baseCovenId: Schema.optional(CovenId),
});
export type CovenStartBuilderInput = typeof CovenStartBuilderInput.Type;
export const CovenStartBuilderResult = Schema.Struct({
  draft: CovenDraft,
  builderThreadId: ThreadId,
});
export type CovenStartBuilderResult = typeof CovenStartBuilderResult.Type;

export const CovenDraftInput = Schema.Struct({ draftId: Schema.String });
export const CovenDraftByThreadInput = Schema.Struct({ threadId: ThreadId });
export const CovenUpdateDraftInput = Schema.Struct({
  draftId: Schema.String,
  source: Schema.String.check(Schema.isMaxLength(COVEN_DEFINITION_MAX_BYTES)),
  expectedVersion: Schema.Int,
});
export const CovenSaveDraftInput = Schema.Struct({ draftId: Schema.String });
export const CovenDraftUpdate = Schema.Struct({ draft: Schema.NullOr(CovenDraft) });
export type CovenDraftUpdate = typeof CovenDraftUpdate.Type;
