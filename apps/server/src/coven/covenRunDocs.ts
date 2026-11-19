import type { CovenDefinition, CovenEventSummary, CovenRunView } from "@t3tools/contracts";

/**
 * The run's working notes as Markdown files, written under
 * `docs/coven-runs/<runId>/` in the leader's workspace. They are a view of the
 * run ledger, rewritten on every change, except `memory.md`, which is created
 * once and then belongs to the team and the user.
 */

const bullet = (text: string) => `- ${text.replaceAll("\n", " ")}`;

const eventLines = (events: ReadonlyArray<CovenEventSummary>, kinds?: ReadonlyArray<string>) => {
  const picked = kinds
    ? events.filter((event) => kinds.some((kind) => event.kind.startsWith(kind)))
    : events;
  return picked.length === 0
    ? ["_Nothing yet._"]
    : [...picked]
        .sort((left, right) => left.seq - right.seq)
        .map((event) => bullet(`${event.createdAt} · ${event.summary}`));
};

export const COVEN_RUN_MEMORY_FILE = "memory.md";

export function covenRunMemoryTemplate(view: CovenRunView, definition: CovenDefinition): string {
  return [
    `# ${definition.frontMatter.name}: shared memory`,
    "",
    "Notes the team keeps across tasks and handoffs: facts learned, conventions, open",
    "questions. Workers see the start of this file in their brief. Edit it freely; T3 Code",
    "never rewrites it.",
    "",
    `Run ${view.id}`,
    "",
  ].join("\n");
}

export function renderCovenRunDocs(
  view: CovenRunView,
  definition: CovenDefinition,
  events: ReadonlyArray<CovenEventSummary>,
): Readonly<Record<string, string>> {
  const roleName = (roleId: string) =>
    definition.frontMatter.roles.find((role) => role.id === roleId)?.name ?? roleId;
  const readme = [
    `# ${definition.frontMatter.name} run`,
    "",
    `- Run: ${view.id}`,
    `- Coven: ${definition.frontMatter.id} revision ${view.revision}`,
    `- Status: ${view.status}${view.statusReason ? ` (${view.statusReason})` : ""}`,
    `- Leader: ${view.leader.providerInstanceId} / ${view.leader.modelId} (term ${view.leader.epoch})`,
    `- Started: ${view.startedAt}${view.endedAt ? `; ended ${view.endedAt}` : ""}`,
    "",
    "## Mission",
    "",
    definition.instructions.mission || "_No mission written._",
    "",
    ...(view.summary ? ["## Outcome", "", view.summary, ""] : []),
    "## Files",
    "",
    "- [tasks.md](tasks.md): every task, who ran it and on which model",
    "- [decisions.md](decisions.md): the plan and decisions the leader recorded",
    "- [reviews.md](reviews.md): gate rounds and votes",
    "- [handoffs.md](handoffs.md): model and leadership changes",
    "- [activity.md](activity.md): the full event log",
    "- [memory.md](memory.md): shared notes, edited by the team and you",
    "",
  ].join("\n");

  const tasks = [
    "# Tasks",
    "",
    ...(view.tasks.length === 0
      ? ["_No tasks delegated yet._", ""]
      : view.tasks.flatMap((task) => [
          `## ${task.title}`,
          "",
          bullet(`Role: ${roleName(task.roleId)}`),
          bullet(`Status: ${task.status}`),
          bullet(`Workspace: ${task.workspace}`),
          ...(task.childThreadId ? [bullet(`Thread: ${task.childThreadId}`)] : []),
          ...task.attempts.map((attempt) =>
            bullet(
              `Attempt ${attempt.attempt}: ${attempt.providerInstanceId} / ${attempt.modelId}, ${attempt.status}${
                attempt.failureMessage ? ` (${attempt.failureMessage})` : ""
              }`,
            ),
          ),
          ...(task.result ? ["", task.result] : []),
          "",
        ])),
  ].join("\n");

  const decisions = [
    "# Decisions",
    "",
    "## Plan",
    "",
    view.plan ? `_${view.plan.status}_\n\n${view.plan.text}` : "_No plan proposed yet._",
    "",
    "## Log",
    "",
    ...eventLines(events, ["plan.", "decision", "approval."]),
    "",
  ].join("\n");

  const reviews = [
    "# Reviews and gates",
    "",
    ...(view.gates.length === 0
      ? ["_No gate has run yet._", ""]
      : view.gates.flatMap((round) => [
          `## ${round.gateId} round ${round.round}: ${round.status}`,
          "",
          ...(round.detail ? [round.detail, ""] : []),
          ...round.votes.map((vote) =>
            bullet(`${roleName(vote.roleId)}: ${vote.decision}. ${vote.rationale}`),
          ),
          "",
        ])),
  ].join("\n");

  return {
    "README.md": readme,
    "tasks.md": tasks,
    "decisions.md": decisions,
    "reviews.md": reviews,
    "handoffs.md": ["# Handoffs", "", ...eventLines(events, ["handoff", "leader."]), ""].join("\n"),
    "activity.md": ["# Activity", "", ...eventLines(events), ""].join("\n"),
  };
}
