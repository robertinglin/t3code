import { OrchestratorMcpFailure, OrchestratorMcpModelOption } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];

const threadTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const CovenCandidateView = Schema.Struct({
  providerInstanceId: Schema.String,
  modelId: Schema.String,
  coolingDownUntil: Schema.NullOr(Schema.String),
});

const CovenRoleView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  responsibility: Schema.String,
  /** Roles sharing a rotation take turns through the same models, round-robin. */
  rotation: Schema.optional(Schema.String),
  candidates: Schema.Array(CovenCandidateView),
});

const CovenGateView = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  on: Schema.String,
  voters: Schema.Array(Schema.String),
});

const CovenTaskView = Schema.Struct({
  id: Schema.String,
  roleId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  childThreadId: Schema.NullOr(Schema.String),
  model: Schema.String,
  attempts: Schema.Int,
  lastFailure: Schema.NullOr(Schema.String),
});

const CovenGateRoundView = Schema.Struct({
  id: Schema.String,
  gateId: Schema.String,
  round: Schema.Int,
  status: Schema.String,
  detail: Schema.String,
  votes: Schema.Array(
    Schema.Struct({ roleId: Schema.String, decision: Schema.String, rationale: Schema.String }),
  ),
});

const CovenRunSnapshot = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
  statusReason: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.Struct({ status: Schema.String, text: Schema.String })),
  leader: Schema.String,
  delegationsUsed: Schema.Int,
  maxDelegations: Schema.Int,
  tasks: Schema.Array(CovenTaskView),
  gates: Schema.Array(CovenGateRoundView),
  docsPath: Schema.NullOr(Schema.String),
});

