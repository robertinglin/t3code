import { describe, expect, it } from "vite-plus/test";
import {
  parseCovenSource,
  starterCovenSource,
  withCovenFrontMatter,
} from "@t3tools/shared/covenDefinition";

import { renderCovenRunDocs } from "./covenRunDocs.ts";
import { covenLeaderNote } from "./covenWorkerTask.ts";
import {
  approvePendingPlan,
  delegatableRoles,
  delegationRefusal,
  isChatPlanApproval,
  isLeadModel,
  leaderRole,
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
    const userLed = { ...state, userLed: true };
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
    expect(note).toContain(`${lead} is one of your subagents`);
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
      ).userLed,
    ).toBe(true);
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
