import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProviderSetupError,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AgentLauncherPolicy from "@t3tools/provider-core/server/AgentLauncherPolicy";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderAuthController } from "../provider/ProviderAuthService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const personalId = ProviderInstanceId.make("codex_personal");
const workId = ProviderInstanceId.make("codex_work");

const makeAdapter = (
  instanceId: ProviderInstanceId,
): ProviderAdapter.ProviderAdapterV2["Service"] =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.die("capabilities are not used by this registry test"),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by this registry test"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const makeInstance = (
  instanceId: ProviderInstanceId,
  orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"],
  version: string | null = null,
  refreshedVersion = version,
): ProviderInstance => ({
  instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: `codex:test:${instanceId}`,
  },
  displayName: String(instanceId),
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({ version }),
    refresh: Effect.succeed({ version: refreshedVersion }),
  } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const personalAdapter = makeAdapter(personalId);
const workAdapter = makeAdapter(workId);
const instances = [
  makeInstance(personalId, personalAdapter),
  makeInstance(workId, workAdapter),
] as const;
const layerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const layerRegistry = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
);
const layerTest = layerRegistry.pipe(Layer.provide(layerInstanceRegistry));

it.effect("routes two configured instances of the same driver independently", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

    assert.strictEqual((yield* registry.get(personalId)).instanceId, personalId);
    assert.strictEqual((yield* registry.get(workId)).instanceId, workId);
    assert.deepEqual(yield* registry.list(), [personalId, workId]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the global launcher setting available when a provider turn starts", () => {
  const instanceId = ProviderInstanceId.make("claude_global_bili");
  const providerSessionId = ProviderSessionId.make("global-bili-session");
  let observedLauncher: AgentLauncherPolicy.AgentLauncherPolicy["Service"] | undefined;
  const runtime = {
    startTurn: () =>
      Effect.serviceOption(AgentLauncherPolicy.AgentLauncherPolicy).pipe(
        Effect.map((setting) => {
          observedLauncher = Option.getOrUndefined(setting);
        }),
      ),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...makeAdapter(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    openSession: () => Effect.succeed(runtime),
  };
  const instance = {
    ...makeInstance(instanceId, adapter),
    driverKind: ProviderDriverKind.make("claudeAgent"),
  };
  const registryLayer = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(instance),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        agentLauncher: { launcher: "bili", biliBinaryPath: "/opt/bili" },
      }),
    ),
  );

  return Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const adapterForClaude = yield* registry.get(instanceId);
    const opened = yield* adapterForClaude.openSession({
      threadId: ThreadId.make("global-bili-thread"),
      providerSessionId,
      modelSelection: { instanceId, model: "test-model" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
    });
    yield* opened.startTurn({} as never);

    assert.deepStrictEqual(observedLauncher, {
      launcher: "bili",
      biliBinaryPath: "/opt/bili",
    });
  }).pipe(Effect.provide(registryLayer));
});

it.effect("passes a pxpipe launcher selection into provider turns", () => {
  const instanceId = ProviderInstanceId.make("gemini");
  const providerSessionId = ProviderSessionId.make("gemini-pxpipe-session");
  let observedLauncher: AgentLauncherPolicy.AgentLauncherPolicy["Service"] | undefined;
  const runtime = {
    startTurn: () =>
      Effect.serviceOption(AgentLauncherPolicy.AgentLauncherPolicy).pipe(
        Effect.map((setting) => {
          observedLauncher = Option.getOrUndefined(setting);
        }),
      ),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const acpRegistryDriver = ProviderDriverKind.make("acpRegistry");
  const adapter = {
    ...makeAdapter(instanceId),
    driver: acpRegistryDriver,
    openSession: () => Effect.succeed(runtime),
  };
  const instance = {
    ...makeInstance(instanceId, adapter),
    driverKind: acpRegistryDriver,
    agentLauncher: "pxpipe" as const,
  };
  const registryLayer = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(instance),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
  );

  return Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const adapterForGemini = yield* registry.get(instanceId);
    const opened = yield* adapterForGemini.openSession({
      threadId: ThreadId.make("gemini-pxpipe-thread"),
      providerSessionId,
      modelSelection: { instanceId, model: "gemini-test" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
    });
    yield* opened.startTurn({} as never);

    assert.deepStrictEqual(observedLauncher, {
      launcher: "pxpipe",
      biliBinaryPath: "bili",
    });
  }).pipe(Effect.provide(registryLayer));
});

