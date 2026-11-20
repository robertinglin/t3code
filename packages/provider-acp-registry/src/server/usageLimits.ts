import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CLINE_PASS_USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
// Bili registry launchers with subscription usage limits.
const CLINE_PASS_AGENT_IDS = new Set(["cline", "clinebot"]);
const ZAI_AGENT_IDS = new Set(["glm-acp-agent"]);

const ClinePassUsageLimit = Schema.Struct({
  type: Schema.String,
  percentUsed: Schema.Number,
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ClinePassUsageResponse = Schema.Struct({
  data: Schema.Struct({ limits: Schema.Array(ClinePassUsageLimit) }),
});
const ClineProviderEntry = Schema.Struct({
  settings: Schema.optional(
    Schema.Struct({
      auth: Schema.optional(
        Schema.Struct({
          accessToken: Schema.optional(Schema.String),
          expiresAt: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
        }),
      ),
    }),
  ),
});
const ClineProvidersFile = Schema.Struct({
  lastUsedProvider: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Record(Schema.String, ClineProviderEntry)),
});
const decodeClineProvidersFile = Schema.decodeEffect(Schema.fromJsonString(ClineProvidersFile));

const ZaiUsageLimit = Schema.Struct({
  type: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.Number),
  number: Schema.optional(Schema.Number),
  percentage: Schema.optional(Schema.Number),
  nextResetTime: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});
export const ZaiUsageResponse = Schema.Struct({
  data: Schema.Struct({ limits: Schema.Array(ZaiUsageLimit) }),
});

const CLINE_PASS_WINDOW_KINDS = new Map([
  ["five_hour", { kind: "session" as const, label: "5-hour" }],
  ["weekly", { kind: "weekly" as const, label: "Weekly" }],
  ["monthly", { kind: "monthly" as const, label: "Monthly" }],
]);
// ZAI quota units to minutes: GLM Coding Plan reports 3 = hours (number=5 -> 5h)
// and 6 = weeks (number=1 -> 7d); openclaw consumers map 1 = days, 3 = hours, 5 = minutes.
const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 7 * 1440 };

function zaiWindowKind(windowDurationMins: number) {
  if (windowDurationMins <= 1440) return "session" as const;
  if (windowDurationMins <= 8 * 1440) return "weekly" as const;
  if (windowDurationMins <= 40 * 1440) return "monthly" as const;
  return "other" as const;
}

function zaiWindowLabel(kind: ServerProviderUsageWindow["kind"], windowDurationMins: number) {
  if (kind === "weekly") return "Weekly";
  if (kind === "monthly") return "Monthly";
  if (kind === "session") {
    return windowDurationMins > 0 ? `${Math.round(windowDurationMins / 60)}-hour` : "Session";
  }
  return "Other";
}

function zaiResetTimeMs(value: string | number | undefined) {
  if (typeof value === "number") {
    // Epoch seconds stay distinguishable from epoch milliseconds until 5138.
    return value < 1e11 ? value * 1000 : value;
  }
  if (value === undefined || !value.trim()) return undefined;
  const parsed = DateTime.make(value.trim());
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
}

