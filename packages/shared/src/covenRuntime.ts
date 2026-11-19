import type { CovenGate, CovenGateCondition, CovenGateVote } from "@t3tools/contracts";

/**
 * Pure coven run rules shared by the server engine and its tests:
 * how a failure is classified, which model candidate runs next,
 * whether a gate applies, and how its votes resolve.
 */

export type CovenFailureKind = "quota" | "transient" | "terminal";

export interface CovenFailureFacts {
  readonly lastErrorClass: string | null | undefined;
  readonly lastErrorCode?: string | null | undefined;
  readonly usageLimitResetAt?: string | null | undefined;
}

const RATE_LIMIT_CODE = /429|rate[_-]?limit|overloaded|too[_-]?many/i;

/**
 * A quota failure moves the role to its next model; a transient one retries
 * the same model; anything else stops the task and goes to the leader.
 * A plain 429 is a rate limit, not an exhausted quota, unless the provider
 * also reported when the limit resets.
 */
export function classifyCovenFailure(facts: CovenFailureFacts): CovenFailureKind {
  switch (facts.lastErrorClass) {
    case "usage_limit": {
      if (facts.usageLimitResetAt) return "quota";
      return facts.lastErrorCode && RATE_LIMIT_CODE.test(facts.lastErrorCode)
        ? "transient"
        : "quota";
    }
    case "transport_error":
    case "provider_error":
      return "transient";
    default:
      return "terminal";
  }
}

type CovenCooldownLike = {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly resetAt: string | null;
};

export function isCoolingDown(
  candidate: { readonly providerInstanceId: string; readonly modelId: string },
  cooldowns: ReadonlyArray<CovenCooldownLike>,
  nowMs: number,
): boolean {
  return cooldowns.some(
    (cooldown) =>
      cooldown.providerInstanceId === candidate.providerInstanceId &&
      cooldown.modelId === candidate.modelId &&
      (cooldown.resetAt === null || Date.parse(cooldown.resetAt) > nowMs),
  );
}

/** The first candidate at or after `fromIndex` that isn't cooling down, or null. */
export function pickCovenCandidate(
  candidates: ReadonlyArray<{ readonly providerInstanceId: string; readonly modelId: string }>,
  fromIndex: number,
  cooldowns: ReadonlyArray<CovenCooldownLike>,
  nowMs: number,
): number | null {
  for (let index = Math.max(0, fromIndex); index < candidates.length; index++) {
    if (!isCoolingDown(candidates[index]!, cooldowns, nowMs)) return index;
  }
  return null;
}

/** When a quota failure gives no reset time, the model rests this long. */
export const COVEN_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export interface CovenGateContext {
  readonly codeChanged: boolean;
  readonly tags: ReadonlyArray<string>;
  readonly changedPaths: ReadonlyArray<string>;
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesCovenGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.\//, ""));
}

function covenConditionHolds(
  condition: CovenGateCondition | undefined,
  context: CovenGateContext,
): boolean {
  if (condition === undefined) return true;
  switch (condition.kind) {
    case "always":
      return true;
    case "code-changed":
      return context.codeChanged;
    case "task-tag":
      return condition.tags.some((tag) => context.tags.includes(tag));
    case "path-match":
      return context.changedPaths.some((path) =>
        condition.globs.some((glob) => matchesCovenGlob(glob, path)),
      );
  }
}

/** Gates that must pass at this point of a run. */
export function applicableCovenGates(
  gates: ReadonlyArray<CovenGate>,
  trigger: CovenGate["on"],
  context: CovenGateContext,
): ReadonlyArray<CovenGate> {
  return gates.filter((gate) => gate.on === trigger && covenConditionHolds(gate.when, context));
}

/** Roles whose votes count for a gate. Test, artifact and human gates have none. */
export function covenGateElectorate(gate: CovenGate): ReadonlyArray<string> {
  switch (gate.type) {
    case "consensus":
      return gate.voterRoleIds;
    case "review":
      return gate.reviewerRoleIds;
    default:
      return [];
  }
}

export type CovenGateOutcome =
  | { readonly kind: "pending"; readonly waitingOn: ReadonlyArray<string> }
  | { readonly kind: "passed"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "tie"; readonly detail: string };

