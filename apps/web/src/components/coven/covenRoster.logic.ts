import type {
  CovenCooldown,
  CovenDefinition,
  CovenGateRound,
  CovenGateVote,
  CovenRoleKind,
  CovenRunView,
  CovenSummary,
  CovenTask,
  CovenVoteDecision,
} from "@t3tools/contracts";

/** One persona in the coven: a role from the definition, or from the summary while it loads. */
export interface CovenMember {
  readonly roleId: string;
  readonly name: string;
  readonly kind: CovenRoleKind;
  readonly responsibility: string;
  readonly instructions: string;
  readonly candidates: ReadonlyArray<{
    readonly providerInstanceId: string;
    readonly modelId: string;
  }>;
}

/** Stands in for the model the user picked to orchestrate in place of the lead role. */
export const PICKED_LEADER_ROLE_ID = "picked-leader";

/**
 * The leader first, then workers in definition order. When the user picked a model of their own
 * to orchestrate, it leads and the lead role stays on as a member for its other duties.
 */
export function covenMembers(
  definition: CovenDefinition | null,
  summary: CovenSummary | null,
  run: CovenRunView | null = null,
): CovenMember[] {
  const roster = rosterMembers(definition, summary);
  const picked = run?.pickedLeader;
  if (picked === undefined) return roster;
  return [
    {
      roleId: PICKED_LEADER_ROLE_ID,
      name: picked.modelId,
      kind: "orchestrator",
      responsibility: "Orchestrates the coven: the model you picked for this thread.",
      instructions: "",
      candidates: [picked],
    },
    ...roster.map((member) => ({ ...member, kind: "worker" as const })),
  ];
}

function rosterMembers(
  definition: CovenDefinition | null,
  summary: CovenSummary | null,
): CovenMember[] {
  const members: CovenMember[] =
    definition !== null
      ? definition.frontMatter.roles.map((role) => ({
          roleId: role.id,
          name: role.name,
          kind: role.kind,
          responsibility: role.responsibility,
          instructions: definition.instructions.roles[role.id] ?? "",
          candidates: role.candidates,
        }))
      : (summary?.roles ?? []).map((role) => ({
          roleId: role.id,
          name: role.name,
          kind: role.kind,
          responsibility: "",
          instructions: "",
          candidates: [role.primary],
        }));
  return members.toSorted(
    (left, right) => Number(right.kind === "orchestrator") - Number(left.kind === "orchestrator"),
  );
}

/** The roles a gate asks for a verdict, from the definition. Empty for gates nobody votes on. */
export function gateElectorate(definition: CovenDefinition | null, gateId: string): string[] {
  const gate = definition?.frontMatter.governance.gates.find((entry) => entry.id === gateId);
  if (gate === undefined) return [];
  if (gate.type === "consensus") return [...gate.voterRoleIds];
  if (gate.type === "review") return [...gate.reviewerRoleIds];
  return [];
}

export type BallotDecision = CovenVoteDecision | "pending";

export interface GateBallot {
  readonly roleId: string;
  readonly decision: BallotDecision;
  readonly vote: CovenGateVote | null;
}

/** Every expected voter with their latest vote, plus anyone else who voted. */
export function gateBallots(
  round: CovenGateRound,
  electorate: ReadonlyArray<string>,
): GateBallot[] {
  const latest = new Map<string, CovenGateVote>();
  for (const vote of round.votes) latest.set(vote.roleId, vote);
  const roleIds = [...new Set([...electorate, ...latest.keys()])];
  return roleIds.map((roleId) => {
    const vote = latest.get(roleId) ?? null;
    return { roleId, decision: vote?.decision ?? "pending", vote };
  });
}

const GATE_TYPE_LABEL: Record<string, string> = {
  consensus: "Vote",
  review: "Review",
  test: "Test check",
  "human-approval": "Your approval",
  artifact: "Artifact check",
};

/** "Design review, round 2" from a gate id like `design-review`. */
export function gateTitle(round: CovenGateRound): string {
  const name = humanizeId(round.gateId);
  const kind = GATE_TYPE_LABEL[round.gateType];
  const base =
    kind && !name.toLowerCase().includes(kind.toLowerCase())
      ? `${name} ${kind.toLowerCase()}`
      : name;
  return round.round > 1 ? `${base}, round ${round.round}` : base;
}

function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
}

const TERMINAL_RUN = new Set<CovenRunView["status"]>(["completed", "failed", "cancelled"]);

export function isRunFinished(run: CovenRunView | null): boolean {
  return run !== null && TERMINAL_RUN.has(run.status);
}

