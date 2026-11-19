import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { starterCovenSource, withCovenFrontMatter } from "@t3tools/shared/covenDefinition";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as CovenService from "./CovenService.ts";
import { covenGuard } from "./covenMcpPolicy.ts";
import { covenLeaderNote } from "./covenWorkerTask.ts";

const layerTest = CovenService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-coven-test-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const leader = { providerInstanceId: "codex", modelId: "gpt-5.5" };

const withWorker = (source: string) =>
  withCovenFrontMatter(source, (frontMatter) => ({
    ...frontMatter,
    roles: [
      ...(frontMatter.roles as ReadonlyArray<unknown>),
      {
        id: "tester",
        kind: "worker" as const,
        name: "Tester",
        responsibility: "Runs the tests",
        candidates: [{ providerInstanceId: "claudeAgent", modelId: "claude-opus-5-5" }],
      },
    ],
  }));

const callerScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});

it.layer(layerTest)("CovenService", (it) => {
  it.effect("saves revisions, writes the revision file, and rejects stale edits", () =>
    Effect.gen(function* () {
      const covens = yield* CovenService.CovenService;
      const source = starterCovenSource({ id: "cov_rev", name: "Revision Team", leader });

      const first = yield* covens.save({ source });
      assert.strictEqual(first.summary.revision, 1);
      assert.strictEqual(first.summary.slug, "revision-team");

      const second = yield* covens.save({ source: withWorker(first.source), expectedRevision: 1 });
      assert.strictEqual(second.summary.revision, 2);
      assert.deepStrictEqual(
        second.revisions.map((revision) => revision.revision),
        [2, 1],
      );
      assert.include(second.source, "revision: 2");

      const stale = yield* covens.save({ source, expectedRevision: 1 }).pipe(Effect.flip);
      assert.strictEqual(stale.reason, "conflict");

      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* fs.readFileString(
        path.join(config.stateDir, "covens", "cov_rev", "rev-0002.md"),
      );
      assert.strictEqual(file, second.source);
    }),
  );

  it.effect("rejects invalid definitions with issues", () =>
    Effect.gen(function* () {
      const covens = yield* CovenService.CovenService;
      const error = yield* covens.save({ source: "no front matter" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid-definition");
    }),
  );

  it.effect("binds a thread, starts one run, and scopes workers", () =>
    Effect.gen(function* () {
      const covens = yield* CovenService.CovenService;
      const saved = yield* covens.save({
        source: withWorker(starterCovenSource({ id: "cov_bind", name: "Bind Team", leader })),
      });
      const leaderThread = ThreadId.make("thread-leader");
      const workerThread = ThreadId.make("thread-worker");

      const state = yield* covens.setThread(leaderThread, saved.summary.id);
      assert.strictEqual(state.binding?.covenId, "cov_bind");
      const leaderScope = yield* covens.threadScope(leaderThread);
      assert.strictEqual(leaderScope?.kind, "leader");
      assert.isNull(yield* covens.threadScope(workerThread));

      const run = yield* covens.ensureRun(leaderThread);
      assert.isNotNull(run);
      assert.strictEqual(run!.state.status, "awaiting_plan");
      const again = yield* covens.ensureRun(leaderThread);
      assert.strictEqual(again?.id, run!.id);
      yield* covens.registerChild(workerThread, {
        runId: run!.id,
        taskId: "task-1",
        roleId: "tester",
      });
      yield* covens.updateRun(run!.id, (record) =>
        Effect.succeed({
          state: { ...record.state, delegations: record.state.delegations + 1 },
          events: [{ kind: "task.delegated", summary: "tester took task-1" }],
          result: undefined,
        }),
      );
      const view = yield* covens.threadState(leaderThread);
      assert.strictEqual(view.run?.id, run!.id);
      assert.isTrue(view.run!.events.some((event) => event.kind === "task.delegated"));
      const refusedSwitch = yield* covens.clearThread(leaderThread).pipe(Effect.flip);
      assert.strictEqual(refusedSwitch.reason, "policy-denied");

      const workerScope = yield* covens.threadScope(workerThread);
      assert.strictEqual(workerScope?.kind, "worker");
      assert.strictEqual(workerScope?.kind === "worker" ? workerScope.roleId : null, "tester");

      const refused = yield* covens.setThread(workerThread, saved.summary.id).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "policy-denied");

      yield* covens.updateRun(run!.id, (record) =>
        Effect.succeed({
          state: { ...record.state, status: "cancelled" as const },
          result: undefined,
        }),
      );
      const cleared = yield* covens.clearThread(leaderThread);
      assert.isNull(cleared.binding);
    }),
  );

  it.effect("archives a coven out of the default list", () =>
    Effect.gen(function* () {
      const covens = yield* CovenService.CovenService;
      yield* covens.save({
        source: starterCovenSource({ id: "cov_arch", name: "Old Team", leader }),
      });
      yield* covens.archive("cov_arch");
      const active = yield* covens.list({});
      assert.isFalse(active.covens.some((coven) => coven.id === "cov_arch"));
      const all = yield* covens.list({ includeArchived: true });
      assert.isTrue(all.covens.some((coven) => coven.id === "cov_arch" && coven.archived));
    }),
  );

  it.effect("refuses generic delegation tools in coven threads and briefs the leader", () =>
    Effect.gen(function* () {
      const covens = yield* CovenService.CovenService;
      const saved = yield* covens.save({
        source: starterCovenSource({ id: "cov_guard", name: "Guard Team", leader }),
      });
      const leaderThread = ThreadId.make("thread-guard-leader");
      const plainThread = ThreadId.make("thread-guard-plain");
      yield* covens.setThread(leaderThread, saved.summary.id);
      const guard = yield* covenGuard;

      yield* guard("delegate_task").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(plainThread)),
      );
      const refused = yield* guard("delegate_task").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(leaderThread)),
        Effect.flip,
      );
      assert.strictEqual(refused.code, "capability_denied");

      const scope = yield* covens.threadScope(leaderThread);
      assert.strictEqual(scope?.kind, "leader");
      const note = scope?.kind === "leader" ? covenLeaderNote(scope) : "";
      assert.include(note, "Guard Team");
      assert.include(note, "coven_delegate_role");
    }),
  );
});
