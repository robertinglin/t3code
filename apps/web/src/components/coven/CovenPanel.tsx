import type {
  CovenDefinition,
  CovenGateRound,
  CovenRunView,
  CovenSummary,
  EnvironmentId,
  ScopedThreadRef,
  CovenId,
} from "@t3tools/contracts";
import { parseCovenSource } from "@t3tools/shared/covenDefinition";
import {
  ChevronDownIcon,
  EllipsisIcon,
  PauseIcon,
  PlayIcon,
  BotIcon,
  SquareIcon,
  UsersRoundIcon,
} from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { BuilderDraftPanel, useBuilderDraft } from "./CovenBuilderDraft";
import { openCovenEditor } from "./CovenEditorDialog";
import { describeCovenCandidate, useCovenProviders } from "./useCovenModelCatalog";
import { CovenAvatar, MemberCard, MemberDetail, type ModelLabeler, VoteBadge } from "./CovenMember";
import { CovenPicker, NO_COVEN } from "./CovenPicker";
import {
  type CovenMember,
  covenMembers,
  gateBallots,
  gateElectorate,
  gateTitle,
  isRunFinished,
  memberModel,
  memberPrimaryCooldown,
  memberStatus,
  runHeadline,
} from "./covenRoster.logic";
import { isCovenRunActive, reportCovenFailure, useCovenActions } from "./useCovenActions";

const BUILDER_PROMPT = "Help me build a new coven. Ask what it should do if it is not clear.";
const RECENT_EVENT_COUNT = 3;