/** The run's state in plain words, for the panel's header. */
export function runHeadline(run: CovenRunView | null): string {
  if (run === null) return "Ready. The lead starts when you send a message.";
  const waitingOn = (kind: "plan" | "gate") =>
    run.pendingApprovals.some((approval) => approval.kind === kind);
  switch (run.status) {
    case "awaiting_plan":
      return waitingOn("plan") ? "Waiting for your plan approval" : "The lead is drafting a plan";
    case "awaiting_gate":
      return waitingOn("gate") ? "Waiting for your decision" : "Judges are voting";
    case "running":
      return "Working";
    case "switching_provider":
      return "Switching models";
    case "paused":
      return run.statusReason ? `Paused: ${run.statusReason}` : "Paused";
    case "recovery_required":
      return run.statusReason ? `Needs recovery: ${run.statusReason}` : "Needs recovery";
    case "completed":
      return "Finished";
    case "failed":
      return run.statusReason ? `Failed: ${run.statusReason}` : "Failed";
    case "cancelled":
      return "Stopped";
  }
}

export type MemberActivity = "working" | "voting" | "waiting" | "idle" | "done" | "failed";

export interface MemberStatus {
  readonly activity: MemberActivity;
  readonly line: string;
}

const latestFirst = <T extends { readonly updatedAt: string }>(items: ReadonlyArray<T>) =>
  items.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

/** What a member is doing right now, in plain words. */
export function memberStatus(
  member: CovenMember,
  run: CovenRunView | null,
  definition: CovenDefinition | null,
  nameOf: (roleId: string) => string,
): MemberStatus {
  if (run === null) {
    return member.kind === "orchestrator"
      ? { activity: "idle", line: "Ready to lead when you send a message" }
      : { activity: "idle", line: "Idle, waiting for the lead" };
  }
  if (member.kind === "orchestrator") return leaderStatus(run, nameOf);

  const tasks = latestFirst(run.tasks.filter((task) => task.roleId === member.roleId));
  const finished = isRunFinished(run);
  if (!finished && run.status === "paused" && tasks.some((task) => task.status === "running")) {
    return { activity: "waiting", line: "Paused mid-task" };
  }
  const running = tasks.find((task) => task.status === "running");
  if (running && !finished) return { activity: "working", line: running.title };

  const openRound = run.gates.findLast((round) => round.status === "open");
  if (openRound && !finished) {
    const electorate = gateElectorate(definition, openRound.gateId);
    const ballot = gateBallots(openRound, electorate).find(
      (entry) => entry.roleId === member.roleId,
    );
    if (ballot?.decision === "pending") {
      return { activity: "voting", line: `Judging ${gateTitle(openRound).toLowerCase()}` };
    }
    if (ballot) return { activity: "done", line: `Voted ${ballot.decision}` };
  }

  const blocked = tasks.find((task) => task.status === "blocked" || task.status === "queued");
  if (blocked && !finished) {
    const blocker = blockingTask(blocked, run.tasks);
    return {
      activity: "waiting",
      line: blocker
        ? `Waiting on ${nameOf(blocker.roleId)}`
        : blocked.status === "queued"
          ? `Up next: ${blocked.title}`
          : `Blocked: ${blocked.title}`,
    };
  }
  const latest = tasks[0];
  if (latest?.status === "failed")
    return { activity: "failed", line: `Ran into trouble: ${latest.title}` };
  if (latest?.status === "completed") return { activity: "done", line: `Done: ${latest.title}` };

  const vote = run.gates
    .flatMap((round) => round.votes)
    .findLast((entry) => entry.roleId === member.roleId);
  if (vote) return { activity: "done", line: `Voted ${vote.decision}` };
  return finished
    ? { activity: "idle", line: "Not needed this run" }
    : { activity: "idle", line: "Idle, waiting for the lead" };
}

function blockingTask(task: CovenTask, all: ReadonlyArray<CovenTask>): CovenTask | null {
  return (
    all.find(
      (other) =>
        task.dependsOn.includes(other.id) &&
        other.status !== "completed" &&
        other.roleId !== task.roleId,
    ) ?? null
  );
}

