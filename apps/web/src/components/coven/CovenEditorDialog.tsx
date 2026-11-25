import type {
  CovenDefinition,
  CovenDetail,
  CovenGate,
  CovenId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { parseCovenSource } from "@t3tools/shared/covenDefinition";
import {
  mergeCovenSources,
  resolveCovenMerge,
  type CovenConflictChoice,
  type CovenMergeResult,
} from "@t3tools/shared/covenMerge";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { m, type MessageResolver } from "~/i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { CovenMergePanel } from "./CovenMergePanel";
import { describeCovenCandidate, useCovenProviders } from "./useCovenModelCatalog";
import { covenFailureMessage, isCovenConflict, reportCovenFailure } from "./useCovenActions";

interface IncomingSource {
  readonly source: string;
  readonly from: "builder" | "saved";
  readonly version?: number | undefined;
  readonly revision?: number | undefined;
}

interface PendingMerge {
  readonly incoming: IncomingSource;
  readonly result: CovenMergeResult;
  readonly choices: ReadonlyArray<CovenConflictChoice | undefined>;
}

export interface CovenEditorRequest {
  readonly environmentId: EnvironmentId;
  readonly source: string;
  /** Revision the source was read at; omitted for a new coven. */
  readonly expectedRevision?: number | undefined;
  /** Saved coven being edited; enables the History tab. */
  readonly covenId?: CovenId | undefined;
  /** Binds the saved coven to this thread when set. */
  readonly bindThreadId?: ThreadId | undefined;
  /** Edits a builder draft instead of saving a revision. */
  readonly draft?: { readonly id: string; readonly version: number } | undefined;
}

const useEditorRequest = create<{ request: CovenEditorRequest | null; opened: number }>(() => ({
  request: null,
  opened: 0,
}));

export function openCovenEditor(request: CovenEditorRequest) {
  useEditorRequest.setState((state) => ({ request, opened: state.opened + 1 }));
}

function closeCovenEditor() {
  useEditorRequest.setState({ request: null });
}

export function CovenEditorDialogHost() {
  const request = useEditorRequest((state) => state.request);
  const opened = useEditorRequest((state) => state.opened);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops a pending editor request when the host unmounts so it does not reopen later
  useEffect(() => () => closeCovenEditor(), []);
  return request ? <CovenEditorDialog key={opened} request={request} /> : null;
}

type EditorTab = "roles" | "governance" | "markdown" | "history";

function isEditorTab(value: unknown): value is EditorTab {
  return value === "roles" || value === "governance" || value === "markdown" || value === "history";
}

function CovenEditorDialog({ request }: { readonly request: CovenEditorRequest }) {
  const gt = useGT();
  const [source, setSource] = useState(request.source);
  // Text the current edits started from; the common ancestor for a three-way merge.
  const [baseSource, setBaseSource] = useState(request.source);
  const [expectedRevision, setExpectedRevision] = useState(request.expectedRevision);
  const [merge, setMerge] = useState<PendingMerge | null>(null);
  const [draftVersion, setDraftVersion] = useState(request.draft?.version ?? null);
  const [tab, setTab] = useState<EditorTab>("roles");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState<CovenDetail["revisions"] | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const parsed = parseCovenSource(source);
  const saveCoven = useAtomCommand(serverEnvironment.saveCoven, { label: "coven save" });
  const setThreadCoven = useAtomCommand(serverEnvironment.setThreadCoven, {
    label: "coven bind thread",
  });
  const updateCovenDraft = useAtomCommand(serverEnvironment.updateCovenDraft, {
    label: "coven draft update",
  });
  const loadCoven = useAtomCommand(serverEnvironment.loadCoven, { label: "coven load" });
  const loadCovenRevision = useAtomCommand(serverEnvironment.loadCovenRevision, {
    label: "coven load revision",
  });
  const liveDraft = useEnvironmentQuery(
    request.draft === undefined
      ? null
      : serverEnvironment.covenDraftLive({
          environmentId: request.environmentId,
          input: { draftId: request.draft.id },
        }),
  ).data?.draft;
  const isDraft = request.draft !== undefined;
  const isNew = !isDraft && request.expectedRevision === undefined;
  const draftMovedOn =
    isDraft && liveDraft != null && draftVersion !== null && liveDraft.version !== draftVersion;

  const acceptIncoming = (incoming: IncomingSource, merged: string) => {
    setSource(merged);
    setBaseSource(incoming.source);
    if (incoming.version !== undefined) setDraftVersion(incoming.version);
    if (incoming.revision !== undefined) setExpectedRevision(incoming.revision);
    setMerge(null);
    setConflict(false);
    setSaveError(null);
  };

  const startMerge = (incoming: IncomingSource) => {
    const result = mergeCovenSources(baseSource, source, incoming.source);
    if (result.conflictCount === 0) {
      acceptIncoming(incoming, resolveCovenMerge(result, []));
      if (source !== baseSource) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title:
              incoming.from === "builder"
                ? m(msg("Merged the builder's changes with yours"))
                : m(msg("Merged the saved changes with yours")),
          }),
        );
      }
      return;
    }
    setMerge({ incoming, result, choices: [] });
  };

  const mergeLatestDraft = () => {
    if (liveDraft == null) return;
    startMerge({ source: liveDraft.source, from: "builder", version: liveDraft.version });
  };

  const mergeLatestSaved = async () => {
    if (request.covenId === undefined) return;
    const latest = await loadCoven({
      environmentId: request.environmentId,
      input: { covenId: request.covenId },
    });
    if (latest._tag === "Failure") {
      reportCovenFailure(m(msg("Could not load the latest revision")), latest);
      return;
    }
    startMerge({
      source: latest.value.source,
      from: "saved",
      revision: latest.value.summary.revision,
    });
  };

  const openHistory = async () => {
    setTab("history");
    if (request.covenId === undefined || history !== null) return;
    const result = await loadCoven({
      environmentId: request.environmentId,
      input: { covenId: request.covenId },
    });
    if (result._tag === "Failure") {
      reportCovenFailure(m(msg("Could not load the coven history")), result);
      return;
    }
    setHistory([...result.value.revisions].toSorted((a, b) => b.revision - a.revision));
  };

  const restore = async (revision: number) => {
    if (request.covenId === undefined) return;
    const result = await loadCovenRevision({
      environmentId: request.environmentId,
      input: { covenId: request.covenId, revision },
    });
    if (result._tag === "Failure") {
      reportCovenFailure(m(msg("Could not load that revision")), result);
      return;
    }
    setSource(result.value.source);
    setRestoredFrom(revision);
    setTab("markdown");
  };

  const saveDraft = async () => {
    if (request.draft === undefined || draftVersion === null) return;
    const result = await updateCovenDraft({
      environmentId: request.environmentId,
      input: { draftId: request.draft.id, source, expectedVersion: draftVersion },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (isCovenConflict(result)) {
        setConflict(true);
        setSaveError(m(msg("The builder changed the draft while you were editing.")));
        mergeLatestDraft();
      } else {
        setSaveError(covenFailureMessage(result));
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: m(msg("Draft updated · version {version}", { version: result.value.version })),
      }),
    );
    closeCovenEditor();
  };

  const save = async () => {
    if (!parsed.ok || saving) return;
    setSaving(true);
    setSaveError(null);
    if (isDraft) {
      await saveDraft();
      return;
    }
    const result = await saveCoven({
      environmentId: request.environmentId,
      input: { source, expectedRevision },
    });
    if (result._tag === "Failure") {
      setSaving(false);
      if (isCovenConflict(result) && request.covenId !== undefined) {
        setConflict(true);
        setSaveError(m(msg("Someone saved a newer revision while you were editing.")));
        await mergeLatestSaved();
      } else {
        setSaveError(covenFailureMessage(result));
      }
      return;
    }
    const saved = result.value.summary;
    if (request.bindThreadId !== undefined) {
      reportCovenFailure(
        m(msg("Saved, but could not use the coven here")),
        await setThreadCoven({
          environmentId: request.environmentId,
          input: { threadId: request.bindThreadId, covenId: saved.id },
        }),
      );
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: m(
          msg("Saved {name} · revision {revision}", { name: saved.name, revision: saved.revision }),
        ),
      }),
    );
    closeCovenEditor();
  };

  const title = isDraft ? gt("Edit coven draft") : isNew ? gt("New coven") : gt("Edit coven");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeCovenEditor();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isDraft
              ? gt(
                  "Your edits and the builder's go to the same draft. Saving the coven itself happens from the sidebar.",
                )
              : gt(
                  "Roles, ordered model chains and limits live in the front matter; mission and role instructions live in the Markdown below it. Saving creates a new revision.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <ToggleGroup
              aria-label={gt("Coven editor view")}
              value={[tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "history") void openHistory();
                else if (isEditorTab(value)) setTab(value);
              }}
            >
              <Toggle value="roles">
                <T>Roles</T>
              </Toggle>
              <Toggle value="governance">
                <T>Governance</T>
              </Toggle>
              <Toggle value="markdown">
                <T>Markdown</T>
              </Toggle>
              {request.covenId === undefined ? null : (
                <Toggle value="history">
                  <T>History</T>
                </Toggle>
              )}
            </ToggleGroup>
            {draftMovedOn && !conflict && merge === null ? (
              <p className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
                <span>
                  {liveDraft?.lastChangeSummary
                    ? gt("The builder updated the draft to version {version}: {summary}", {
                        version: liveDraft.version,
                        summary: liveDraft.lastChangeSummary,
                      })
                    : gt("The builder updated the draft to version {version}.", {
                        version: liveDraft?.version ?? "",
                      })}
                </span>
                <Button size="xs" variant="outline" onClick={mergeLatestDraft}>
                  {source === baseSource ? gt("Load latest") : gt("Merge with my edits")}
                </Button>
              </p>
            ) : null}
            {merge !== null ? (
              <CovenMergePanel
                result={merge.result}
                choices={merge.choices}
                theirsLabel={
                  merge.incoming.from === "builder" ? gt("Builder's version") : gt("Saved version")
                }
                onChoose={(index, choice) =>
                  setMerge({
                    ...merge,
                    choices: merge.result.chunks
                      .filter((chunk) => chunk.kind === "conflict")
                      .map((_, at) => (at === index ? choice : merge.choices[at])),
                  })
                }
                onApply={() =>
                  acceptIncoming(merge.incoming, resolveCovenMerge(merge.result, merge.choices))
                }
                onCancel={() => setMerge(null)}
              />
            ) : tab === "markdown" ? (
              <>
                {restoredFrom === null ? null : (
                  <p className="text-muted-foreground text-xs">
                    <T>
                      Restored from revision <Var>{restoredFrom}</Var>. Saving makes it the newest
                      revision.
                    </T>
                  </p>
                )}
                <Textarea
                  aria-label={gt("Coven definition")}
                  className="min-h-96"
                  spellCheck={false}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
              </>
            ) : tab === "history" ? (
              <CovenHistory
                revisions={history}
                current={expectedRevision}
                onRestore={(revision) => void restore(revision)}
              />
            ) : parsed.ok ? (
              tab === "roles" ? (
                <CovenRolesView
                  definition={parsed.definition}
                  environmentId={request.environmentId}
                />
              ) : (
                <CovenGovernanceView definition={parsed.definition} />
              )
            ) : (
              <p className="text-muted-foreground text-xs">
                <T>Fix the problems below in the Markdown tab to see this view.</T>
              </p>
            )}
            {parsed.ok ? null : (
              <ul className="flex flex-col gap-1 text-destructive-foreground text-xs" role="alert">
                {parsed.issues.slice(0, 8).map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    {issue.path ? <span className="font-mono">{issue.path}: </span> : null}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {saveError ? (
              <p
                className="flex items-center justify-between gap-2 text-destructive-foreground text-xs"
                role="alert"
              >
                <span>{saveError}</span>
                {conflict && merge === null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => (isDraft ? mergeLatestDraft() : void mergeLatestSaved())}
                  >
                    <T>Merge with my edits</T>
                  </Button>
                ) : null}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={closeCovenEditor}>
            <T>Cancel</T>
          </Button>
          <Button
            type="button"
            disabled={!parsed.ok || saving || conflict || merge !== null}
            onClick={() => void save()}
          >
            {saving ? gt("Saving…") : isDraft ? gt("Update draft") : gt("Save revision")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CovenRolesView({
  definition,
  environmentId,
}: {
  readonly definition: CovenDefinition;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { frontMatter, instructions } = definition;
  const providers = useCovenProviders(environmentId);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="font-medium">{frontMatter.name}</p>
        {frontMatter.description ? (
          <p className="text-muted-foreground text-xs">{frontMatter.description}</p>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {frontMatter.roles.map((role) => (
          <li key={role.id} className="rounded-md border px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">
                {role.kind === "orchestrator"
                  ? gt("{name} · leader", { name: role.name })
                  : role.name}
              </span>
              <span className="font-mono text-muted-foreground text-xs">{role.id}</span>
            </div>
            {role.responsibility ? (
              <p className="text-muted-foreground text-xs">{role.responsibility}</p>
            ) : null}
            {role.rotation ? (
              <p className="text-xs">
                <T>
                  Takes turns in rotation{" "}
                  <span className="font-mono">
                    <Var>{role.rotation}</Var>
                  </span>
                  : each task goes to the next model.
                </T>
              </p>
            ) : role.pick === "most-headroom" ? (
              <p className="text-xs">
                <T>Uses the model with the most usage limit left.</T>
              </p>
            ) : null}
            {role.reviewedBy ? (
              <p className="text-xs">
                <T>
                  Every finished task goes to{" "}
                  <span className="font-mono">
                    <Var>{role.reviewedBy}</Var>
                  </span>{" "}
                  for review.
                </T>
              </p>
            ) : null}
            <ol className="mt-1 flex flex-col gap-0.5 text-xs">
              {role.candidates.map((candidate, index) => {
                const described = describeCovenCandidate(providers, candidate);
                return (
                  <li key={`${candidate.providerInstanceId}:${candidate.modelId}`}>
                    <span className="text-muted-foreground">
                      {role.rotation
                        ? gt("Turn {number}", { number: index + 1 })
                        : role.pick === "most-headroom"
                          ? gt("Option", { $context: "a model the role may pick from" })
                          : index === 0
                            ? gt("Primary", { $context: "the first model in a fallback chain" })
                            : gt("Fallback {number}", { number: index })}
                      :{" "}
                    </span>
                    <T>
                      <Var>{described.modelLabel}</Var>
                      <span className="text-muted-foreground">
                        {" "}
                        on <Var>{candidate.providerInstanceId}</Var>
                      </span>
                    </T>
                    {described.options.map((option) => (
                      <span key={option.id} className="text-muted-foreground">
                        {" · "}
                        {option.label}: <span className="text-foreground">{option.value}</span>
                      </span>
                    ))}
                    {described.modelKnown ? null : (
                      <p className="text-destructive-foreground">
                        <T>This provider doesn't offer that model.</T>
                      </p>
                    )}
                    {described.options
                      .filter((option) => option.problem !== null)
                      .map((option) => (
                        <p key={option.id} className="text-destructive-foreground">
                          {option.id}: {option.problem}
                        </p>
                      ))}
                  </li>
                );
              })}
            </ol>
            {instructions.roles[role.id] ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground text-xs">
                {instructions.roles[role.id]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeGate(gate: CovenGate, resolve: MessageResolver = m): string {
  switch (gate.type) {
    case "consensus": {
      const rule =
        gate.decision.kind === "k-of-n"
          ? resolve(msg("{k} of n", { k: gate.decision.k ?? "?" }))
          : gate.decision.kind;
      const voters = gate.voterRoleIds.join(", ");
      return gate.vetoRoleIds?.length
        ? resolve(
            msg("Consensus ({rule}) among {voters}, veto: {vetoes}", {
              rule,
              voters,
              vetoes: gate.vetoRoleIds.join(", "),
            }),
          )
        : resolve(msg("Consensus ({rule}) among {voters}", { rule, voters }));
    }
    case "review": {
      const reviewers = gate.reviewerRoleIds.join(", ");
      return gate.minimumApprovals
        ? resolve(
            msg("Review by {reviewers}, {count} approval(s)", {
              reviewers,
              count: gate.minimumApprovals,
            }),
          )
        : resolve(msg("Review by {reviewers}", { reviewers }));
    }
    case "test":
      return gate.evidence
        ? resolve(msg("Tests: {evidence}", { evidence: gate.evidence }))
        : resolve(msg("Tests must pass"));
    case "human-approval":
      return gate.question
        ? resolve(msg("You approve: {question}", { question: gate.question }))
        : resolve(msg("You approve"));
    case "artifact":
      return resolve(msg("Artifact: {artifact}", { artifact: gate.artifact }));
  }
}

function CovenGovernanceView({ definition }: { readonly definition: CovenDefinition }) {
  const gt = useGT();
  const messages = useMessages();
  const { governance, autonomy, limits, workspace } = definition.frontMatter;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      gt("Plan approval"),
      autonomy.initialPlanApproval ? gt("Required before work starts") : gt("Leader starts"),
    ],
    [
      gt("Scope changes"),
      autonomy.scopeChanges === "approval-required" ? gt("Need approval") : gt("Leader decides"),
    ],
    [gt("External side effects"), gt("Need approval")],
    [gt("Permissions"), gt("Never above T3's own settings")],
    [
      gt("Workspace"),
      gt("{parallelWriters}, shared writes by {sharedWrites}", {
        parallelWriters: workspace.parallelWriters,
        sharedWrites: workspace.sharedWrites,
      }),
    ],
    [gt("Active workers"), String(limits.maxActiveWorkers)],
    [gt("Delegations per run"), String(limits.maxDelegationsPerRun)],
    [gt("Review and fix rounds"), String(limits.maxReviewFixRounds)],
    [gt("Agent run limit"), gt("{minutes} min each", { minutes: limits.maxRuntimeMinutes })],
    [gt("Retries per task"), String(limits.maxTransientRetriesPerTask)],
    [gt("Leader handoffs"), String(limits.maxLeadershipTransitionsPerRun)],
  ];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="mb-1 font-medium text-xs">
          <T>Gates</T>
        </p>
        {governance.gates.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            <T>No gates. The leader decides when work is done.</T>
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {governance.gates.map((gate) => (
              <li key={gate.id}>
                <span className="font-mono">{gate.id}</span>
                <span className="text-muted-foreground"> · {gate.on}: </span>
                {describeGate(gate, messages)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs">
        <T>Edit these in the Markdown tab.</T>
      </p>
    </div>
  );
}

function CovenHistory({
  revisions,
  current,
  onRestore,
}: {
  readonly revisions: CovenDetail["revisions"] | null;
  readonly current: number | undefined;
  readonly onRestore: (revision: number) => void;
}) {
  const gt = useGT();
  if (revisions === null) {
    return (
      <p className="text-muted-foreground text-xs">
        <T>Loading…</T>
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {revisions.map((entry) => (
        <li key={entry.revision} className="flex items-center justify-between gap-2">
          <span>
            {entry.revision === current
              ? gt("Revision {revision} · current", { revision: entry.revision })
              : gt("Revision {revision}", { revision: entry.revision })}
            <span className="text-muted-foreground text-xs">
              {" "}
              · {new Date(entry.createdAt).toLocaleString()}
            </span>
          </span>
          {entry.revision === current ? null : (
            <Button size="xs" variant="outline" onClick={() => onRestore(entry.revision)}>
              <T>Restore</T>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