it.effect("routes Antigravity by model and restarts when the model leaves Google's family", () => {
  const instanceId = ProviderInstanceId.make("antigravity_model_launcher");
  const providerSessionId = ProviderSessionId.make("antigravity_model_launcher_session");
  const observedLaunchers: Array<string> = [];
  let delegatedTransitions = 0;
  const runtime = {
    startTurn: () =>
      Effect.serviceOption(AgentLauncherPolicy.AgentLauncherPolicy).pipe(
        Effect.map((setting) => {
          observedLaunchers.push(Option.getOrUndefined(setting)?.launcher ?? "missing");
        }),
      ),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const driver = ProviderDriverKind.make("antigravity");
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...makeAdapter(instanceId),
    driver,
    planSelectionTransition: () =>
      Effect.sync(() => {
        delegatedTransitions++;
        return { type: "apply_on_next_turn" as const };
      }),
    openSession: () => Effect.succeed(runtime),
  };
  const instance = {
    ...makeInstance(instanceId, adapter),
    driverKind: driver,
    agentLauncher: "model-aware" as const,
  };
  const registryLayer = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(instance),
        listInstances: Effect.succeed([instance]),
      }),
    ),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
  );

  return Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const routedAdapter = yield* registry.get(instanceId);
    const googleSession = yield* routedAdapter.openSession({
      threadId: ThreadId.make("antigravity-google-thread"),
      providerSessionId,
      modelSelection: { instanceId, model: "gemini-3.8-flash" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
    });
    yield* googleSession.startTurn({} as never);

    const otherSession = yield* routedAdapter.openSession({
      threadId: ThreadId.make("antigravity-other-thread"),
      providerSessionId,
      modelSelection: { instanceId, model: "claude-sonnet-4-5" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
    });
    yield* otherSession.startTurn({} as never);

    assert.deepStrictEqual(observedLaunchers, ["pxpipe", "bili"]);
    assert.deepStrictEqual(
      yield* routedAdapter.planSelectionTransition({
        current: { instanceId, model: "gemini-3.8-flash" },
        target: { instanceId, model: "claude-sonnet-4-5" },
        sessionCapabilities: {
          sessions: { supportsModelSwitchInSession: true },
        } as OrchestrationV2ProviderCapabilities,
      }),
      { type: "restart_session" },
    );
    assert.deepStrictEqual(
      yield* routedAdapter.planSelectionTransition({
        current: { instanceId, model: "gemini-3.8-flash" },
        target: { instanceId, model: "gemini-3.8-pro" },
        sessionCapabilities: {
          sessions: { supportsModelSwitchInSession: true },
        } as OrchestrationV2ProviderCapabilities,
      }),
      { type: "apply_on_next_turn" },
    );
    assert.strictEqual(delegatedTransitions, 1);
  }).pipe(Effect.provide(registryLayer));
});

const openOn = Effect.fn("openOn")(function* (instance: ProviderInstance) {
  const registry = yield* Effect.service(ProviderAdapterRegistry.ProviderAdapterRegistryV2).pipe(
    Effect.provide(
      layerRegistry.pipe(
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(instance),
          }),
        ),
      ),
    ),
  );
  return yield* (yield* registry.get(instance.instanceId))
    .openSession({
      threadId: ThreadId.make("gated-thread"),
      providerSessionId: ProviderSessionId.make("gated-session"),
      modelSelection: { instanceId: instance.instanceId, model: "test-model" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
    })
    .pipe(Effect.exit);
});

it.effect("refuses a session only when a fresh probe still rates the version broken", () =>
  Effect.gen(function* () {
    const opened = { ...personalAdapter, openSession: () => Effect.succeed({} as never) };
    const refused = yield* openOn(makeInstance(personalId, opened, "0.100.0"));
    assert.include(JSON.stringify(refused), "0.100.0 does not work with this T3 Code release");
    // Updated since the last probe.
    assert.isTrue(
      Exit.isSuccess(yield* openOn(makeInstance(personalId, opened, "0.100.0", "0.200.0"))),
    );
    // An adapter that rates the handshake version is not judged on the probe.
    const handshake = { ...opened, checksVersionAtHandshake: true };
    assert.isTrue(Exit.isSuccess(yield* openOn(makeInstance(personalId, handshake, "0.100.0"))));
  }),
);