/** Latest vote per role; a role may change its mind within a round. */
function latestVotes(votes: ReadonlyArray<CovenGateVote>): Map<string, CovenGateVote> {
  const byRole = new Map<string, CovenGateVote>();
  for (const vote of votes) byRole.set(vote.roleId, vote);
  return byRole;
}

/**
 * Resolves a voting gate (consensus or review) from the votes cast so far.
 * Evidence gates (test, artifact) pass on one approving vote from the leader
 * and human gates are decided by the user, so both resolve elsewhere.
 */
export function evaluateCovenGate(
  gate: CovenGate,
  votes: ReadonlyArray<CovenGateVote>,
): CovenGateOutcome {
  const byRole = latestVotes(votes);
  if (gate.type === "review") {
    const reviewers = gate.reviewerRoleIds;
    const needed = Math.min(gate.minimumApprovals ?? reviewers.length, reviewers.length);
    const cast = reviewers.flatMap((roleId) => {
      const vote = byRole.get(roleId);
      return vote === undefined ? [] : [vote];
    });
    const approvals = cast.filter((vote) => vote.decision === "approve").length;
    if (approvals >= needed) {
      return { kind: "passed", detail: `${approvals} of ${reviewers.length} reviewers approved.` };
    }
    const outstanding = reviewers.filter((roleId) => !byRole.has(roleId));
    if (approvals + outstanding.length < needed) {
      const rejections = cast.filter((vote) => vote.decision === "reject");
      return {
        kind: "failed",
        detail: `Needed ${needed} approvals; got ${approvals}. ${rejections
          .map((vote) => `${vote.roleId}: ${vote.rationale}`)
          .join(" ")}`.trim(),
      };
    }
    return { kind: "pending", waitingOn: outstanding };
  }
  if (gate.type !== "consensus") {
    return { kind: "pending", waitingOn: [] };
  }

  const voters = gate.voterRoleIds;
  const veto = (gate.vetoRoleIds ?? []).find((roleId) => byRole.get(roleId)?.decision === "reject");
  if (veto !== undefined) {
    return {
      kind: "failed",
      detail: `Vetoed by ${veto}: ${byRole.get(veto)!.rationale}`,
    };
  }
  const outstanding = voters.filter((roleId) => !byRole.has(roleId));
  const cast = voters.flatMap((roleId) => {
    const vote = byRole.get(roleId);
    return vote === undefined ? [] : [vote];
  });
  const quorum = Math.min(gate.quorum ?? 0, voters.length);
  const excludeAbstentions = gate.abstentions === "exclude";
  const approvals = cast.filter((vote) => vote.decision === "approve").length;
  const rejections = cast.filter((vote) => vote.decision === "reject").length;
  const abstentions = cast.length - approvals - rejections;
  const counted =
    (excludeAbstentions ? cast.length - abstentions : cast.length) + outstanding.length;

  const required = (() => {
    switch (gate.decision.kind) {
      case "unanimous":
        return counted;
      case "majority":
        return Math.floor(counted / 2) + 1;
      case "k-of-n":
        return Math.min(gate.decision.k ?? voters.length, voters.length);
    }
  })();

  // Every vote is in, or the result can no longer change.
  const settled = outstanding.length === 0;
  if (
    cast.length >= quorum &&
    approvals >= required &&
    (settled || gate.decision.kind !== "unanimous")
  ) {
    return { kind: "passed", detail: `${approvals} of ${voters.length} voters approved.` };
  }
  if (approvals + outstanding.length < required) {
    if (settled && gate.decision.kind === "majority" && approvals === rejections && counted > 0) {
      return { kind: "tie", detail: `Tied ${approvals} to ${rejections}.` };
    }
    return {
      kind: "failed",
      detail: `Needed ${required} approvals; got ${approvals} (${rejections} against, ${abstentions} abstained).`,
    };
  }
  if (settled && cast.length < quorum) {
    return { kind: "failed", detail: `Only ${cast.length} votes; quorum is ${quorum}.` };
  }
  return { kind: "pending", waitingOn: outstanding };
}