/** The coven bound to a thread, as a cast of members you can open up one by one. */
export function CovenPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const { environmentId, threadId } = threadRef;
  const covens =
    useEnvironmentQuery(serverEnvironment.covensLive({ environmentId, input: {} })).data?.covens ??
    [];
  const state = useEnvironmentQuery(
    serverEnvironment.threadCovenLive({ environmentId, input: { threadId } }),
  ).data;
  const thread = useThreadShell(threadRef);
  const draft = useBuilderDraft(environmentId, threadId);
  const actions = useCovenActions(environmentId);
  const setThreadCoven = useAtomCommand(serverEnvironment.setThreadCoven, {
    label: "coven change",
  });
  const clearThreadCoven = useAtomCommand(serverEnvironment.clearThreadCoven, {
    label: "coven off",
  });
  const loadCoven = useAtomCommand(serverEnvironment.loadCoven, { label: "coven load" });
  const label = useModelLabeler(environmentId);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [focusedRoleId, setFocusedRoleId] = useState<string | null>(null);

  const binding = state?.binding ?? null;
  const summary =
    binding === null ? null : (covens.find((coven) => coven.id === binding.covenId) ?? null);
  const definition = useCovenDefinition(
    environmentId,
    binding === null ? null : { covenId: binding.covenId, revision: binding.revision },
  );
  const run = state?.run && state.run.covenId === binding?.covenId ? state.run : null;
  const cooldowns = state?.cooldowns ?? [];

  const guard = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await work().finally(() => setBusy(false));
  };

  const choose = (value: string) =>
    guard(async () => {
      setSwitching(false);
      setFocusedRoleId(null);
      if (value === NO_COVEN) {
        reportCovenFailure(
          m(msg("Could not turn the coven off")),
          await clearThreadCoven({ environmentId, input: { threadId } }),
        );
      } else {
        reportCovenFailure(
          m(msg("Could not change the coven")),
          await setThreadCoven({ environmentId, input: { threadId, covenId: value } }),
        );
      }
    });

  const edit = () =>
    guard(async () => {
      if (binding === null) return;
      const result = await loadCoven({ environmentId, input: { covenId: binding.covenId } });
      if (result._tag === "Failure") {
        reportCovenFailure(m(msg("Could not load the coven")), result);
        return;
      }
      openCovenEditor({
        environmentId,
        source: result.value.source,
        expectedRevision: result.value.summary.revision,
        covenId: binding.covenId,
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

  const draftPanel =
    draft === null ? null : <BuilderDraftPanel environmentId={environmentId} draft={draft} />;

  if (binding === null) {
    return (
      <PanelScroll>
        {draftPanel}
        <div className="flex flex-col items-center gap-3 px-2 pt-6 text-center">
          <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted">
            <UsersRoundIcon className="size-6 text-muted-foreground" />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold text-base">
              <T>No coven on this thread</T>
            </h2>
            <p className="text-muted-foreground text-sm">
              <T>
                A coven is a team of agents. This thread's model leads, and the others take on work,
                judge it, and step in when a model runs out of quota.
              </T>
            </p>
          </div>
        </div>
        {covens.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="px-2 text-muted-foreground text-xs">
              <T>Bring in a saved coven</T>
            </span>
            <CovenPicker
              covens={covens}
              value={null}
              disabled={busy}
              onChoose={(value) => void choose(value)}
            />
          </div>
        ) : null}
        {thread === null ? null : (
          <div className="flex justify-center">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void buildWithAi()}>
              <BotIcon />
              <T>Build one with AI</T>
            </Button>
          </div>
        )}
      </PanelScroll>
    );
  }

  const members = covenMembers(definition, summary, run);
  const names = new Map(members.map((member) => [member.roleId, member.name]));
  const nameOf = (roleId: string) => names.get(roleId) ?? roleId;
  const focused = members.find((member) => member.roleId === focusedRoleId) ?? null;
  const describe = (member: CovenMember) => ({
    status: memberStatus(member, run, definition, nameOf),
    model: memberModel(member, run, cooldowns),
    primaryCooldown: memberPrimaryCooldown(member, cooldowns),
  });
  const clearCooldown = (cooldown: { providerInstanceId: string; modelId: string }) =>
    void actions.clearCooldown(cooldown.providerInstanceId, cooldown.modelId);
  const notesPath = run?.docsPath ? workspaceNotesPath(run) : null;

  const header = (
    <CovenHeader
      name={summary?.name ?? binding.name}
      mission={missionLine(definition, summary)}
      members={members}
      run={run}
      busy={busy}
      onControl={(action) => void guard(() => actions.control(threadId, action))}
      menu={
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label={gt("Coven options")} />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setSwitching((value) => !value)}>
              <T>Switch coven</T>
            </MenuItem>
            <MenuItem onClick={() => void edit()}>
              <T>Edit this coven</T>
            </MenuItem>
            {thread === null ? null : (
              <MenuItem onClick={() => void buildWithAi()}>
                <T>Build a new one with AI</T>
              </MenuItem>
            )}
            {notesPath ? (
              <MenuItem
                onClick={() => useRightPanelStore.getState().openFile(threadRef, notesPath)}
              >
                <T>Open run notes</T>
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem onClick={() => void choose(NO_COVEN)}>
              <T>Remove from thread</T>
            </MenuItem>
            <MenuItem
              variant="destructive"
              onClick={() =>
                void guard(() =>
                  actions.deleteCoven({ id: binding.covenId, name: summary?.name ?? binding.name }),
                )
              }
            >
              <T>Delete coven</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    />
  );

  if (focused !== null) {
    const facts = describe(focused);
    return (
      <PanelScroll>
        <MemberDetail
          member={focused}
          status={facts.status}
          model={facts.model}
          primaryCooldown={facts.primaryCooldown}
          run={run}
          threadRef={threadRef}
          label={label}
          nameOf={nameOf}
          onBack={() => setFocusedRoleId(null)}
          onOpenThread={actions.openThread}
          onClearCooldown={clearCooldown}
        />
      </PanelScroll>
    );
  }

  const activeRun = run !== null && isCovenRunActive(run);
  const latestRound = run?.gates.at(-1) ?? null;

  return (
    <PanelScroll>
      {header}
      {switching ? (
        <CovenPicker
          covens={covens}
          value={binding.covenId}
          disabled={busy}
          onChoose={(value) => void choose(value)}
        />
      ) : null}
      {draftPanel}
      {activeRun
        ? run.pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              kind={approval.kind}
              title={approval.title}
              body={approval.body}
              onDecide={(approve, note) =>
                actions.decide({
                  threadId,
                  approvalId: approval.id,
                  approve,
                  ...(note ? { note } : {}),
                })
              }
            />
          ))
        : null}
      {latestRound !== null && (latestRound.status === "open" || !isRunFinished(run)) ? (
        <JudgesPanel
          round={latestRound}
          electorate={gateElectorate(definition, latestRound.gateId)}
          members={members}
          nameOf={nameOf}
          onOpenMember={setFocusedRoleId}
        />
      ) : null}
      {run?.summary && isRunFinished(run) ? (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">{run.summary}</div>
      ) : null}
      <section className="flex flex-col gap-2" aria-label={gt("Coven members")}>
        <ul className="flex flex-col gap-2">
          {members.map((member) => {
            const facts = describe(member);
            return (
              <MemberCard
                key={member.roleId}
                member={member}
                status={facts.status}
                model={facts.model}
                primaryCooldown={facts.primaryCooldown}
                label={label}
                onOpen={() => setFocusedRoleId(member.roleId)}
              />
            );
          })}
        </ul>
      </section>
      {run !== null && run.events.length > 0 ? <Happenings run={run} /> : null}
    </PanelScroll>
  );
}

function PanelScroll(props: { readonly children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-4">{props.children}</div>
    </div>
  );
}

function CovenHeader(props: {
  readonly name: string;
  readonly mission: string | null;
  readonly members: ReadonlyArray<CovenMember>;
  readonly run: CovenRunView | null;
  readonly busy: boolean;
  readonly onControl: (action: "pause" | "resume" | "stop") => void;
  readonly menu: React.ReactNode;
}) {
  const { run } = props;
  const active = run !== null && isCovenRunActive(run);
  const working = run !== null && (run.status === "running" || run.status === "switching_provider");
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 -space-x-2 pt-0.5">
          {props.members.slice(0, 4).map((member) => (
            <CovenAvatar key={member.roleId} member={member} size="sm" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate font-semibold text-base leading-tight">{props.name}</h2>
          {props.mission ? (
            <p className="line-clamp-2 text-muted-foreground text-xs">{props.mission}</p>
          ) : null}
        </div>
        {props.menu}
      </div>
      <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              working
                ? "animate-pulse bg-success"
                : run?.status === "awaiting_plan" || run?.status === "awaiting_gate"
                  ? "bg-warning"
                  : run?.status === "failed" || run?.status === "recovery_required"
                    ? "bg-destructive"
                    : "bg-muted-foreground/40",
            )}
          />
          <span className="truncate">{runHeadline(run)}</span>
        </span>
        {active ? (
          <span className="flex shrink-0 gap-1">
            {run.status === "paused" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={props.busy}
                onClick={() => props.onControl("resume")}
              >
                <PlayIcon />
                <T>Resume</T>
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={props.busy}
                onClick={() => props.onControl("pause")}
              >
                <PauseIcon />
                <T>Pause</T>
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={() => props.onControl("stop")}
            >
              <SquareIcon />
              <T>Stop</T>
            </Button>
          </span>
        ) : null}
      </div>
    </header>
  );
}

function ApprovalCard(props: {
  readonly kind: "plan" | "gate";
  readonly title: string;
  readonly body: string;
  readonly onDecide: (approve: boolean, note: string) => Promise<boolean>;
}) {
  const gt = useGT();
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    void props.onDecide(approve, note.trim()).finally(() => setBusy(false));
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-3"
      aria-label={gt("Waiting for you")}
    >
      <span className="font-medium text-warning-foreground text-xs">
        {props.kind === "plan" ? gt("The lead wants your go-ahead on a plan") : gt("Your call")}
      </span>
      <h3 className="font-semibold text-sm">{props.title}</h3>
      {props.body ? (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/60 px-2.5 py-2 text-xs">
          {props.body}
        </div>
      ) : null}
      {noting ? (
        <Textarea
          value={note}
          rows={2}
          placeholder={gt("Add a note for the lead (optional)")}
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" disabled={busy} onClick={() => decide(true)}>
          <T>Approve</T>
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => decide(false)}>
          <T>Reject</T>
        </Button>
        {noting ? null : (
          <Button size="xs" variant="ghost" onClick={() => setNoting(true)}>
            <T>Add a note</T>
          </Button>
        )}
      </div>
    </section>
  );
}

const ROUND_OUTCOME: Record<CovenGateRound["status"], string> = {
  open: "Deliberating",
  passed: "Passed",
  failed: "Did not pass",
  escalated: "Sent to you",
};

/** A gate round as a bench of judges: each face with their verdict, reasons on demand. */
function JudgesPanel(props: {
  readonly round: CovenGateRound;
  readonly electorate: ReadonlyArray<string>;
  readonly members: ReadonlyArray<CovenMember>;
  readonly nameOf: (roleId: string) => string;
  readonly onOpenMember: (roleId: string) => void;
}) {
  const gt = useGT();
  const ballots = gateBallots(props.round, props.electorate);
  if (ballots.length === 0) return null;
  const memberFor = (roleId: string) =>
    props.members.find((member) => member.roleId === roleId) ?? {
      roleId,
      name: props.nameOf(roleId),
      kind: "worker" as const,
    };
  return (
    <section className="flex flex-col gap-2 rounded-xl border px-3 py-3" aria-label={gt("Judges")}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="truncate font-medium text-sm">{gateTitle(props.round)}</h3>
        <span className="shrink-0 text-muted-foreground text-xs">
          {ROUND_OUTCOME[props.round.status]}
        </span>
      </div>
      {props.round.detail ? (
        <p className="line-clamp-3 text-muted-foreground text-xs">{props.round.detail}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {ballots.map((ballot) => (
          <li key={ballot.roleId}>
            <Collapsible>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={gt("Open {name}", { name: props.nameOf(ballot.roleId) })}
                  onClick={() => props.onOpenMember(ballot.roleId)}
                >
                  <CovenAvatar
                    member={memberFor(ballot.roleId)}
                    size="sm"
                    activity={ballot.decision === "pending" ? "voting" : undefined}
                  />
                </button>
                <CollapsibleTrigger
                  disabled={!ballot.vote?.rationale}
                  className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 text-left text-xs disabled:cursor-default"
                >
                  <span className="flex min-w-0 items-center gap-1 truncate">
                    {props.nameOf(ballot.roleId)}
                    {ballot.vote?.rationale ? (
                      <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                    ) : null}
                  </span>
                  <VoteBadge decision={ballot.decision} />
                </CollapsibleTrigger>
              </div>
              <CollapsiblePanel>
                <p className="whitespace-pre-wrap pt-1 pb-1 pl-8 text-muted-foreground text-xs">
                  {ballot.vote?.rationale}
                </p>
              </CollapsiblePanel>
            </Collapsible>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Happenings(props: { readonly run: CovenRunView }) {
  const recent = props.run.events.slice(-RECENT_EVENT_COUNT).toReversed();
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground">
        <T>Just now</T>
        <ChevronDownIcon className="size-3" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="flex flex-col gap-1 pt-2">
          {recent.map((event) => (
            <li key={event.seq} className="flex items-baseline gap-2 text-xs">
              <span className="line-clamp-2 min-w-0 flex-1">{event.summary}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatRelativeTimeLabel(event.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function missionLine(definition: CovenDefinition | null, summary: CovenSummary | null) {
  const described = definition?.frontMatter.description ?? summary?.description;
  if (described?.trim()) return described.trim();
  const mission = definition?.instructions.mission
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  return mission ?? null;
}

/** The run notes' README relative to the workspace, when the notes live in it. */
function workspaceNotesPath(run: CovenRunView): string | null {
  const marker = `docs/coven-runs/${run.id}`;
  return run.docsPath?.replaceAll("\\", "/").endsWith(marker) ? `${marker}/README.md` : null;
}

/** The coven's definition at the bound revision, loaded once per revision. */
function useCovenDefinition(
  environmentId: EnvironmentId,
  target: { readonly covenId: CovenId; readonly revision: number } | null,
): CovenDefinition | null {
  const loadRevision = useAtomCommand(serverEnvironment.loadCovenRevision, {
    label: "coven revision",
    reportFailure: false,
  });
  const [loaded, setLoaded] = useState<{ key: string; definition: CovenDefinition } | null>(null);
  const key = target === null ? null : `${environmentId}:${target.covenId}:${target.revision}`;
  const load = useEffectEvent(
    (covenId: CovenId, revision: number, onLoaded: (definition: CovenDefinition) => void) => {
      void loadRevision({
        environmentId,
        input: { covenId, revision },
      }).then((result) => {
        if (result._tag !== "Success") return;
        const parsed = parseCovenSource(result.value.source);
        if (parsed.ok) onLoaded(parsed.definition);
      });
    },
  );
  const covenId = target?.covenId ?? null;
  const revision = target?.revision ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the immutable definition for a bound revision once; the run itself streams through threadCovenLive
  useEffect(() => {
    if (key === null || covenId === null || revision === null) return;
    let cancelled = false;
    load(covenId, revision, (definition) => {
      if (!cancelled) setLoaded({ key, definition });
    });
    return () => {
      cancelled = true;
    };
  }, [key, covenId, revision]);
  return loaded !== null && loaded.key === key ? loaded.definition : null;
}

/** Turns a provider instance and model slug into the name the model picker shows. */
function useModelLabeler(environmentId: EnvironmentId): ModelLabeler {
  const providers = useCovenProviders(environmentId);
  return (providerInstanceId, modelId) =>
    describeCovenCandidate(providers, { providerInstanceId, modelId }).modelLabel;
}
