import type {
  CovenRunView,
  CovenSummary,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  COVEN_HELP_TEXT,
  parseCovenCommand,
  resolveCovenName,
} from "@t3tools/shared/covenCommands";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openCovenEditor } from "./CovenEditorDialog";
import { type CovenRunAction, isCovenRunActive, useCovenActions } from "./useCovenActions";

function notice(title: string, description?: string) {
  toastManager.add(stackedThreadToast({ type: "info", title, description }));
}

function failure(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

function describeCovenRoles(coven: CovenSummary): string {
  return coven.roles
    .map((role) => {
      const fallback = role.fallbackCount > 0 ? ` (+${role.fallbackCount} fallback)` : "";
      const lead = role.kind === "orchestrator" ? " · leader" : "";
      return `${role.name}${lead}: ${role.primary.modelId}${fallback}`;
    })
    .join("\n");
}

function describeRun(run: CovenRunView): string {
  const lines = [
    `Run: ${run.status.replaceAll("_", " ")}${run.statusReason ? ` (${run.statusReason})` : ""}`,
    `Leader: ${run.leader.modelId} on ${run.leader.providerInstanceId}`,
  ];
  for (const task of run.tasks) {
    const attempt = task.attempts.at(-1);
    lines.push(
      `${task.roleId}: ${task.title} · ${task.status}${attempt ? ` · ${attempt.modelId}` : ""}`,
    );
  }
  for (const approval of run.pendingApprovals) {
    lines.push(`Waiting for you: ${approval.title} (/coven approve or /coven reject)`);
  }
  if (run.docsPath) lines.push(`Notes: ${run.docsPath}`);
  return lines.join("\n");
}

/**
 * App-owned `/coven` and `/coven-build` commands. Returns a runner that reports whether it
 * handled the text; anything it does not recognize is sent to the provider as usual.
 */
export function useCovenCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** The project of the open thread, including a new thread that hasn't been sent yet. */
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly currentModel: () => ModelSelection | undefined;
  /** Set for a new thread that hasn't been sent yet: its first turn runs on the composer's model. */
  readonly selectComposerModel: ((instanceId: ProviderInstanceId, model: string) => void) | null;
}): (text: string) => boolean {
  const { environmentId, threadId, projectId, runtimeMode, currentModel, selectComposerModel } =
    input;
  const covens = useEnvironmentQuery(serverEnvironment.covensLive({ environmentId, input: {} }))
    .data?.covens;
  const threadCoven = useEnvironmentQuery(
    threadId === null
      ? null
      : serverEnvironment.threadCovenLive({ environmentId, input: { threadId } }),
  ).data;
  const loadCoven = useAtomCommand(serverEnvironment.loadCoven, { label: "coven load" });
  const setThreadCoven = useAtomCommand(serverEnvironment.setThreadCoven, {
    label: "coven change",
  });
  const clearThreadCoven = useAtomCommand(serverEnvironment.clearThreadCoven, {
    label: "coven off",
  });
  const actions = useCovenActions(environmentId);

  const resolve = (name: string | null): CovenSummary | null => {
    const list = covens ?? [];
    if (name === null) {
      const boundId = threadCoven?.binding?.covenId;
      const bound = boundId === undefined ? undefined : list.find((coven) => coven.id === boundId);
      if (bound === undefined) notice("No coven in this thread", "Name one, or use /coven list.");
      return bound ?? null;
    }
    const { match, ambiguous } = resolveCovenName(name, list);
    if (match !== null) return match;
    if (ambiguous.length > 0) {
      notice(`"${name}" matches several covens`, ambiguous.map((coven) => coven.name).join(", "));
    } else {
      notice(`No coven named "${name}"`, "Use /coven list to see saved covens.");
    }
    return null;
  };

  const withSource = async (coven: CovenSummary, use: (source: string) => void) => {
    const result = await loadCoven({ environmentId, input: { covenId: coven.id } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failure("Could not load the coven", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    use(result.value.source);
  };

  const edit = (coven: CovenSummary) =>
    withSource(coven, (source) =>
      openCovenEditor({
        environmentId,
        source,
        expectedRevision: coven.revision,
        covenId: coven.id,
      }),
    );

  const build = (prompt: string, baseCovenId?: CovenSummary["id"]) => {
    if (threadId === null && projectId === null) {
      notice("Open a project first", "The coven builder chat starts in the open project.");
      return;
    }
    const model = currentModel();
    if (model === undefined) {
      notice("Pick a model first", "The coven builder starts on this thread's model.");
      return;
    }
    void actions.startBuilder({
      fromThreadId: threadId,
      projectId,
      runtimeMode,
      modelSelection: model,
      prompt,
      baseCovenId,
    });
  };

  const activeRun = (): CovenRunView | null => {
    const run = threadCoven?.run ?? null;
    if (threadId === null || run === null || !isCovenRunActive(run)) {
      notice(
        "No coven run in this thread",
        "A run starts when you send a message with a coven on.",
      );
      return null;
    }
    return run;
  };

  const control = (action: CovenRunAction) => {
    if (threadId === null || activeRun() === null) return;
    void actions.control(threadId, action);
  };

  const decide = (approve: boolean, note: string | null) => {
    const run = activeRun();
    if (threadId === null || run === null) return;
    const approval = run.pendingApprovals[0];
    if (approval === undefined) {
      notice("Nothing is waiting for approval");
      return;
    }
    void actions
      .decide({ threadId, approvalId: approval.id, approve, note: note ?? undefined })
      .then((done) => {
        if (done) notice(approve ? `Approved: ${approval.title}` : `Rejected: ${approval.title}`);
      });
  };

  const change = async (coven: CovenSummary) => {
    if (threadId === null) {
      notice("Open a thread first", "A coven attaches to a thread.");
      return;
    }
    const result = await setThreadCoven({
      environmentId,
      input: { threadId, covenId: coven.id },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failure("Could not change the coven", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    // An unsent thread has no server model to switch yet, so its first turn starts on the leader.
    const leader = coven.roles.find((role) => role.kind === "orchestrator");
    if (leader !== undefined) {
      selectComposerModel?.(leader.primary.providerInstanceId, leader.primary.modelId);
    }
    notice(`Using ${coven.name} · revision ${coven.revision}`, describeCovenRoles(coven));
  };

  const off = async () => {
    if (threadId === null || threadCoven?.binding == null) {
      notice("No coven in this thread");
      return;
    }
    const result = await clearThreadCoven({ environmentId, input: { threadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failure("Could not turn the coven off", String(squashAtomCommandFailure(result)));
      return;
    }
    notice("Coven off", "This thread is back to a single agent.");
  };

  return (text) => {
    const command = parseCovenCommand(text);
    if (command === null) return false;
    switch (command.kind) {
      case "help":
        notice("Coven commands", COVEN_HELP_TEXT);
        break;
      case "invalid":
        notice(command.message, COVEN_HELP_TEXT);
        break;
      case "list": {
        const list = covens ?? [];
        notice(
          list.length === 0 ? "No covens yet" : "Saved covens",
          list.length === 0
            ? "Use /coven-build <description> to start one."
            : list.map((coven) => `${coven.name} (${coven.slug}) · r${coven.revision}`).join("\n"),
        );
        break;
      }
      case "status":
      case "show": {
        const coven = resolve(command.kind === "show" ? command.name : null);
        if (coven === null) break;
        const run = command.kind === "status" ? threadCoven?.run : null;
        notice(
          `${coven.name} · revision ${coven.revision}`,
          run != null && run.covenId === coven.id
            ? describeRun(run)
            : `${describeCovenRoles(coven)}${command.kind === "status" ? "\nNo run yet" : ""}`,
        );
        break;
      }
      case "change": {
        const coven = resolve(command.name);
        if (coven !== null) void change(coven);
        break;
      }
      case "off":
        void off();
        break;
      case "edit": {
        const coven = resolve(command.name);
        if (coven !== null) void edit(coven);
        break;
      }
      case "build-edit": {
        const coven = resolve(command.name);
        if (coven !== null) build(`Revise the ${coven.name} coven.`, coven.id);
        break;
      }
      case "export": {
        const coven = resolve(command.name);
        if (coven === null) break;
        void withSource(coven, (source) => {
          writeTextToClipboard(source).then(
            () => notice(`Copied ${coven.name}`, "The Markdown definition is on your clipboard."),
            () => failure("Could not copy the coven", "Clipboard access was refused."),
          );
        });
        break;
      }
      case "build":
        build(command.prompt);
        break;
      case "pause":
      case "resume":
      case "stop":
        control(command.kind);
        break;
      case "approve":
      case "reject":
        decide(command.kind === "approve", command.note);
        break;
    }
    return true;
  };
}
