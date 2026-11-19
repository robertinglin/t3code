import type {
  CovenCooldown,
  CovenDraft,
  CovenRunView,
  CovenTask,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { parseCovenSource } from "@t3tools/shared/covenDefinition";
import { memo, useEffect, useEffectEvent, useState } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarGroup } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openCovenEditor } from "./CovenEditorDialog";
import { CovenPicker, NO_COVEN } from "./CovenPicker";
import { isCovenRunActive, reportCovenFailure, useCovenActions } from "./useCovenActions";

const RECENT_EVENT_COUNT = 5;

const RUN_STATUS_LABEL: Record<CovenRunView["status"], string> = {
  awaiting_plan: "Waiting for plan approval",
  running: "Running",
  awaiting_gate: "Waiting on a gate",
  switching_provider: "Switching provider",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  recovery_required: "Needs recovery",
};

const TASK_STATUS_LABEL: Record<CovenTask["status"], string> = {
  queued: "Queued",
  running: "Working",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  uncertain: "Uncertain",
};

const BUILDER_PROMPT = "Help me build a new coven. Ask what it should do if it is not clear.";

/** Picks the open thread's coven and shows its run. Hidden until a coven or draft exists. */
export const SidebarCovenSection = memo(function SidebarCovenSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const covens =
    useEnvironmentQuery(serverEnvironment.covensLive({ environmentId, input: {} })).data?.covens ??
    [];
  const state = useEnvironmentQuery(
    serverEnvironment.threadCovenLive({ environmentId, input: { threadId } }),
  ).data;
  const thread = useThreadShell({ environmentId, threadId });
  const draft = useBuilderDraft(environmentId, threadId);
  const setThreadCoven = useAtomCommand(serverEnvironment.setThreadCoven, {
    label: "coven change",
  });
  const clearThreadCoven = useAtomCommand(serverEnvironment.clearThreadCoven, {
    label: "coven off",
  });
  const loadCoven = useAtomCommand(serverEnvironment.loadCoven, { label: "coven load" });
  const actions = useCovenActions(environmentId);
  const [busy, setBusy] = useState(false);

  const binding = state?.binding ?? null;
  if (covens.length === 0 && binding === null && draft === null) return null;
  const active = binding === null ? null : covens.find((coven) => coven.id === binding.covenId);
  const run = state?.run ?? null;
  const cooldowns = state?.cooldowns ?? [];

  const guard = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await work().finally(() => setBusy(false));
  };

  const choose = (value: string) =>
    guard(async () => {
      if (value === NO_COVEN) {
        reportCovenFailure(
          "Could not turn the coven off",
          await clearThreadCoven({ environmentId, input: { threadId } }),
        );
      } else {
        reportCovenFailure(
          "Could not change the coven",
          await setThreadCoven({ environmentId, input: { threadId, covenId: value } }),
        );
      }
    });

  const edit = () =>
    guard(async () => {
      if (active == null) return;
      const result = await loadCoven({ environmentId, input: { covenId: active.id } });
      if (result._tag === "Failure") {
        reportCovenFailure("Could not load the coven", result);
        return;
      }
      openCovenEditor({
        environmentId,
        source: result.value.source,
        expectedRevision: result.value.summary.revision,
        covenId: active.id,
      });
    });

  const buildWithAi = () =>
    guard(async () => {
      if (thread === null) return;
      await actions.startBuilder({
        fromThreadId: threadId,
        projectId: null,
        runtimeMode: undefined,
        modelSelection: thread.modelSelection,
        prompt: BUILDER_PROMPT,
      });
    });

  return (
    <SidebarGroup>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 px-2">
          <span className="font-medium text-muted-foreground text-xs">Coven</span>
          <div className="flex items-center gap-1">
            {thread === null ? null : (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void buildWithAi()}>
                Build with AI
              </Button>
            )}
            {active ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void edit()}>
                Edit
              </Button>
            ) : null}
          </div>
        </div>
        {draft === null ? null : <BuilderDraftPanel environmentId={environmentId} draft={draft} />}
        {covens.length === 0 && binding === null ? null : (
          <CovenPicker
            covens={covens}
            value={binding?.covenId ?? null}
            disabled={busy}
            onChoose={(value) => void choose(value)}
          />
        )}
        {run !== null && run.covenId === binding?.covenId ? (
          <CovenRunPanel
            run={run}
            roleNames={new Map(active?.roles.map((role) => [role.id, role.name]) ?? [])}
            actions={actions}
            threadId={threadId}
          />
        ) : active ? (
          <ul className="flex flex-col gap-0.5 px-2 text-muted-foreground text-xs">
            {binding ? <li>Revision {binding.revision} · no run yet</li> : null}
            {active.roles.map((role) => (
              <li key={role.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {role.name}
                  {role.kind === "orchestrator" ? " · leader" : ""}
                </span>
                <span className="truncate">{role.primary.modelId}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {cooldowns.length > 0 ? (
          <CooldownList
            cooldowns={cooldowns}
            onClear={(cooldown) =>
              void actions.clearCooldown(cooldown.providerInstanceId, cooldown.modelId)
            }
          />
        ) : null}
      </div>
    </SidebarGroup>
  );
});

function CovenRunPanel({
  run,
  roleNames,
  actions,
  threadId,
}: {
  readonly run: CovenRunView;
  readonly roleNames: ReadonlyMap<string, string>;
  readonly actions: ReturnType<typeof useCovenActions>;
  readonly threadId: ThreadId;
}) {
  const [busy, setBusy] = useState(false);
  const activeRun = isCovenRunActive(run);
  const recent = run.events.slice(-RECENT_EVENT_COUNT).toReversed();

  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await work().finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1.5 px-2 text-xs">
      <div>
        <p>
          <span className="font-medium">{RUN_STATUS_LABEL[run.status]}</span>
          <span className="text-muted-foreground"> · revision {run.revision}</span>
        </p>
        {run.statusReason ? <p className="text-muted-foreground">{run.statusReason}</p> : null}
        <p className="truncate text-muted-foreground">
          Leader: {run.leader.modelId} on {run.leader.providerInstanceId}
          {run.leader.candidateIndex > 0 ? ` (fallback ${run.leader.candidateIndex})` : ""}
        </p>
      </div>
      {run.tasks.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="Coven tasks">
          {run.tasks.map((task) => (
            <CovenTaskRow
              key={task.id}
              task={task}
              roleName={roleNames.get(task.roleId) ?? task.roleId}
              onOpen={
                task.childThreadId === null
                  ? null
                  : () => actions.openThread(task.childThreadId as ThreadId)
              }
            />
          ))}
        </ul>
      ) : null}
      {activeRun
        ? run.pendingApprovals.map((approval) => (
            <div key={approval.id} className="flex flex-col gap-1 rounded-md border px-2 py-1.5">
              <p className="font-medium">
                {approval.kind === "plan" ? "Plan: " : "Gate: "}
                {approval.title}
              </p>
              {approval.body ? (
                <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">
                  {approval.body}
                </p>
              ) : null}
              <div className="flex gap-1">
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      actions.decide({ threadId, approvalId: approval.id, approve: true }),
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      actions.decide({ threadId, approvalId: approval.id, approve: false }),
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            </div>
          ))
        : null}
      {activeRun ? (
        <div className="flex gap-1">
          {run.status === "paused" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => actions.control(threadId, "resume"))}
            >
              Resume
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => actions.control(threadId, "pause"))}
            >
              Pause
            </Button>
          )}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void act(() => actions.control(threadId, "stop"))}
          >
            Stop
          </Button>
        </div>
      ) : null}
      {run.summary && !activeRun ? (
        <p className="line-clamp-3 text-muted-foreground">{run.summary}</p>
      ) : null}
      {recent.length > 0 ? (
        <ul
          className="flex flex-col gap-0.5 text-muted-foreground"
          aria-label="Recent coven activity"
        >
          {recent.map((event) => (
            <li key={event.seq} className="line-clamp-2">
              {event.summary}
            </li>
          ))}
        </ul>
      ) : null}
      {run.docsPath ? (
        <p className="break-all text-muted-foreground">
          Notes: <span className="font-mono">{run.docsPath}</span>
        </p>
      ) : null}
    </div>
  );
}

