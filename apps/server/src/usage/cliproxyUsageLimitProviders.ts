import { ProviderDriverKind, UsageLimitSourceError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import type { HubProvider } from "./cliproxyApi.ts";

const ClinePassLimit = Schema.Struct({
  type: Schema.String,
  percentUsed: Schema.Number,
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const ClinePassUsageLimits = Schema.Struct({
  data: Schema.Struct({ limits: Schema.Array(ClinePassLimit) }),
});
const decodeClinePassUsage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClinePassUsageLimits),
);
const clinePassWindowKinds: Record<
  string,
  { kind: "session" | "weekly" | "monthly"; label: string }
> = {
  five_hour: { kind: "session", label: "5-hour" },
  weekly: { kind: "weekly", label: "Weekly" },
  monthly: { kind: "monthly", label: "Monthly" },
};

const ZaiLimit = Schema.Struct({
  type: Schema.String,
  unit: Schema.optional(Schema.Number),
  number: Schema.optional(Schema.Number),
  usage: Schema.optional(Schema.Number),
  currentValue: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  percentage: Schema.optional(Schema.Number),
  nextResetTime: Schema.optional(Schema.NullOr(Schema.Number)),
});
const ZaiUsageResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Struct({ limits: Schema.Array(ZaiLimit) }),
  success: Schema.Boolean,
});
const decodeZaiUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ZaiUsageResponse));

const CLINEPASS_USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const listedIdentity = (account: Parameters<HubProvider["header"]>[0]) => ({
  ...(account.email ? { email: account.email } : {}),
  ...(account.id_token?.chatgpt_account_id?.trim()
    ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
    : {}),
});

export const CLINEPASS_HUB: HubProvider = {
  driver: ProviderDriverKind.make("clinepass"),
  header: () => ({
    Authorization: "Bearer $TOKEN$",
    Accept: "application/json",
  }),
  read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
    const usage = yield* decodeClinePassUsage(yield* call(CLINEPASS_USAGE_URL));
    const windows = usage.data.limits.flatMap((limit) => {
      const presentation = clinePassWindowKinds[limit.type];
      if (!presentation) return [];
      return [
        {
          id: limit.type,
          ...presentation,
          usedPercent: limit.percentUsed,
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
        },
      ];
    });
    return {
      ...listedIdentity(account),
      plan: "ClinePass",
      usageLimits: makeUsageLimits({ checkedAt, windows }),
    };
  }),
};

export const ZAI_HUB: HubProvider = {
  driver: ProviderDriverKind.make("zai"),
  header: () => ({
    Authorization: "Bearer $TOKEN$",
    Accept: "application/json",
  }),
  read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
    const response = yield* decodeZaiUsage(yield* call(ZAI_USAGE_URL));
    if (!response.success) {
      return yield* new UsageLimitSourceError({ detail: "ZAI usage request failed." });
    }
    const windows: Array<{
      id: string;
      kind: "session" | "weekly";
      label: string;
      usedPercent: number;
      resetsAt?: string;
      windowDurationMins?: number;
    }> = [];
    for (const limit of response.data.limits) {
      if (limit.type !== "TOKENS_LIMIT" || typeof limit.percentage !== "number") continue;
      if (limit.unit === 3 && limit.number === 5) {
        windows.push({
          id: "session",
          kind: "session",
          label: "5-hour",
          usedPercent: limit.percentage,
          ...(limit.nextResetTime != null
            ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(limit.nextResetTime)) }
            : {}),
          windowDurationMins: 300,
        });
      } else if (limit.unit === 6 && (limit.number === 1 || limit.number === 7)) {
        windows.push({
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: limit.percentage,
          ...(limit.nextResetTime != null
            ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(limit.nextResetTime)) }
            : {}),
          windowDurationMins: 10080,
        });
      }
    }
    return {
      ...listedIdentity(account),
      plan: "GLM Coding Plan",
      usageLimits: makeUsageLimits({ checkedAt, windows }),
    };
  }),
};
