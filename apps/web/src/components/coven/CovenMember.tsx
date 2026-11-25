import type {
  CovenCooldown,
  CovenRunView,
  CovenTask,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, CrownIcon, ExternalLinkIcon, SendIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";

import { m } from "~/i18n/messages";
import { cn, newMessageId } from "~/lib/utils";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  type CovenMember,
  type MemberActivity,
  type MemberModel,
  type MemberStatus,
  memberHue,
  memberInitials,
  memberTasks,
  memberVotes,
  gateTitle,
} from "./covenRoster.logic";

export type ModelLabeler = (providerInstanceId: string, modelId: string) => string;

const ACTIVITY_DOT: Record<MemberActivity, string> = {
  working: "bg-success animate-pulse",
  voting: "bg-warning animate-pulse",
  waiting: "bg-info",
  failed: "bg-destructive",
  done: "bg-muted-foreground/50",
  idle: "bg-muted-foreground/30",
};

const formatClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A round face on the member's own colour. Works in both themes through the hue variable. */
export function CovenAvatar(props: {
  readonly member: Pick<CovenMember, "roleId" | "name" | "kind">;
  readonly size?: "sm" | "md" | "lg";
  readonly activity?: MemberActivity | undefined;
}) {
  const size = props.size ?? "md";
  const hue = memberHue(props.member.roleId);
  // Mixing the member's hue into the theme's own background and foreground keeps the face legible in light and dark.
  const style: CSSProperties = {
    backgroundColor: `color-mix(in oklab, hsl(${hue} 75% 55%) 24%, var(--color-background))`,
    color: `color-mix(in oklab, hsl(${hue} 75% 45%) 65%, var(--color-foreground))`,
    borderColor: `color-mix(in oklab, hsl(${hue} 70% 55%) 45%, var(--color-background))`,
  };
  return (
    <span className="relative inline-flex shrink-0" aria-hidden>
      <span
        style={style}
        className={cn(
          "inline-flex items-center justify-center rounded-full font-semibold tracking-tight select-none",
          "border",
          size === "sm" && "size-6 text-3xs",
          size === "md" && "size-9 text-xs",
          size === "lg" && "size-14 text-base",
          props.activity === "working" && "ring-2 ring-success/70",
          props.activity === "voting" && "ring-2 ring-warning/70",
        )}
      >
        {memberInitials(props.member.name)}
      </span>
      {props.member.kind === "orchestrator" && size !== "sm" ? (
        <span className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full border bg-background text-warning-foreground">
          <CrownIcon className="size-2.5" />
        </span>
      ) : null}
      {props.activity && size !== "sm" ? (
        <span
          className={cn(
            "absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background",
            ACTIVITY_DOT[props.activity],
          )}
        />
      ) : null}
    </span>
  );
}

/** The model line under a member: friendly name, plus where they came from after a failover. */
function ModelLine(props: {
  readonly model: MemberModel | null;
  readonly primaryCooldown: CovenCooldown | null;
  readonly label: ModelLabeler;
}) {
  const gt = useGT();
  const { model, primaryCooldown, label } = props;
  if (model === null) return null;
  const current = label(model.providerInstanceId, model.modelId);
  if (model.failover !== null) {
    const from = label(model.failover.fromProviderInstanceId, model.failover.fromModelId);
    return (
      <span className="text-warning-foreground">
        {model.failover.until
          ? gt("On {current}. {from} is cooling down until {time}.", {
              current,
              from,
              time: formatClock(model.failover.until),
            })
          : gt("On {current}. Switched from {from}.", { current, from })}
      </span>
    );
  }
  if (primaryCooldown !== null) {
    return (
      <span className="text-warning-foreground">
        {primaryCooldown.resetAt
          ? gt("{current} is cooling down until {time}", {
              current,
              time: formatClock(primaryCooldown.resetAt),
            })
          : gt("{current} is cooling down", { current })}
      </span>
    );
  }
  return <span>{current}</span>;
}