const CovenCapabilitiesTool = Tool.make("coven_capabilities", {
  description:
    "In a coven thread: the coven's roles, models, gates, limits, mission and your part in it. Read it before delegating.",
  success: Schema.Struct({
    coven: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        revision: Schema.Int,
        yourRole: Schema.String,
        mission: Schema.String,
        sharedGuidance: Schema.String,
        roles: Schema.Array(CovenRoleView),
        gates: Schema.Array(CovenGateView),
        limits: Schema.Struct({
          maxActiveWorkers: Schema.Int,
          maxDelegationsPerRun: Schema.Int,
          maxReviewFixRounds: Schema.Int,
          maxRuntimeMinutes: Schema.Int,
        }),
        planApprovalRequired: Schema.Boolean,
        run: Schema.NullOr(CovenRunSnapshot),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get coven roles")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CovenTaskStatusTool = Tool.make("coven_task_status", {
  description:
    "In a coven thread: the run's status, plan, tasks with their models and attempts, and gate rounds.",
  success: Schema.Struct({ run: Schema.NullOr(CovenRunSnapshot) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get coven run status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CovenDelegateRoleTool = Tool.make("coven_delegate_role", {
  description:
    "Coven leader only: hand a task to a worker role. T3 picks the role's first model with quota, adds the role brief and run memory, and records the task. If that model runs out of quota, T3 moves the task to the next model in the same thread. Completion wakes this thread.",
  parameters: Schema.Struct({
    roleId: text(64).annotate({ description: "Worker role id from coven_capabilities." }),
    task: text(100_000),
    title: Schema.optional(text(200)),
    isolation: Schema.optional(
      Schema.Literals(["shared", "worktree"]).annotate({
        description:
          "'worktree' gives the worker its own checkout. Only one worker at a time may write in the shared checkout.",
      }),
    ),
    dependsOn: Schema.optional(
      Schema.Array(Schema.String).annotate({ description: "Task ids this task waits on." }),
    ),
    clientRequestId: Schema.optional(
      text(256).annotate({ description: "Reuse it to retry the same delegation." }),
    ),
  }),
  success: Schema.Struct({
    taskId: Schema.String,
    roleId: Schema.String,
    providerInstanceId: Schema.String,
    modelId: Schema.String,
    replayed: Schema.Boolean,
    childThreadId: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate to a coven role")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const CovenProposePlanTool = Tool.make("coven_propose_plan", {
  description:
    "Coven leader only: record the run's plan. If the coven requires plan approval, the user approves it before you can delegate.",
  parameters: Schema.Struct({ plan: text(20_000) }),
  success: Schema.Struct({ status: Schema.String, planStatus: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Propose a coven plan")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenRecordDecisionTool = Tool.make("coven_record_decision", {
  description: "Coven leader only: record a decision in the run's decision log.",
  parameters: Schema.Struct({ title: text(200), body: text(4000) }),
  success: Schema.Struct({ recorded: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Record a coven decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenRequestGateTool = Tool.make("coven_request_gate", {
  description:
    "Coven leader only: open a round of a gate (consensus, review, test, artifact or human approval). Voter roles answer with coven_gate_submit_vote; send them the material to judge by delegating to them.",
  parameters: Schema.Struct({
    gateId: text(64),
    detail: text(8000).annotate({ description: "What is being judged and where to find it." }),
  }),
  success: CovenGateRoundView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a coven gate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenSubmitVoteTool = Tool.make("coven_gate_submit_vote", {
  description:
    "Coven voter roles: submit your verdict on an open gate round. For test and artifact gates, approve means the evidence passed.",
  parameters: Schema.Struct({
    gateId: text(64),
    decision: Schema.Literals(["approve", "reject", "abstain"]),
    rationale: text(8000),
  }),
  success: CovenGateRoundView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Vote on a coven gate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenCancelTaskTool = Tool.make("coven_cancel_task", {
  description:
    "Coven leader only: cancel an open task by its taskId and stop its agent, which frees its worker slot. Use it for a task that is stuck or no longer needed.",
  parameters: Schema.Struct({ taskId: Schema.String }),
  success: Schema.Struct({
    taskId: Schema.String,
    cancelled: Schema.Boolean,
    status: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel a coven task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CovenCompleteRunTool = Tool.make("coven_complete_run", {
  description:
    "Coven leader only: mark the current piece of work done. T3 checks that no task is open and every completion gate that applies has passed. The coven stays on the thread for the next request.",
  parameters: Schema.Struct({
    summary: text(8000),
    codeChanged: Schema.Boolean,
    changedPaths: Schema.optional(Schema.Array(Schema.String)),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({
    completed: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    requiredGates: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Complete a coven run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenReportToLeaderTool = Tool.make("coven_report_to_leader", {
  description:
    "Coven workers: send a message to the coven leader mid-task (a blocker, a question, a finding). Your final answer still reaches the leader on its own.",
  parameters: Schema.Struct({ message: text(8000) }),
  success: Schema.Struct({ delivered: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Report to the coven leader")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenModelWarnings = Schema.Array(
  Schema.Struct({ path: Schema.String, message: Schema.String }),
).annotate({
  description:
    "Candidates naming a provider, model, option or option value that doesn't exist. The draft still saves; fix these before telling the user it's ready.",
});

const CovenBuilderProposePatchTool = Tool.make("coven_builder_propose_patch", {
  description:
    "Coven builder threads only: replace the coven draft with a complete new definition file. T3 validates it, and the user sees it in the editor and saves it.",
  parameters: Schema.Struct({
    source: text(262_144).annotate({ description: "The whole coven Markdown file." }),
    expectedVersion: Schema.Int.annotate({ description: "The draft version you edited." }),
    summary: text(500).annotate({ description: "One line on what changed." }),
  }),
  success: Schema.Struct({
    accepted: Schema.Boolean,
    version: Schema.Int,
    issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
    currentSource: Schema.optional(Schema.String),
    warnings: Schema.optional(CovenModelWarnings),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Propose a coven draft")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CovenBuilderReadDraftTool = Tool.make("coven_builder_read_draft", {
  description:
    "Coven builder threads only: the current draft file, its version, its validation problems, warnings about models or options the draft names that don't exist, and the providers and models you can use with each model's options (a candidate's `options` maps an option id to one of its values).",
  success: Schema.Struct({
    source: Schema.String,
    version: Schema.Int,
    issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
    warnings: CovenModelWarnings,
    providers: Schema.Array(
      Schema.Struct({
        providerInstanceId: Schema.String,
        models: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
          }),
        ),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the coven draft")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CovenToolkit = Toolkit.make(
  threadTool(CovenCapabilitiesTool),
  threadTool(CovenTaskStatusTool),
  threadTool(CovenDelegateRoleTool),
  threadTool(CovenProposePlanTool),
  threadTool(CovenRecordDecisionTool),
  threadTool(CovenRequestGateTool),
  threadTool(CovenSubmitVoteTool),
  threadTool(CovenCancelTaskTool),
  threadTool(CovenCompleteRunTool),
  threadTool(CovenReportToLeaderTool),
  threadTool(CovenBuilderReadDraftTool),
  threadTool(CovenBuilderProposePatchTool),
);
