import type {
  CovenId,
  CovenRunView,
  EnvironmentId,
  ModelSelection,
  ThreadCovenState,
  ThreadId,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";

import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type CovenRunAction = "pause" | "resume" | "stop";

/** The readable message of a failed command, or null when it was interrupted. */
export function covenFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}

/** True when a command failed because the thing it edited moved on (a stale version). */
export function isCovenConflict(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result);
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    (error as { reason: unknown }).reason === "conflict"
  );
}

export function reportCovenFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const description = covenFailureMessage(result);
  if (description === null) return;
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

const RUN_ACTION_FAILURE: Record<CovenRunAction, string> = {
  pause: "Could not pause the coven run",
  resume: "Could not resume the coven run",
  stop: "Could not stop the coven run",
};

const RUN_ACTION_DONE: Record<CovenRunAction, string> = {
  pause: "Coven run paused",
  resume: "Coven run resumed",
  stop: "Coven run stopped",
};

const ACTIVE_STATUSES = new Set<CovenRunView["status"]>([
  "awaiting_plan",
  "running",
  "awaiting_gate",
  "switching_provider",
  "paused",
  "recovery_required",
]);

/** A run that pause, resume, stop or a decision can still act on. */
export function isCovenRunActive(run: CovenRunView | null | undefined): boolean {
  return run != null && ACTIVE_STATUSES.has(run.status);
}

/**
 * Run control, approvals, cooldowns and the AI builder for one environment, with the toasts
 * and confirmations every entry point (sidebar, `/coven` commands) shares.
 */
export function useCovenActions(environmentId: EnvironmentId) {
  const router = useRouter();
  const controlCovenRun = useAtomCommand(serverEnvironment.controlCovenRun, {
    label: "coven run control",
  });
  const decideCoven = useAtomCommand(serverEnvironment.decideCoven, { label: "coven decide" });
  const clearCovenCooldown = useAtomCommand(serverEnvironment.clearCovenCooldown, {
    label: "coven clear cooldown",
  });
  const startCovenBuilder = useAtomCommand(serverEnvironment.startCovenBuilder, {
    label: "coven builder start",
  });

  const openThread = (threadId: ThreadId) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });

  const control = async (
    threadId: ThreadId,
    action: CovenRunAction,
  ): Promise<ThreadCovenState | null> => {
    if (action === "stop") {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        [
          "Stop this coven run?",
          "Running tasks are interrupted where the provider supports it and the rest are cancelled. Work in progress stays on disk for review. Pause instead if you want to continue later.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) return null;
    }
    const result = await controlCovenRun({ environmentId, input: { threadId, action } });
    if (result._tag === "Failure") {
      reportCovenFailure(RUN_ACTION_FAILURE[action], result);
      return null;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: RUN_ACTION_DONE[action],
        description: result.value.run?.statusReason ?? undefined,
      }),
    );
    return result.value;
  };

  const decide = async (input: {
    readonly threadId: ThreadId;
    readonly approvalId: string;
    readonly approve: boolean;
    readonly note?: string | undefined;
  }): Promise<boolean> => {
    const result = await decideCoven({
      environmentId,
      input: {
        threadId: input.threadId,
        approvalId: input.approvalId,
        approve: input.approve,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    if (result._tag === "Failure") {
      reportCovenFailure(input.approve ? "Could not approve" : "Could not reject", result);
      return false;
    }
    return true;
  };

  const clearCooldown = async (providerInstanceId: string, modelId: string) => {
    reportCovenFailure(
      "Could not clear the cooldown",
      await clearCovenCooldown({ environmentId, input: { providerInstanceId, modelId } }),
    );
  };

  /** Starts a builder chat beside `fromThreadId` and opens it. */
  const startBuilder = async (input: {
    readonly fromThreadId: ThreadId;
    readonly modelSelection: ModelSelection;
    readonly prompt: string;
    readonly baseCovenId?: CovenId | undefined;
  }): Promise<boolean> => {
    const result = await startCovenBuilder({
      environmentId,
      input: {
        fromThreadId: input.fromThreadId,
        modelSelection: input.modelSelection,
        prompt: input.prompt,
        ...(input.baseCovenId === undefined ? {} : { baseCovenId: input.baseCovenId }),
      },
    });
    if (result._tag === "Failure") {
      reportCovenFailure("Could not start the coven builder", result);
      return false;
    }
    openThread(result.value.builderThreadId);
    return true;
  };

  return { control, decide, clearCooldown, startBuilder, openThread };
}