function leaderStatus(run: CovenRunView, nameOf: (roleId: string) => string): MemberStatus {
  switch (run.status) {
    case "awaiting_plan":
      return run.pendingApprovals.some((approval) => approval.kind === "plan")
        ? { activity: "waiting", line: "Waiting for you to approve the plan" }
        : { activity: "working", line: "Drafting the plan" };
    case "awaiting_gate":
      return run.pendingApprovals.some((approval) => approval.kind === "gate")
        ? { activity: "waiting", line: "Waiting for your decision" }
        : { activity: "waiting", line: "Waiting on the judges" };
    case "switching_provider":
      return { activity: "working", line: "Switching to a fallback model" };
    case "paused":
      return { activity: "waiting", line: "Paused" };
    case "recovery_required":
      return { activity: "failed", line: "Needs recovery" };
    case "completed":
      return { activity: "done", line: "Wrapped up the run" };
    case "failed":
      return { activity: "failed", line: "The run failed" };
    case "cancelled":
      return { activity: "idle", line: "Stopped" };
    case "running": {
      const busy = [
        ...new Set(
          run.tasks.filter((task) => task.status === "running").map((task) => task.roleId),
        ),
      ];
      if (busy.length === 0) return { activity: "working", line: "Coordinating" };
      const names = busy.map(nameOf);
      const list =
        names.length <= 2
          ? names.join(" and ")
          : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
      return { activity: "waiting", line: `Waiting on ${list}` };
    }
  }
}

export interface MemberModel {
  readonly providerInstanceId: string;
  readonly modelId: string;
  /** Set when the member left its first choice; `until` is when that model is usable again. */
  readonly failover: {
    readonly fromModelId: string;
    readonly fromProviderInstanceId: string;
    readonly until: string | null;
  } | null;
}

const cooldownFor = (
  cooldowns: ReadonlyArray<CovenCooldown>,
  candidate: { readonly providerInstanceId: string; readonly modelId: string },
) =>
  cooldowns.find(
    (cooldown) =>
      cooldown.providerInstanceId === candidate.providerInstanceId &&
      cooldown.modelId === candidate.modelId,
  ) ?? null;

/** The model a member is on now and whether it got there by failing over. */
export function memberModel(
  member: CovenMember,
  run: CovenRunView | null,
  cooldowns: ReadonlyArray<CovenCooldown>,
): MemberModel | null {
  const primary = member.candidates[0];
  let current: { providerInstanceId: string; modelId: string } | undefined = primary;
  if (run !== null && member.kind === "orchestrator") {
    current = run.pickedLeader ?? run.leader;
  } else if (run !== null) {
    const attempt = latestFirst(
      run.tasks.filter((task) => task.roleId === member.roleId),
    )[0]?.attempts.at(-1);
    if (attempt) current = attempt;
  }
  if (current === undefined) return null;
  const moved =
    primary !== undefined &&
    (primary.providerInstanceId !== current.providerInstanceId ||
      primary.modelId !== current.modelId);
  if (moved) {
    return {
      providerInstanceId: current.providerInstanceId,
      modelId: current.modelId,
      failover: {
        fromModelId: primary.modelId,
        fromProviderInstanceId: primary.providerInstanceId,
        until: cooldownFor(cooldowns, primary)?.resetAt ?? null,
      },
    };
  }
  return {
    providerInstanceId: current.providerInstanceId,
    modelId: current.modelId,
    failover: null,
  };
}

/** The member's first-choice model when it is cooling down and no run has moved them off it yet. */
export function memberPrimaryCooldown(
  member: CovenMember,
  cooldowns: ReadonlyArray<CovenCooldown>,
): CovenCooldown | null {
  const primary = member.candidates[0];
  return primary === undefined ? null : cooldownFor(cooldowns, primary);
}

/** One or two letters for a member's avatar: "Neon judge" is "NJ", "Lead" is "Le". */
export function memberInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const [first = "", second = ""] = [...words[0]!];
    return (first.toUpperCase() + second.toLowerCase()).trim();
  }
  return ([...words[0]!][0]! + [...words[1]!][0]!).toUpperCase();
}

/** A stable hue per role, spread around the wheel so neighbours rarely match. */
export function memberHue(roleId: string): number {
  let hash = 2166136261;
  for (const char of roleId) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

/** A member's tasks, newest first. */
export function memberTasks(run: CovenRunView | null, roleId: string): CovenTask[] {
  return run === null ? [] : latestFirst(run.tasks.filter((task) => task.roleId === roleId));
}

/** Every vote a member cast, newest first, with the round it belongs to. */
export function memberVotes(
  run: CovenRunView | null,
  roleId: string,
): Array<{ readonly round: CovenGateRound; readonly vote: CovenGateVote }> {
  if (run === null) return [];
  return run.gates
    .flatMap((round) =>
      round.votes.filter((vote) => vote.roleId === roleId).map((vote) => ({ round, vote })),
    )
    .toReversed();
}
