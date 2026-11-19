import type { CovenGate, CovenGateVote } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applicableCovenGates,
  classifyCovenFailure,
  evaluateCovenGate,
  matchesCovenGlob,
  pickCovenCandidate,
} from "./covenRuntime.ts";

const vote = (roleId: string, decision: CovenGateVote["decision"]): CovenGateVote => ({
  roleId,
  decision,
  rationale: `${roleId} says ${decision}`,
  providerInstanceId: null,
  modelId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const consensus = (
  overrides: Partial<Extract<CovenGate, { type: "consensus" }>> = {},
): CovenGate => ({
  id: "plan-vote",
  on: "before-implementation",
  type: "consensus",
  voterRoleIds: ["a", "b", "c"],
  decision: { kind: "majority" },
  ...overrides,
});

describe("classifyCovenFailure", () => {
  it("treats a usage limit with a reset time as an exhausted quota", () => {
    expect(
      classifyCovenFailure({
        lastErrorClass: "usage_limit",
        usageLimitResetAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe("quota");
  });
  it("treats a bare 429 as a transient rate limit", () => {
    expect(
      classifyCovenFailure({ lastErrorClass: "usage_limit", lastErrorCode: "api_error_429" }),
    ).toBe("transient");
  });
  it("retries transport errors and stops on permission errors", () => {
    expect(classifyCovenFailure({ lastErrorClass: "transport_error" })).toBe("transient");
    expect(classifyCovenFailure({ lastErrorClass: "permission_error" })).toBe("terminal");
  });
});

describe("pickCovenCandidate", () => {
  const candidates = [
    { providerInstanceId: "claude", modelId: "opus" },
    { providerInstanceId: "codex", modelId: "gpt" },
  ];
  it("skips a candidate that is cooling down", () => {
    const cooldowns = [
      {
        providerInstanceId: "claude",
        modelId: "opus",
        resetAt: "2026-01-01T02:00:00.000Z",
        reason: "quota",
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(pickCovenCandidate(candidates, 0, cooldowns, now)).toBe(1);
    expect(pickCovenCandidate(candidates, 0, cooldowns, Date.parse("2026-01-01T03:00:00Z"))).toBe(
      0,
    );
    expect(pickCovenCandidate(candidates, 2, [], now)).toBeNull();
  });
});

describe("gate conditions", () => {
  it("matches path globs", () => {
    expect(matchesCovenGlob("src/**/*.ts", "src/a/b.ts")).toBe(true);
    expect(matchesCovenGlob("src/**/*.ts", "src/b.ts")).toBe(true);
    expect(matchesCovenGlob("src/*.ts", "src/a/b.ts")).toBe(false);
  });
  it("selects gates by trigger and condition", () => {
    const gates: CovenGate[] = [
      consensus(),
      {
        id: "review",
        on: "before-completion",
        type: "review",
        reviewerRoleIds: ["a"],
        when: { kind: "code-changed" },
      },
    ];
    const context = { codeChanged: false, tags: [], changedPaths: [] };
    expect(applicableCovenGates(gates, "before-completion", context)).toHaveLength(0);
    expect(
      applicableCovenGates(gates, "before-completion", { ...context, codeChanged: true }),
    ).toHaveLength(1);
  });
});

describe("evaluateCovenGate", () => {
  it("passes a majority once enough approvals are in", () => {
    expect(evaluateCovenGate(consensus(), [vote("a", "approve")]).kind).toBe("pending");
    expect(evaluateCovenGate(consensus(), [vote("a", "approve"), vote("b", "approve")]).kind).toBe(
      "passed",
    );
  });
  it("fails a unanimous vote on any rejection or abstention", () => {
    const gate = consensus({ decision: { kind: "unanimous" } });
    expect(evaluateCovenGate(gate, [vote("a", "abstain")]).kind).toBe("failed");
  });
  it("honors a veto", () => {
    const gate = consensus({ vetoRoleIds: ["c"] });
    const outcome = evaluateCovenGate(gate, [
      vote("a", "approve"),
      vote("b", "approve"),
      vote("c", "reject"),
    ]);
    expect(outcome.kind).toBe("failed");
  });
  it("reports a tie", () => {
    const gate = consensus({ voterRoleIds: ["a", "b"] });
    expect(evaluateCovenGate(gate, [vote("a", "approve"), vote("b", "reject")]).kind).toBe("tie");
  });
  it("counts the latest vote per role", () => {
    const gate = consensus({ voterRoleIds: ["a"], decision: { kind: "unanimous" } });
    expect(evaluateCovenGate(gate, [vote("a", "reject"), vote("a", "approve")]).kind).toBe(
      "passed",
    );
  });
  it("needs minimum approvals for a review", () => {
    const gate: CovenGate = {
      id: "r",
      on: "before-completion",
      type: "review",
      reviewerRoleIds: ["a", "b"],
      minimumApprovals: 1,
    };
    expect(evaluateCovenGate(gate, [vote("a", "reject")]).kind).toBe("pending");
    expect(evaluateCovenGate(gate, [vote("a", "reject"), vote("b", "reject")]).kind).toBe("failed");
    expect(evaluateCovenGate(gate, [vote("b", "approve")]).kind).toBe("passed");
  });
});
