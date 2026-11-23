import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

const PXPIPE_STATS_URL = "http://127.0.0.1:47821/api/stats.json";

const PxpipeResponse = Schema.Struct({
  summary: Schema.Struct({
    baselineTokensTotal: Schema.Number,
    measuredActualTokensTotal: Schema.Number,
    baselineMeasuredEvents: Schema.Number,
    savedTokensTotal: Schema.Number,
    total: Schema.Number,
    compressed: Schema.Number,
    passthrough: Schema.Number,
  }),
});

const EMPTY_STATS = {
  available: false,
  baselineTokens: 0,
  measuredTokens: 0,
  measuredEvents: 0,
  savedTokens: 0,
  totalRequests: 0,
  compressedRequests: 0,
  passthroughRequests: 0,
};

export const readWith = (http: HttpClient.HttpClient) =>
  http.execute(HttpClientRequest.get(PXPIPE_STATS_URL)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(PxpipeResponse)),
    Effect.map(({ summary }) => ({
      available: true,
      baselineTokens: summary.baselineTokensTotal,
      measuredTokens: summary.measuredActualTokensTotal,
      measuredEvents: summary.baselineMeasuredEvents,
      savedTokens: summary.savedTokensTotal,
      totalRequests: summary.total,
      compressedRequests: summary.compressed,
      passthroughRequests: summary.passthrough,
    })),
    Effect.orElseSucceed(() => EMPTY_STATS),
  );

export const read = Effect.flatMap(HttpClient.HttpClient, readWith).pipe(
  Effect.provide(FetchHttpClient.layer),
);
