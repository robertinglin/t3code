import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { UsersRoundIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { isCovenRunActive } from "./useCovenActions";

function useThreadCovenState(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : serverEnvironment.threadCovenLive({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  ).data;
}

/** The bound coven's name, for the coven tab's title. */
export function useThreadCovenName(threadRef: ScopedThreadRef | null): string | null {
  return useThreadCovenState(threadRef)?.binding?.name ?? null;
}

/** Opens the coven panel. Shown only while the thread has a coven. */
export function CovenHeaderChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const state = useThreadCovenState(threadRef);
  const binding = state?.binding ?? null;
  if (binding === null) return null;
  const run = state?.run && state.run.covenId === binding.covenId ? state.run : null;
  const needsYou = run !== null && isCovenRunActive(run) && run.pendingApprovals.length > 0;
  const working = run !== null && (run.status === "running" || run.status === "awaiting_gate");
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={
        needsYou
          ? gt("{name} needs your approval", { name: binding.name })
          : gt("Open {name}", { name: binding.name })
      }
      onClick={() => useRightPanelStore.getState().open(threadRef, "coven")}
    >
      <span className="relative inline-flex">
        <UsersRoundIcon />
        {needsYou || working ? (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
              needsYou ? "bg-warning" : "animate-pulse bg-success",
            )}
          />
        ) : null}
      </span>
      <span className="max-w-32 truncate">{binding.name}</span>
    </Button>
  );
}
