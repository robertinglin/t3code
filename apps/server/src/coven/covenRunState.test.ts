import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  parseCovenSource,
  starterCovenSource,
  withCovenFrontMatter,
} from "@t3tools/shared/covenDefinition";

import { renderCovenRunDocs } from "./covenRunDocs.ts";
import { covenLeaderNote } from "./covenWorkerTask.ts";
import {
  advanceRotation,
  approvePendingPlan,
  pickRoleCandidate,
  delegatableRoles,
  delegationRefusal,
  isChatPlanApproval,
  isLeadModel,
  leaderRole,
  pendingReviews,
  reviewHandoffRefusal,
  runtimeWarningMinutes,
  initialRunState,
  toRunView,
  type CovenRunState,
} from "./covenRunState.ts";

const source = withCovenFrontMatter(
  starterCovenSource({
    id: "review-first",
    name: "Review first",
    leader: { providerInstanceId: "codex", modelId: "gpt-5.5" },
  }),
  (frontMatter) => ({
    ...frontMatter,
    roles: [
      ...(frontMatter.roles as ReadonlyArray<unknown>),
      {
        id: "reviewer",
        kind: "worker" as const,
        name: "Reviewer",
        responsibility: "Reviews the plan",
        candidates: [{ providerInstanceId: "claudeAgent", modelId: "claude-opus-5-5" }],
      },
    ],
    governance: {
      ...(frontMatter.governance as object),
      gates: [
        {
          id: "plan-review",
          type: "review" as const,
          on: "before-implementation" as const,
          reviewerRoleIds: ["reviewer"],
        },
      ],
    },
  }),
);

const parsed = parseCovenSource(source);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
const definition = parsed.definition;

const running = (state: CovenRunState): CovenRunState => ({ ...state, status: "running" });

