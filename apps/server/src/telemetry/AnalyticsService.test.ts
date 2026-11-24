import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("keeps product analytics calls inert", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("test.event", { value: 1 });
    yield* analytics.recordOwners([{ source: "connect", ownerId: "owner" }], "client");
    yield* analytics.flush;
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
