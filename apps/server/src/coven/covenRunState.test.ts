import { describe, expect, it } from "vite-plus/test";
import {
  parseCovenSource,
  starterCovenSource,
  withCovenFrontMatter,
} from "@t3tools/shared/covenDefinition";

import { renderCovenRunDocs } from "./covenRunDocs.ts";
import { covenLeaderNote } from "./covenWorkerTask.ts";
import {
  delegationRefusal,
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