describe("coven run state", () => {
  it("waits for plan approval when the coven asks for it", () => {
    const state = initialRunState({ definition, leaderCandidateIndex: 0 });
    expect(state.status).toBe("awaiting_plan");
    expect(delegationRefusal(state, definition, "builder")).toMatch(/approve the plan/);
  });

  it("treats a short approving chat reply as plan approval", () => {
    for (const reply of [
      "Approved",
      "approve",
      "LGTM",
      "Looks good, go ahead.",
      "yes",
      "ship it!",
    ]) {
      expect(isChatPlanApproval(reply)).toBe(true);
    }
    for (const reply of [
      "Approved, but change slice 2 first",
      "not approved",
      "approve?",
      "Can you explain the plan",
      "",
    ]) {
      expect(isChatPlanApproval(reply)).toBe(false);
    }
    const now = "2026-11-23T12:00:00.000Z";
    const waiting: CovenRunState = {
      ...initialRunState({ definition, leaderCandidateIndex: 0 }),
      plan: { text: "Slice 1", status: "proposed", proposedAt: now, decidedAt: null },
      pendingApprovals: [
        { id: "plan-1", kind: "plan", title: "Approve the plan", body: "Slice 1", createdAt: now },
      ],
    };
    const approved = approvePendingPlan(waiting, now);
    expect(approved?.status).toBe("running");
    expect(approved?.plan?.status).toBe("approved");
    expect(approved?.pendingApprovals).toEqual([]);
    expect(approvePendingPlan(approved!, now)).toBeNull();
  });

  it("lets only reviewers work until the implementation gate passes", () => {
    const state = running(initialRunState({ definition, leaderCandidateIndex: 0 }));
    expect(delegationRefusal(state, definition, "reviewer")).toBeNull();
    expect(delegationRefusal(state, definition, "builder")).toMatch(/plan-review/);

    const passed: CovenRunState = {
      ...state,
      gates: [
        {
          id: "round-1",
          gateId: "plan-review",
          gateType: "review",
          round: 1,
          status: "passed",
          detail: "plan",
          votes: [],
          openedAt: "2026-11-19T00:00:00.000Z",
          closedAt: "2026-11-19T00:01:00.000Z",
        },
      ],
    };
    expect(delegationRefusal(passed, definition, "builder")).toBeNull();
  });

  it("lets the user's own model lead, with the lead role as a subagent", () => {
    const state = running(initialRunState({ definition, leaderCandidateIndex: 0 }));
    expect(isLeadModel(definition, { instanceId: "codex", model: "gpt-5.5" })).toBe(true);
    expect(isLeadModel(definition, { instanceId: "antigravity", model: "gemini-4-neon" })).toBe(
      false,
    );
    const lead = leaderRole(definition).id;
    expect(delegatableRoles(definition, state).map((role) => role.id)).not.toContain(lead);
    const userLed = {
      ...state,
      pickedLeader: { providerInstanceId: "claudeAgent", modelId: "claude-opus-5-5" },
    };
    expect(delegatableRoles(definition, userLed).map((role) => role.id)).toContain(lead);
    const note = covenLeaderNote({
      binding: { name: "Review first", revision: 1 },
      definition,
      run: {
        id: "run",
        leaderThreadId: "thread" as never,
        covenId: "review-first",
        revision: 1,
        startedAt: "2026-11-19T00:00:00.000Z",
        endedAt: null,
        state: userLed,
      },
    });
    expect(note).toContain("picked you as its orchestrator");
    expect(note).toContain(`lead role ${lead} no longer leads`);
    expect(
      toRunView(
        {
          id: "run",
          leaderThreadId: "t" as never,
          covenId: "c",
          revision: 1,
          startedAt: "2026-11-19T00:00:00.000Z",
          endedAt: null,
          state: userLed,
        },
        [],
      ).pickedLeader?.modelId,
    ).toBe("claude-opus-5-5");
  });

  it("takes turns through a rotation and picks the model with the most headroom", () => {
    const pool = ["a", "b", "c"].map((name) => ({
      providerInstanceId: ProviderInstanceId.make(name),
      modelId: `model-${name}`,
    }));
    const role = (id: string) => ({
      id,
      kind: "worker" as const,
      name: id,
      responsibility: "",
      rotation: "loop",
      candidates: pool,
    });
    let state = running(initialRunState({ definition, leaderCandidateIndex: 0 }));
    const turns: string[] = [];
    for (const id of ["implementer", "reviewer", "implementer", "reviewer"]) {
      const index = pickRoleCandidate(role(id), state, [], 0)!;
      turns.push(`${id}:${pool[index]!.modelId}`);
      state = advanceRotation(state, role(id), index);
    }
    expect(turns).toEqual([
      "implementer:model-a",
      "reviewer:model-b",
      "implementer:model-c",
      "reviewer:model-a",
    ]);
    // A model out of quota is skipped, wrapping around.
    const cooling = [{ ...pool[0]!, resetAt: "2999-01-01T00:00:00.000Z" }];
    expect(pickRoleCandidate(role("implementer"), { rotations: { loop: 0 } }, cooling, 0)).toBe(1);
    const { rotation: _rotation, ...worker } = role("worker");
    const headroomRole = { ...worker, pick: "most-headroom" as const };
    const room: Record<string, number | null> = { "model-a": 10, "model-b": 80, "model-c": null };
    expect(
      pickRoleCandidate(headroomRole, state, [], 0, undefined, (c) => room[c.modelId] ?? null),
    ).toBe(1);
  });

  it("makes a role's required review a rule, not a suggestion", () => {
    const reviewedSource = withCovenFrontMatter(source, (frontMatter) => ({
      ...frontMatter,
      roles: (frontMatter.roles as ReadonlyArray<Record<string, unknown>>).map((role) =>
        role.id === "builder" ? { ...role, reviewedBy: "reviewer" } : role,
      ),
      governance: { ...(frontMatter.governance as object), gates: [] },
    }));
    const reviewedParsed = parseCovenSource(reviewedSource);
    if (!reviewedParsed.ok) throw new Error(JSON.stringify(reviewedParsed.issues));
    const reviewed = reviewedParsed.definition;
    const at = "2026-01-01T00:00:00.000Z";
    const task = (
      id: string,
      roleId: string,
      status: "running" | "completed" | "failed",
      reviewOf?: string,
    ) => ({
      id,
      roleId,
      title: id,
      status,
      workspace: "shared" as const,
      dependsOn: [],
      childThreadId: ThreadId.make(`thread-${id}`),
      result: null,
      attempts: [],
      ...(reviewOf === undefined ? {} : { reviewOf }),
      createdAt: at,
      updatedAt: at,
      clientRequestId: null,
      candidateIndex: 0,
      transientRetries: 0,
    });
    const base = running(initialRunState({ definition: reviewed, leaderCandidateIndex: 0 }));
    const slice = { ...base, tasks: [task("slice-1", "builder", "completed")] };

    // The finished slice is owed a review, and the builder gets nothing new until it starts.
    expect(pendingReviews(slice, reviewed)).toMatchObject([
      { task: { id: "slice-1" }, reviewerRoleId: "reviewer", underway: false },
    ]);
    expect(reviewHandoffRefusal(slice, reviewed, "builder", undefined)).toMatch(
      /reviewOf: "slice-1"/,
    );
    expect(
      covenLeaderNote({
        binding: { name: "R", revision: 1 },
        definition: reviewed,
        run: {
          id: "run",
          leaderThreadId: ThreadId.make("leader"),
          covenId: "c",
          revision: 1,
          startedAt: at,
          updatedAt: at,
          state: slice,
        } as never,
      }),
    ).toContain('reviewOf: "slice-1"');

    // Reviews must name a finished task of a role this one reviews.
    expect(reviewHandoffRefusal(slice, reviewed, "reviewer", "slice-1")).toBeNull();
    expect(reviewHandoffRefusal(slice, reviewed, "builder", "slice-1")).toMatch(
      /reviewed by reviewer/,
    );
    expect(reviewHandoffRefusal(slice, reviewed, "reviewer", "nope")).toMatch(/no task nope/);

    // Once the review is under way the builder can move on; it is still owed until it finishes.
    const reviewing = {
      ...slice,
      tasks: [...slice.tasks, task("review-1", "reviewer", "running", "slice-1")],
    };
    expect(reviewHandoffRefusal(reviewing, reviewed, "builder", undefined)).toBeNull();
    expect(pendingReviews(reviewing, reviewed)).toMatchObject([{ underway: true }]);

    // A failed review has to be handed out again.
    const failedReview = {
      ...slice,
      tasks: [...slice.tasks, task("review-1", "reviewer", "failed", "slice-1")],
    };
    expect(reviewHandoffRefusal(failedReview, reviewed, "builder", undefined)).not.toBeNull();

    const done = {
      ...slice,
      tasks: [...slice.tasks, task("review-1", "reviewer", "completed", "slice-1")],
    };
    expect(pendingReviews(done, reviewed)).toEqual([]);
  });

  it("tells the leader where each gate stands so late results aren't handled twice", () => {
    const round = (n: number, status: "open" | "failed") => ({
      id: `round-${n}`,
      gateId: "plan-review",
      gateType: "review" as const,
      round: n,
      status,
      detail: status === "failed" ? "Missing edge cases." : "plan v3",
      votes: [],
      openedAt: "2026-11-19T00:00:00.000Z",
      closedAt: status === "open" ? null : "2026-11-19T00:01:00.000Z",
    });
    const state: CovenRunState = {
      ...running(initialRunState({ definition, leaderCandidateIndex: 0 })),
      gates: [round(2, "failed"), round(3, "open")],
    };
    const note = covenLeaderNote({
      binding: { name: "Review first", revision: 1 },
      definition,
      run: {
        id: "run-1",
        leaderThreadId: "thread-1",
        covenId: "review-first",
        revision: 1,
        startedAt: "2026-11-19T00:00:00.000Z",
        endedAt: null,
        state,
      } as never,
    });
    expect(note).toContain("Gate plan-review round 3 is open");
    expect(note).not.toContain("round 2 failed");
    expect(note).toContain("earlier gate round is already handled");
  });

  it("warns an agent twenty minutes before the default limit", () => {
    expect(240 - runtimeWarningMinutes(240)).toBe(220);
    expect(runtimeWarningMinutes(20)).toBe(5);
  });

  it("refuses new work once the run is paused", () => {
    const state: CovenRunState = {
      ...initialRunState({ definition, leaderCandidateIndex: 0 }),
      status: "paused",
    };
    expect(delegationRefusal(state, definition, "reviewer")).toMatch(/paused/);
  });

  it("renders the run notes", () => {
    const state = running(initialRunState({ definition, leaderCandidateIndex: 0 }));
    const view = toRunView(
      {
        id: "run-1",
        leaderThreadId: "thread-1" as never,
        covenId: "review-first",
        revision: 1,
        startedAt: "2026-11-19T00:00:00.000Z",
        endedAt: null,
        state,
      },
      [],
    );
    const docs = renderCovenRunDocs(view, definition, [
      {
        seq: 1,
        kind: "handoff.provider",
        summary: "Builder moved to a fallback model.",
        createdAt: "2026-11-19T00:02:00.000Z",
      },
    ]);
    expect(Object.keys(docs).toSorted()).toEqual([
      "README.md",
      "activity.md",
      "decisions.md",
      "handoffs.md",
      "reviews.md",
      "tasks.md",
    ]);
    expect(docs["handoffs.md"]).toContain("fallback model");
    expect(docs["README.md"]).toContain("Review first");
  });
});
