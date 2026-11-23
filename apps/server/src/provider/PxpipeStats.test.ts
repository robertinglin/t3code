import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readWith } from "./PxpipeStats.ts";

it.effect("returns only aggregate pxpipe savings", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            summary: {
              baselineTokensTotal: 5000,
              measuredActualTokensTotal: 3200,
              baselineMeasuredEvents: 12,
              savedTokensTotal: 1800,
              total: 20,
              compressed: 12,
              passthrough: 8,
              byCwd: { "/private/project": 1234 },
              systemShaHist: { secretPromptHash: 2 },
            },
          }),
        );
      }),
    );

    assert.deepStrictEqual(yield* readWith(http), {
      available: true,
      baselineTokens: 5000,
      measuredTokens: 3200,
      measuredEvents: 12,
      savedTokens: 1800,
      totalRequests: 20,
      compressedRequests: 12,
      passthroughRequests: 8,
    });
    assert.deepStrictEqual(requests, ["http://127.0.0.1:47821/api/stats.json"]);
  }),
);

it.effect("reports unavailable when pxpipe stats cannot be read", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ error: "offline" }, { status: 503 })),
      ),
    );
    assert.deepStrictEqual(yield* readWith(http), {
      available: false,
      baselineTokens: 0,
      measuredTokens: 0,
      measuredEvents: 0,
      savedTokens: 0,
      totalRequests: 0,
      compressedRequests: 0,
      passthroughRequests: 0,
    });
  }),
);
