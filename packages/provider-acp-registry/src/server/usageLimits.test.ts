import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import {
  checkAcpRegistryUsageLimits,
  clinePassUsageToLimits,
  zaiUsageToLimits,
  type ClinePassUsageResponse,
  type ZaiUsageResponse,
} from "./usageLimits.ts";

const CHECKED_AT = "2026-11-18T12:00:00.000Z";

describe("clinePassUsageToLimits", () => {
  it("maps the plan usage-limits windows", () => {
    const response = {
      data: {
        limits: [
          { type: "five_hour", percentUsed: 100, resetsAt: "2026-11-18T18:54:23.689306739Z" },
          { type: "weekly", percentUsed: 40, resetsAt: "2026-11-23T18:54:23.689306739Z" },
          { type: "monthly", percentUsed: 20, resetsAt: "2026-12-18T18:54:23.689306739Z" },
        ],
      },
    } as unknown as typeof ClinePassUsageResponse.Type;
    const limits = clinePassUsageToLimits(response.data.limits, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent: 100,
        resetsAt: "2026-11-18T18:54:23.689306739Z",
      },
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: "2026-11-23T18:54:23.689306739Z" },
      { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 20, resetsAt: "2026-12-18T18:54:23.689306739Z" },
    ]);
  });

  it("keeps unknown limit types as other windows and clamps percentages", () => {
    const response = {
      data: { limits: [{ type: "bonus", percentUsed: 140, resetsAt: null }] },
    } as unknown as typeof ClinePassUsageResponse.Type;
    const limits = clinePassUsageToLimits(response.data.limits, CHECKED_AT);
    expect(limits.windows).toEqual([{ id: "bonus", kind: "other", label: "bonus", usedPercent: 100 }]);
  });
});

describe("zaiUsageToLimits", () => {
  it("maps token quota windows by duration", () => {
    const response = {
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 42,
            nextResetTime: "2026-11-18T17:00:00Z",
          },
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 10,
            nextResetTime: "2026-11-25T00:00:00Z",
          },
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            percentage: 55,
            nextResetTime: "2026-12-18T00:00:00Z",
          },
        ],
      },
    } as unknown as typeof ZaiUsageResponse.Type;
    const limits = zaiUsageToLimits(response.data.limits, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "TOKENS_LIMIT:session",
        kind: "session",
        label: "5-hour",
        usedPercent: 42,
        resetsAt: "2026-11-18T17:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "TOKENS_LIMIT:weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 10,
        resetsAt: "2026-11-25T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("orders windows by reset time when durations are unusable", () => {
    const response = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 8, nextResetTime: "2026-11-25T00:00:00Z" },
          { type: "TOKENS_LIMIT", percentage: 90, nextResetTime: 1797734400000 },
        ],
      },
    } as unknown as typeof ZaiUsageResponse.Type;
    const limits = zaiUsageToLimits(response.data.limits, CHECKED_AT);
    expect(limits.windows.map((window) => window.kind)).toEqual(["session", "weekly"]);
    expect(limits.windows.map((window) => window.usedPercent)).toEqual([8, 90]);
  });

  it("reports no windows without token limits", () => {
    const response = {
      data: { limits: [{ type: "TIME_LIMIT", percentage: 55 }] },
    } as unknown as typeof ZaiUsageResponse.Type;
    const limits = zaiUsageToLimits(response.data.limits, CHECKED_AT);
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toBeUndefined();
  });
});

describe("checkAcpRegistryUsageLimits", () => {
  it("skips an expired ClinePass provider token and succeeds with a fresh fallback token", async () => {
    const seenAuth: string[] = [];
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clineHome = yield* fs.makeTempDirectoryScoped();
      const settingsDir = path.join(clineHome, "data", "settings");
      yield* fs.makeDirectory(settingsDir, { recursive: true });
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* fs.writeFileString(
        path.join(settingsDir, "providers.json"),
        JSON.stringify({
          lastUsedProvider: "cline",
          providers: {
            "cline-pass": {
              settings: { auth: { accessToken: "expired-token", expiresAt: now - 60_000 } },
            },
            cline: {
              settings: { auth: { accessToken: "fresh-token", expiresAt: now + 60_000 } },
            },
          },
        }),
      );
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          seenAuth.push(request.headers.authorization ?? "");
          if (request.headers.authorization === "Bearer fresh-token") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: { limits: [{ type: "five_hour", percentUsed: 12 }] },
              }),
            );
          }
          return HttpClientResponse.fromWeb(request, Response.json({ error: "Unauthorized" }, { status: 401 }));
        }),
      );
      return yield* checkAcpRegistryUsageLimits({
        agentId: "cline",
        environment: { CLINE_HOME: clineHome, CLINE_PROVIDER: "cline-pass" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

    const limits = await Effect.runPromise(program);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 12 }]);
    expect(seenAuth).toEqual(["Bearer fresh-token"]);
  });
});