export function MemberCard(props: {
  readonly member: CovenMember;
  readonly status: MemberStatus;
  readonly model: MemberModel | null;
  readonly primaryCooldown: CovenCooldown | null;
  readonly label: ModelLabeler;
  readonly onOpen: () => void;
}) {
  const { member, status } = props;
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`${member.name}: ${status.line}`}
        className={cn(
          "group flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors",
          "hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
          (status.activity === "working" || status.activity === "voting") &&
            "border-foreground/15 shadow-xs",
        )}
      >
        <CovenAvatar member={member} activity={status.activity} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate font-medium text-sm">{member.name}</span>
            {member.kind === "orchestrator" ? (
              <span className="shrink-0 text-muted-foreground text-xs">lead</span>
            ) : null}
          </span>
          {member.responsibility ? (
            <span className="line-clamp-2 text-muted-foreground text-xs">
              {member.responsibility}
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 pt-0.5 text-xs">
            <span className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[status.activity])} />
            <span
              className={cn(
                "truncate",
                status.activity === "failed" ? "text-destructive-foreground" : "text-foreground/80",
              )}
            >
              {status.line}
            </span>
          </span>
          <span className="truncate text-2xs text-muted-foreground">
            <ModelLine
              model={props.model}
              primaryCooldown={props.primaryCooldown}
              label={props.label}
            />
          </span>
        </span>
      </button>
    </li>
  );
}

const TASK_STATUS: Record<
  CovenTask["status"],
  { label: string; variant: "success" | "warning" | "error" | "info" | "outline" }
> = {
  queued: { label: msg("Up next", { $context: "task status" }), variant: "outline" },
  running: { label: msg("Working", { $context: "task status" }), variant: "info" },
  blocked: { label: msg("Blocked", { $context: "task status" }), variant: "warning" },
  completed: { label: msg("Done", { $context: "task status" }), variant: "success" },
  failed: { label: msg("Failed", { $context: "task status" }), variant: "error" },
  cancelled: { label: msg("Cancelled", { $context: "task status" }), variant: "outline" },
  uncertain: { label: msg("Unclear", { $context: "task status" }), variant: "warning" },
};

const ATTEMPT_STATUS: Record<CovenTask["attempts"][number]["status"], string> = {
  running: "working",
  completed: "finished",
  failed: "failed",
  switched: "handed off",
  cancelled: "cancelled",
};