function CovenTaskRow({
  task,
  roleName,
  onOpen,
}: {
  readonly task: CovenTask;
  readonly roleName: string;
  readonly onOpen: (() => void) | null;
}) {
  const attempt = task.attempts.at(-1);
  const switched = task.attempts.filter((entry) => entry.status === "switched").length;
  const failoverHint =
    switched > 0
      ? ` · ${switched} failover${switched === 1 ? "" : "s"}`
      : task.attempts.length > 1
        ? ` · attempt ${task.attempts.length}`
        : "";
  const lastFailure = task.attempts.findLast((entry) => entry.failureMessage !== null);
  const content = (
    <>
      <span className="flex justify-between gap-2">
        <span className="truncate">
          <span className="font-medium">{roleName}</span>
          <span className="text-muted-foreground"> · {task.title}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">{TASK_STATUS_LABEL[task.status]}</span>
      </span>
      {attempt ? (
        <span className="block truncate text-muted-foreground">
          {attempt.modelId}
          {failoverHint}
        </span>
      ) : null}
      {lastFailure && task.status !== "completed" ? (
        <span className="line-clamp-2 text-destructive-foreground">
          {lastFailure.failureMessage}
        </span>
      ) : null}
    </>
  );
  return (
    <li>
      {onOpen === null ? (
        <div className="px-1 py-0.5">{content}</div>
      ) : (
        <button
          type="button"
          className="w-full cursor-pointer rounded-md px-1 py-0.5 text-left hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open ${roleName} thread: ${task.title}`}
          onClick={onOpen}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function CooldownList({
  cooldowns,
  onClear,
}: {
  readonly cooldowns: ReadonlyArray<CovenCooldown>;
  readonly onClear: (cooldown: CovenCooldown) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-2 text-xs">
      <span className="font-medium text-muted-foreground">Cooling down</span>
      <ul className="flex flex-col gap-0.5">
        {cooldowns.map((cooldown) => (
          <li
            key={`${cooldown.providerInstanceId}:${cooldown.modelId}`}
            className="flex items-center justify-between gap-2"
          >
            <span className="min-w-0">
              <span className="block truncate">
                {cooldown.modelId}
                <span className="text-muted-foreground">
                  {cooldown.resetAt
                    ? ` · until ${new Date(cooldown.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : ""}
                </span>
              </span>
              <span className="block truncate text-muted-foreground">{cooldown.reason}</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => onClear(cooldown)}>
              Clear
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The builder draft this thread edits, live, or null when it is not a builder thread. */
function useBuilderDraft(environmentId: EnvironmentId, threadId: ThreadId): CovenDraft | null {
  const loadCovenDraftForThread = useAtomCommand(serverEnvironment.loadCovenDraftForThread, {
    label: "coven draft for thread",
    reportFailure: false,
  });
  const [found, setFound] = useState<{ threadId: ThreadId; draftId: string } | null>(null);
  const lookUp = useEffectEvent((target: ThreadId, onFound: (draftId: string) => void) => {
    void loadCovenDraftForThread({ environmentId, input: { threadId: target } }).then((result) => {
      if (result._tag === "Success" && result.value.draft !== null) onFound(result.value.draft.id);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server once per thread whether it is a coven builder; the draft itself then streams through covenDraftLive
  useEffect(() => {
    let cancelled = false;
    lookUp(threadId, (draftId) => {
      if (!cancelled) setFound({ threadId, draftId });
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const draftId = found?.threadId === threadId ? found.draftId : null;
  const live = useEnvironmentQuery(
    draftId === null
      ? null
      : serverEnvironment.covenDraftLive({ environmentId, input: { draftId } }),
  ).data;
  return live?.draft ?? null;
}

function BuilderDraftPanel({
  environmentId,
  draft,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: CovenDraft;
}) {
  const saveCovenDraft = useAtomCommand(serverEnvironment.saveCovenDraft, {
    label: "coven draft save",
  });
  const [saving, setSaving] = useState(false);
  const parsed = parseCovenSource(draft.source);
  const name = parsed.ok ? parsed.definition.frontMatter.name : "Coven draft";

  const save = async () => {
    if (saving || !parsed.ok) return;
    setSaving(true);
    const result = await saveCovenDraft({ environmentId, input: { draftId: draft.id } });
    setSaving(false);
    if (result._tag === "Failure") {
      reportCovenFailure("Could not save the coven", result);
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Saved ${result.value.summary.name} · revision ${result.value.summary.revision}`,
      }),
    );
  };

  return (
    <div className="mx-2 flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs">
      <p className="flex justify-between gap-2">
        <span className="truncate font-medium">Draft: {name}</span>
        <span className="shrink-0 text-muted-foreground">v{draft.version}</span>
      </p>
      {parsed.ok ? (
        <p className="text-muted-foreground">Valid</p>
      ) : (
        <p className="text-destructive-foreground" role="alert">
          {parsed.issues.length} problem{parsed.issues.length === 1 ? "" : "s"}:{" "}
          {parsed.issues[0]?.path ? `${parsed.issues[0].path}: ` : ""}
          {parsed.issues[0]?.message}
        </p>
      )}
      {draft.lastChangeSummary ? (
        <p className="line-clamp-2 text-muted-foreground">
          Last change by {draft.lastChangeBy === "builder" ? "the builder" : "you"}:{" "}
          {draft.lastChangeSummary}
        </p>
      ) : null}
      {draft.savedRevision === null ? null : (
        <p className="text-muted-foreground">Saved as revision {draft.savedRevision}</p>
      )}
      <div className="flex gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            openCovenEditor({
              environmentId,
              source: draft.source,
              draft: { id: draft.id, version: draft.version },
            })
          }
        >
          Open draft
        </Button>
        <Button size="xs" disabled={saving || !parsed.ok} onClick={() => void save()}>
          {saving ? "Saving…" : "Save coven"}
        </Button>
      </div>
    </div>
  );
}
