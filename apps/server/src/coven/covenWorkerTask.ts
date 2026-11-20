import type { CovenDefinition, CovenGateRound, CovenRole } from "@t3tools/contracts";

import type { CovenRunRecord } from "./covenRunState.ts";

/** The prompt a coven worker receives: its role brief, the coven's guidance, then the task. */
export function buildCovenWorkerTask(input: {
  readonly definition: CovenDefinition;
  readonly role: CovenRole;
  readonly task: string;
  readonly memory?: string;
  readonly gateIds?: ReadonlyArray<string>;
}): string {
  const { definition, role } = input;
  const sections = [
    `You are the "${role.name}" (${role.id}) in the coven "${definition.frontMatter.name}". ${role.responsibility}`,
    definition.instructions.mission && `## Mission\n\n${definition.instructions.mission}`,
    definition.instructions.sharedGuidance &&
      `## Shared guidance\n\n${definition.instructions.sharedGuidance}`,
    definition.instructions.roles[role.id] &&
      `## Your role\n\n${definition.instructions.roles[role.id]}`,
    input.memory?.trim() && `## Run memory (from the run's memory.md)\n\n${input.memory.trim()}`,
    input.gateIds && input.gateIds.length > 0
      ? `You vote on these gates: ${input.gateIds.join(", ")}. When the leader asks for your verdict, call coven_gate_submit_vote.`
      : "",
    "Do only this task. Don't delegate further. If you need the leader mid-task, use coven_report_to_leader. End with a short report for the coven leader: what you did, what changed, and anything unresolved.",
    `## Task\n\n${input.task}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** Hidden context on each leader turn, so the leader knows its team and run state without being told. */
export function covenLeaderNote(input: {
  readonly binding: { readonly name: string; readonly revision: number };
  readonly definition: CovenDefinition;
  readonly run?: CovenRunRecord | null;
}): string {
  const frontMatter = input.definition.frontMatter;
  const workers = frontMatter.roles
    .filter((role) => role.kind === "worker")
    .map((role) => `${role.id} (${role.responsibility})`)
    .join("; ");
  const run = input.run ?? null;
  const gates = frontMatter.governance.gates.map((gate) => `${gate.id} (${gate.type}, ${gate.on})`);
  const lines = [
    `This thread runs the coven "${input.binding.name}" (revision ${input.binding.revision}). You are its leader.`,
    workers === ""
      ? "It has no worker roles, so do the work yourself."
      : `Worker roles: ${workers}. Hand work to them with coven_delegate_role; call coven_capabilities for the mission and limits, and coven_task_status for progress. Generic delegation tools and your own built-in subagents are turned off here, so don't start subagents yourself.`,
  ];
  if (run !== null) {
    const status = run.state.status;
    if (status === "awaiting_plan") {
      lines.push(
        run.state.plan?.status === "proposed"
          ? "Your plan is waiting for the user's approval. Don't delegate until it is approved."
          : "Before delegating, propose a plan with coven_propose_plan. The user approves it.",
      );
    } else if (status === "paused") {
      lines.push(
        `The run is paused (${run.state.statusReason ?? "by the user"}). Don't delegate until it resumes.`,
      );
    } else if (status === "awaiting_gate") {
      lines.push(`The run is waiting on a gate: ${run.state.statusReason ?? ""}`);
    }
    const latestRounds = new Map<string, CovenGateRound>();
    for (const round of run.state.gates) {
      const seen = latestRounds.get(round.gateId);
      if (seen === undefined || round.round > seen.round) latestRounds.set(round.gateId, round);
    }
    for (const round of latestRounds.values()) {
      lines.push(
        round.status === "open"
          ? `Gate ${round.gateId} round ${round.round} is open; votes so far: ${round.votes.map((vote) => `${vote.roleId} ${vote.decision}`).join(", ") || "none"}.`
          : `Gate ${round.gateId} round ${round.round} ${round.status}.${round.detail ? ` ${round.detail}` : ""}`,
      );
    }
    if (latestRounds.size > 0) {
      lines.push(
        "A worker's result that refers to an earlier gate round is already handled; don't act on it again.",
      );
    }
    if (run.state.summary !== null && status === "running") {
      lines.push(
        `The coven already finished earlier work on this thread (last: ${run.state.summary}). This is the same coven continuing, not a new run: don't re-plan from scratch; pick up the user's new request with the same team.`,
      );
    }
  }
  if (gates.length > 0) {
    lines.push(
      `Gates: ${gates.join("; ")}. Open one with coven_request_gate; when a piece of work is done, call coven_complete_run, which checks the completion gates.`,
    );
  } else {
    lines.push("When a piece of work is done, call coven_complete_run with a summary.");
  }
  lines.push(
    "The coven stays with this thread until the user switches covens. Completing work doesn't disband it.",
  );
  return lines.join(" ");
}
