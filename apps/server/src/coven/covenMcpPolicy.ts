import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as CovenService from "./CovenService.ts";

export type CovenGuard = (
  toolName: string,
) => Effect.Effect<void, OrchestratorMcpFailure, McpInvocationContext.McpInvocationContext>;

const refuseIn =
  (covens: CovenService.CovenService["Service"]): CovenGuard =>
  (toolName) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.thread === undefined) return;
      const covenScope = yield* covens
        .threadScope(scope.thread.threadId)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      if (covenScope === null) return;
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          covenScope.kind === "leader"
            ? `${toolName} is turned off in a coven thread. Delegate with coven_delegate_role instead.`
            : `${toolName} is turned off for coven workers. Do the assigned task and report back in your reply.`,
      });
    });

/**
 * Coven threads delegate only through coven tools, so the leader's role
 * chains, budgets and ledger can't be bypassed with the generic tools.
 * A host built without coven storage has no coven threads to guard.
 */
export const covenGuard = Effect.serviceOption(CovenService.CovenService).pipe(
  Effect.map((covens): CovenGuard =>
    Option.isSome(covens) ? refuseIn(covens.value) : () => Effect.void,
  ),
);
