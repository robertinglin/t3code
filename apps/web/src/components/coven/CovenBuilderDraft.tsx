import type { CovenDraft, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseCovenSource } from "@t3tools/shared/covenDefinition";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openCovenEditor } from "./CovenEditorDialog";
import { reportCovenFailure } from "./useCovenActions";

/** The builder draft this thread edits, live, or null when it is not a builder thread. */
export function useBuilderDraft(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): CovenDraft | null {
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

export function BuilderDraftPanel({
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
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-xs">
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