const openWithBiliOverride = (driverKind: ProviderDriverKind) =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make(`${driverKind}_bili`);
    const reachedAdapter = new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver: driverKind,
      providerSessionId: ProviderSessionId.make("bili-session"),
      cause: "reached adapter",
    });
    const instance = {
      ...makeInstance(instanceId, {
        ...makeAdapter(instanceId),
        openSession: () => Effect.fail(reachedAdapter),
      }),
      driverKind,
      agentLauncher: "bili" as const,
    };
    const registry = yield* Effect.service(ProviderAdapterRegistry.ProviderAdapterRegistryV2).pipe(
      Effect.provide(
        layerRegistry.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
            }),
          ),
        ),
      ),
    );
    const adapter = yield* registry.get(instanceId);
    const error = yield* adapter
      .openSession({
        threadId: ThreadId.make("bili-thread"),
        providerSessionId: ProviderSessionId.make("bili-session"),
        modelSelection: { instanceId, model: "test-model" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterOpenSessionError);
    return { error, reachedAdapter };
  });

it.effect("applies a provider instance bili override before the compatibility guard", () =>
  Effect.gen(function* () {
    const cursor = yield* openWithBiliOverride(ProviderDriverKind.make("cursor"));
    assert.instanceOf(cursor.error.cause, ProviderSetupError);

    const claude = yield* openWithBiliOverride(ProviderDriverKind.make("claudeAgent"));
    assert.strictEqual(claude.error, claude.reachedAdapter);
  }),
);

it.effect(
  "blocks a new session while another instance changes their shared provider credentials",
  () =>
    Effect.gen(function* () {
      const unused = () => Effect.die("unused auth operation");
      const auth: ProviderAuthController = {
        credentialBinding: { owner: "provider", key: "shared-cli" },
        isChangingCredentials: Effect.succeed(false),
        start: unused,
        complete: unused,
        cancel: unused,
        logout: unused,
        subscribe: () => Stream.empty,
      };
      const related = [
        { ...instances[0], auth },
        { ...instances[1], auth: { ...auth, isChangingCredentials: Effect.succeed(true) } },
      ];
      const registry = yield* Effect.service(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ).pipe(
        Effect.provide(
          layerRegistry.pipe(
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: (id) =>
                  Effect.succeed(related.find((instance) => instance.instanceId === id)),
                listInstances: Effect.succeed(related),
              }),
            ),
          ),
        ),
      );
      const adapter = yield* registry.get(personalId);
      const error = yield* adapter
        .openSession({
          threadId: ThreadId.make("new-thread"),
          providerSessionId: ProviderSessionId.make("new-session"),
          modelSelection: { instanceId: personalId, model: "test-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterOpenSessionError);
      assert.instanceOf(error.cause, ProviderSetupError);
    }),
);

it.effect("interrupts admitted session startup when a shared peer signs out", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const binding = { owner: "provider" as const, key: "shared-cli" };
    const auth = yield* ProviderAuthFlow.make({
      instanceId: personalId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: workId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      ...workAdapter,
      openSession: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    };
    const related = [
      { ...instances[0], auth },
      { ...instances[1], auth: peerAuth, orchestrationAdapter: adapter },
    ];
    const registry = yield* Effect.service(ProviderAdapterRegistry.ProviderAdapterRegistryV2).pipe(
      Effect.provide(
        layerRegistry.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(related.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(related),
            }),
          ),
        ),
      ),
    );
    const guarded = yield* registry.get(workId);
    const startup = yield* guarded
      .openSession({
        threadId: ThreadId.make("shared-startup"),
        providerSessionId: ProviderSessionId.make("shared-session"),
        modelSelection: { instanceId: workId, model: "test-model" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* auth.logout(Effect.void);
    yield* Deferred.await(stopped);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(startup)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