/** Everything one member did this run, with ways to reach them. */
export function MemberDetail(props: {
  readonly member: CovenMember;
  readonly status: MemberStatus;
  readonly model: MemberModel | null;
  readonly primaryCooldown: CovenCooldown | null;
  readonly run: CovenRunView | null;
  readonly threadRef: ScopedThreadRef;
  readonly label: ModelLabeler;
  readonly nameOf: (roleId: string) => string;
  readonly onBack: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClearCooldown: (cooldown: CovenCooldown) => void;
}) {
  const gt = useGT();
  const { member, run, threadRef } = props;
  const tasks = memberTasks(run, member.roleId);
  const votes = memberVotes(run, member.roleId);
  const childThreadId = (tasks.find((task) => task.childThreadId !== null)?.childThreadId ??
    null) as ThreadId | null;
  const parentShell = useThreadShell(threadRef);
  const cwd = parentShell?.worktreePath ?? undefined;
  const isLead = member.kind === "orchestrator";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="xs" variant="ghost" onClick={props.onBack}>
          <ArrowLeftIcon />
          <T>The coven</T>
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <CovenAvatar member={member} size="lg" activity={props.status.activity} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="font-semibold text-base leading-tight">{member.name}</h3>
          <p className="text-muted-foreground text-xs">
            {isLead ? gt("Leads the coven from this thread") : gt("Works in its own thread")}
          </p>
          <p className="flex items-center gap-1.5 text-xs">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[props.status.activity])}
            />
            {props.status.line}
          </p>
        </div>
      </div>
      {member.responsibility ? <p className="text-sm">{member.responsibility}</p> : null}

      <section className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          <T>Model</T>
        </span>
        <ModelLine
          model={props.model}
          primaryCooldown={props.primaryCooldown}
          label={props.label}
        />
        {member.candidates.length > 1 ? (
          <span className="text-muted-foreground">
            {gt("Falls back to {models}", {
              models: member.candidates
                .slice(1)
                .map((candidate) => props.label(candidate.providerInstanceId, candidate.modelId))
                .join(gt(", then ", { $context: "separator between fallback model names" })),
            })}
          </span>
        ) : null}
        {props.primaryCooldown ? (
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onClearCooldown(props.primaryCooldown!)}
            >
              {gt("Try {model} again now", {
                model: props.label(
                  props.primaryCooldown.providerInstanceId,
                  props.primaryCooldown.modelId,
                ),
              })}
            </Button>
          </div>
        ) : null}
      </section>

      {!isLead && childThreadId !== null ? (
        <section className="flex flex-col gap-2">
          <div>
            <Button size="xs" variant="outline" onClick={() => props.onOpenThread(childThreadId)}>
              <ExternalLinkIcon />
              <T>Open their thread</T>
            </Button>
          </div>
          <MessageMember
            environmentId={threadRef.environmentId}
            threadId={childThreadId}
            name={member.name}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h4 className="font-medium text-muted-foreground text-xs">
          {isLead ? gt("Handed out") : gt("Assignments")}
        </h4>
        {(isLead ? (run?.tasks ?? []) : tasks).length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {isLead ? gt("Nothing delegated yet.") : gt("Nothing assigned yet.")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(isLead ? (run?.tasks ?? []).toReversed() : tasks).map((task, index) => (
              <TaskStory
                key={task.id}
                task={task}
                defaultOpen={index === 0}
                assignee={isLead ? props.nameOf(task.roleId) : null}
                label={props.label}
                cwd={cwd}
                threadRef={threadRef}
              />
            ))}
          </ul>
        )}
      </section>

      {votes.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="font-medium text-muted-foreground text-xs">
            <T>Verdicts</T>
          </h4>
          <ul className="flex flex-col gap-2">
            {votes.map(({ round, vote }) => (
              <li
                key={`${round.id}:${vote.createdAt}`}
                className="flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{gateTitle(round)}</span>
                  <VoteBadge decision={vote.decision} />
                </span>
                {vote.rationale ? (
                  <span className="whitespace-pre-wrap text-muted-foreground">
                    {vote.rationale}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {member.instructions.trim() ? (
        <Collapsible>
          <CollapsibleTrigger className="cursor-pointer font-medium text-muted-foreground text-xs hover:text-foreground">
            <T>Their brief</T>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-2 text-sm">
              <ChatMarkdown text={member.instructions} cwd={cwd} threadRef={threadRef} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

function TaskStory(props: {
  readonly task: CovenTask;
  readonly defaultOpen: boolean;
  readonly assignee: string | null;
  readonly label: ModelLabeler;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { task } = props;
  const status = TASK_STATUS[task.status];
  const hasMore = task.result !== null || task.attempts.length > 0;
  return (
    <li className="rounded-lg border">
      <Collapsible defaultOpen={props.defaultOpen && hasMore}>
        <CollapsibleTrigger
          disabled={!hasMore}
          className="flex w-full cursor-pointer items-start justify-between gap-2 px-3 py-2 text-left text-xs disabled:cursor-default"
        >
          <span className="min-w-0">
            <span className="block font-medium">{task.title}</span>
            {props.assignee ? (
              <span className="block text-muted-foreground">
                {gt("to {assignee}", { assignee: props.assignee })}
              </span>
            ) : null}
          </span>
          <Badge variant={status.variant}>{messages(status.label)}</Badge>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            {task.result ? (
              <div className="text-sm">
                <ChatMarkdown text={task.result} cwd={props.cwd} threadRef={props.threadRef} />
              </div>
            ) : null}
            {task.attempts.length > 0 ? (
              <ol className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
                {task.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    {props.label(attempt.providerInstanceId, attempt.modelId)}{" "}
                    {ATTEMPT_STATUS[attempt.status]}
                    {attempt.failureMessage ? `: ${attempt.failureMessage}` : ""}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

export function VoteBadge(props: {
  readonly decision: "approve" | "reject" | "abstain" | "pending";
}) {
  switch (props.decision) {
    case "approve":
      return (
        <Badge variant="success">
          <T>Approve</T>
        </Badge>
      );
    case "reject":
      return (
        <Badge variant="error">
          <T>Reject</T>
        </Badge>
      );
    case "abstain":
      return (
        <Badge variant="outline">
          <T>Abstain</T>
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline">
          <T>Thinking</T>
        </Badge>
      );
  }
}

/** Sends a note straight into the member's own thread as a new turn. */
function MessageMember(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly name: string;
}) {
  const gt = useGT();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    const shell = readThreadShell(scopeThreadRef(props.environmentId, props.threadId));
    if (shell === null) {
      toastManager.add({
        type: "error",
        title: m(msg("{name}'s thread is not loaded yet.", { name: props.name })),
      });
      return;
    }
    setSending(true);
    const result = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    }).finally(() => setSending(false));
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: m(msg("Could not message {name}", { name: props.name })),
          description: String(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    setText("");
    toastManager.add({ type: "success", title: m(msg("Sent to {name}", { name: props.name })) });
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        value={text}
        placeholder={gt("Message {name}", { name: props.name })}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex justify-end">
        <Button size="xs" type="submit" disabled={sending || text.trim().length === 0}>
          <SendIcon />
          {sending ? gt("Sending…") : gt("Send")}
        </Button>
      </div>
    </form>
  );
}
