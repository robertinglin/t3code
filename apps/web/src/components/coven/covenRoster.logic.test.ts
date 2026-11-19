import type { CovenGateRound, CovenRunView, CovenTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CovenMember,
  gateBallots,
  gateTitle,
  memberInitials,
  memberModel,
  memberStatus,
  runHeadline,
} from "./covenRoster.logic";

const AT = "2026-11-19T16:00:00.000Z";

const lead: CovenMember = {
  roleId: "lead",
  name: "Lead",
  kind: "orchestrator",
  responsibility: "Runs the show",
  instructions: "",
  candidates: [{ providerInstanceId: "claude", modelId: "opus" }],
};
const neon: CovenMember = {
  roleId: "neon-judge",
  name: "Neon judge",
  kind: "worker",
  responsibility: "Judges designs",
  instructions: "",
  candidates: [
    { providerInstanceId: "gemini", modelId: "gemini-4-neon" },
    { providerInstanceId: "codex", modelId: "gpt-6.2-astra" },
  ],
};
const names: Record<string, string> = { lead: "Lead", "neon-judge": "Neon judge" };
const nameOf = (roleId: string) => names[roleId] ?? roleId;

function task(overrides: Partial<CovenTask>): CovenTask {
  return {
    id: "t1",
    roleId: "neon-judge",
    title: "Judge the design brief",
    status: "running",
    workspace: "shared",
    dependsOn: [],
    childThreadId: null,
    result: null,
    attempts: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as CovenTask;
}

function run(overrides: Partial<CovenRunView>): CovenRunView {
  return {
    id: "run",
    covenId: "coven",
    revision: 1,
    status: "running",
    statusReason: null,
    plan: null,
    leader: { epoch: 1, candidateIndex: 0, providerInstanceId: "claude", modelId: "opus" },
    tasks: [],
    gates: [],
    pendingApprovals: [],
    events: [],
    summary: null,
    docsPath: null,
    startedAt: AT,
    endedAt: null,
    ...overrides,
  } as CovenRunView;
}

const round = (overrides: Partial<CovenGateRound>): CovenGateRound =>
  ({
    id: "g1",
    gateId: "design-review",
    gateType: "consensus",
    round: 1,
    status: "open",
    detail: "",
    votes: [],
    openedAt: AT,
    closedAt: null,
    ...overrides,
  }) as CovenGateRound;

describe("memberStatus", () => {
  it("shows everyone idle before a run", () => {
    expect(memberStatus(neon, null, null, nameOf).line).toBe("Idle, waiting for the lead");
    expect(memberStatus(lead, null, null, nameOf).activity).toBe("idle");
  });

  it("shows a worker's running task and the leader waiting on them", () => {
    const current = run({ tasks: [task({})] });
    expect(memberStatus(neon, current, null, nameOf)).toEqual({
      activity: "working",
      line: "Judge the design brief",
    });
    expect(memberStatus(lead, current, null, nameOf).line).toBe("Waiting on Neon judge");
  });

  it("shows a pending plan approval on the leader", () => {
    const current = run({
      status: "awaiting_plan",
      pendingApprovals: [{ id: "a", kind: "plan", title: "Plan", body: "", createdAt: AT }],
    });
    expect(memberStatus(lead, current, null, nameOf).line).toBe(
      "Waiting for you to approve the plan",
    );
    expect(runHeadline(current)).toBe("Waiting for your plan approval");
  });

  it("reports a cast vote", () => {
    const current = run({
      status: "awaiting_gate",
      gates: [
        round({
          votes: [
            {
              roleId: "neon-judge",
              decision: "approve",
              rationale: "Looks good",
              providerInstanceId: null,
              modelId: null,
              createdAt: AT,
            },
          ],
        }),
      ],
    });
    expect(memberStatus(neon, current, null, nameOf).line).toBe("Voted approve");
  });

  it("says who a queued task waits on", () => {
    const current = run({
      tasks: [
        task({ id: "write", roleId: "lead", status: "running" }),
        task({ id: "judge", status: "queued", dependsOn: ["write"] }),
      ],
    });
    expect(memberStatus(neon, current, null, nameOf).line).toBe("Waiting on Lead");
  });
});

describe("gateBallots", () => {
  it("lists pending voters alongside cast votes", () => {
    const ballots = gateBallots(
      round({
        votes: [
          {
            roleId: "astra",
            decision: "reject",
            rationale: "No",
            providerInstanceId: null,
            modelId: null,
            createdAt: AT,
          },
        ],
      }),
      ["neon-judge", "astra"],
    );
    expect(ballots.map((ballot) => [ballot.roleId, ballot.decision])).toEqual([
      ["neon-judge", "pending"],
      ["astra", "reject"],
    ]);
  });

  it("titles rounds in words", () => {
    expect(gateTitle(round({ round: 2 }))).toBe("Design review vote, round 2");
  });
});

describe("memberModel", () => {
  it("notices a failover and when the first choice comes back", () => {
    const current = run({
      tasks: [
        task({
          attempts: [
            {
              id: "x",
              attempt: 2,
              candidateIndex: 1,
              providerInstanceId: "codex",
              modelId: "gpt-6.2-astra",
              childThreadId: null,
              status: "running",
              failureClass: null,
              failureMessage: null,
              startedAt: AT,
              endedAt: null,
            },
          ],
        }),
      ],
    });
    const model = memberModel(neon, current, [
      {
        providerInstanceId: "gemini",
        modelId: "gemini-4-neon",
        resetAt: AT,
        reason: "quota",
        recordedAt: AT,
      },
    ]);
    expect(model?.modelId).toBe("gpt-6.2-astra");
    expect(model?.failover).toEqual({
      fromModelId: "gemini-4-neon",
      fromProviderInstanceId: "gemini",
      until: AT,
    });
  });
});

describe("memberInitials", () => {
  it("abbreviates names", () => {
    expect(memberInitials("Neon judge")).toBe("NJ");
    expect(memberInitials("Lead")).toBe("Le");
  });
});