export function zaiUsageToLimits(
  limits: ReadonlyArray<typeof ZaiUsageLimit.Type>,
  checkedAt: string,
) {
  const entries = limits
    .filter((limit) => limit.type === "TOKENS_LIMIT")
    .map((limit) => ({
      ...limit,
      windowDurationMins:
        limit.unit !== undefined && limit.number !== undefined
          ? (ZAI_UNIT_MINUTES[limit.unit] ?? 0) * limit.number
          : 0,
      resetMs: zaiResetTimeMs(limit.nextResetTime),
    }));
  const withDuration = entries.filter((entry) => entry.windowDurationMins > 0);
  // Quotas without a usable duration are ordered by reset time: the nearest
  // reset is the session window, the next is the weekly window.
  const ordered =
    withDuration.length > 0
      ? [...withDuration].sort((a, b) => a.windowDurationMins - b.windowDurationMins)
      : entries
          .filter((entry) => entry.resetMs !== undefined)
          .sort((a, b) => (a.resetMs ?? 0) - (b.resetMs ?? 0));
  const fallbackKinds = ["session", "weekly", "monthly"] as const;
  const usedIds = new Set<string>();
  const windows = ordered.map((entry, index) => {
    const kind =
      entry.windowDurationMins > 0
        ? zaiWindowKind(entry.windowDurationMins)
        : (fallbackKinds[index] ?? "other");
    let id = `TOKENS_LIMIT:${kind}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `TOKENS_LIMIT:${kind}-${suffix++}`;
    usedIds.add(id);
    const resetsAt =
      entry.resetMs !== undefined
        ? DateTime.formatIso(DateTime.makeUnsafe(entry.resetMs))
        : undefined;
    return {
      id,
      kind,
      label: zaiWindowLabel(kind, entry.windowDurationMins),
      usedPercent: clampPercent(entry.percentage ?? 0),
      ...(resetsAt ? { resetsAt } : {}),
      ...(entry.windowDurationMins > 0 ? { windowDurationMins: entry.windowDurationMins } : {}),
    };
  });
  return makeUsageLimits({ checkedAt, windows });
}

export function clinePassUsageToLimits(
  limits: ReadonlyArray<typeof ClinePassUsageLimit.Type>,
  checkedAt: string,
) {
  const windows = limits.map((limit): ServerProviderUsageWindow => {
    const presentation = CLINE_PASS_WINDOW_KINDS.get(limit.type);
    const resetsAt = limit.resetsAt?.trim();
    return {
      id: limit.type,
      kind: presentation?.kind ?? "other",
      label: presentation?.label ?? limit.type,
      usedPercent: clampPercent(limit.percentUsed),
      ...(resetsAt ? { resetsAt } : {}),
    };
  });
  return makeUsageLimits({ checkedAt, windows });
}

function isClineTokenExpired(
  expiresAt: string | number | null | undefined,
  nowMs: number,
): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const expiresMs = zaiResetTimeMs(expiresAt);
  return expiresMs !== undefined && expiresMs <= nowMs;
}

const readClineAccessTokens = Effect.fn("readClineAccessTokens")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const home =
    environment.CLINE_HOME?.trim() ||
    path.join(
      environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".cline",
    );
  const contents = yield* fs
    .readFileString(path.join(home, "data", "settings", "providers.json"))
    .pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    );
  const file = yield* decodeClineProvidersFile(contents);
  const providers = file.providers ?? {};
  // Prefer configured/recent provider entries, but try fresh tokens before expired ones
  // so a stale `cline-pass` entry does not shadow an active `cline` token.
  const orderedEntries: Array<typeof ClineProviderEntry.Type> = [];
  const seenKeys = new Set<string>();
  const candidates = [
    environment.CLINE_PROVIDER?.trim(),
    file.lastUsedProvider?.trim(),
    "cline",
    "cline-pass",
  ];
  for (const key of candidates) {
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const entry = providers[key];
    if (entry) orderedEntries.push(entry);
  }
  for (const [key, entry] of Object.entries(providers)) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    orderedEntries.push(entry);
  }
  const fresh: string[] = [];
  const expired: string[] = [];
  const seenTokens = new Set<string>();
  for (const entry of orderedEntries) {
    const auth = entry.settings?.auth;
    const token = auth?.accessToken?.trim();
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    if (isClineTokenExpired(auth?.expiresAt, nowMs)) expired.push(token);
    else fresh.push(token);
  }
  return [...fresh, ...expired];
});

const readClinePassAccount = Effect.fn("readClinePassAccount")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "ClinePass could not read usage limits.",
  });
  const tokensOption = yield* Effect.option(
    readClineAccessTokens(environment).pipe(Effect.timeout("10 seconds")),
  );
  const tokens = Option.isSome(tokensOption) ? tokensOption.value : [];
  if (tokens.length === 0) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const client = yield* HttpClient.HttpClient;
  for (const token of tokens) {
    const result = yield* Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.get(CLINE_PASS_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
      );
      const body = yield* HttpClientResponse.schemaBodyJson(ClinePassUsageResponse)(
        yield* HttpClientResponse.filterStatusOk(response),
      );
      return clinePassUsageToLimits(body.data.limits, checkedAt);
    }).pipe(Effect.timeout("10 seconds"), Effect.option);
    if (Option.isSome(result)) return result.value;
  }
  return probeFailed;
});

const readZaiAccount = Effect.fn("readZaiAccount")(function* (environment: NodeJS.ProcessEnv) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Z.ai could not read usage limits.",
  });
  const token = environment.Z_AI_API_KEY?.trim();
  if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(ZAI_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(ZaiUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return zaiUsageToLimits(body.data.limits, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed),
  );
});

export const checkAcpRegistryUsageLimits = Effect.fn("AcpRegistryDriver.checkUsageLimits")(
  function* (input: {
    readonly agentId: string;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ServerProviderUsageLimits,
    never,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > {
    if (CLINE_PASS_AGENT_IDS.has(input.agentId))
      return yield* readClinePassAccount(input.environment);
    if (ZAI_AGENT_IDS.has(input.agentId)) return yield* readZaiAccount(input.environment);
    return makeUnavailableUsageLimits({
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      reason: "unsupported",
    });
  },
);
