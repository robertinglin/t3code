// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcesses from "./providerProcesses.ts";
import {
  detachedListeners,
  parseProcStat,
  parseTcpTable,
  type ScopeProcess,
  sharedHelperPids,
  socketInode,
} from "./sharedHelpers.ts";

const AGENT_SLICE = "app-t3code-agents.slice";
// Owns every agent slice and competes with the server's unit or scope under app.slice.
const AGENTS_PARENT_SLICE = "app-t3code.slice";
// Low weights yield CPU and disk to the server under contention, where the user manager
// has those controllers: current systemd delegates cpu, rarely io. TasksMax keeps agents
// below logind's 33% per-user task limit, leaving forks for the server.
const AGENTS_PARENT_PROPERTIES = ["CPUWeight=10", "IOWeight=10", "TasksMax=25%"];

export function ownedAgentSlice(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-t3code-agents-${hash}.slice`;
}

const GiB = 1024 ** 3;

/**
 * Agents leave about 6 GB free before throttling and 4 GB before an OOM kill (at
 * least half and three quarters of RAM go to agents) so the server and sshd keep
 * working. Without swap, MemoryHigh stalls every agent and never reaches the kill.
 */
function agentSliceMemoryLimits(totalBytes: number, hasSwap: boolean) {
  return {
    high: hasSwap ? Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)) : "infinity",
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  readonly oomKills: number | undefined;
  readonly populated: boolean | undefined;
  readonly controlGroup?: string | undefined;
}

/** Pipes can close before systemd records oom-kill; stopping, empty or OOM-counted scopes remain pending. */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (
    state.activeState === "deactivating" ||
    (state.oomKills ?? 0) > 0 ||
    state.populated === false
  ) {
    return "stopping";
  }
  return "running";
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

// systemd's default 90 s stop timeout would outlast our leftover-agent wait.
// Delegation lets rootless containers (Podman, kind) manage their own cgroups.
const SCOPE_OPTIONS = ["--property=TimeoutStopSec=10s", "--property=Delegate=yes"];
const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_TRACKED_THREADS = 500;

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const { hasOtherLiveOwner } = yield* ProviderProcesses.ProviderProcesses;
  const ownedSlice = ownedAgentSlice(stateDir);
  const layerScope = yield* Effect.scope;

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop them first, so two copies of one
  // session never work in the same worktree.
  const stopLeftoverAgents = Effect.fn("agentScope.stopLeftoverAgents")(function* (
    systemctl: string,
  ) {
    if (hasOtherLiveOwner) return;
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      ownedSlice,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None") return;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return;
    const controlGroup = values.get("ControlGroup") ?? "";
    const events = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
    if (parseCgroupCounter(events, "populated") === 0) return;
    yield* Effect.logWarning("Stopping agents left by a previous server", { slice: ownedSlice });
    const stopped = yield* runner
      .run({ command: systemctl, args: ["--user", "stop", ownedSlice], timeout: "30 seconds" })
      .pipe(Effect.option);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop agents left by a previous server", {
        slice: ownedSlice,
        stderr: stopped._tag === "Some" ? stopped.value.stderr.trim() : undefined,
      });
    }
  });

  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      yield* stopLeftoverAgents(systemctl);
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Scopes take OOMPolicy from systemd 253; older managers still get scopes.
      const supportsOomPolicy = yield* probe([...SCOPE_OPTIONS, "--property=OOMPolicy=stop"]);
      if (!supportsOomPolicy && !(yield* probe(SCOPE_OPTIONS))) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const setProperties = Effect.fn("agentScope.setProperties")(function* (
        slice: string,
        properties: ReadonlyArray<string>,
      ) {
        const result = yield* run(systemctl, [
          "--user",
          "set-property",
          "--runtime",
          slice,
          ...properties,
        ]);
        if (result._tag === "Some" && result.value.code === 0) return true;
        yield* Effect.logWarning("Could not set resource limits on an agents slice", {
          slice,
          properties,
          stderr: result._tag === "Some" ? result.value.stderr.trim() : undefined,
        });
        return false;
      });
      // VMs and containers can resize RAM live, so each launch re-checks the total
      // the limits came from. A failed update is retried by the next launch.
      // An unreadable meminfo keeps the throttle, as before swap was checked.
      const readHasSwap = fileSystem.readFileString("/proc/meminfo").pipe(
        Effect.map((text) => /^SwapTotal:\s*0 kB$/m.exec(text) === null),
        Effect.orElseSucceed(() => true),
      );
      let appliedTotal: number | undefined;
      let appliedHasSwap: boolean | undefined;
      const memoryLimitsLock = yield* Semaphore.make(1);
      const applyMemoryLimits = memoryLimitsLock.withPermits(1)(
        Effect.gen(function* () {
          const total = NodeOS.totalmem();
          const hasSwap = yield* readHasSwap;
          if (total === appliedTotal && hasSwap === appliedHasSwap) return;
          const limits = agentSliceMemoryLimits(total, hasSwap);
          const applied = yield* setProperties(AGENT_SLICE, [
            `MemoryHigh=${limits.high}`,
            `MemoryMax=${limits.max}`,
          ]);
          if (!applied) return;
          if (appliedTotal !== undefined) {
            yield* Effect.logInfo("Agent memory limits follow a memory change", {
              slice: AGENT_SLICE,
              previousTotal: appliedTotal,
              total,
              ...limits,
            });
          }
          appliedTotal = total;
          appliedHasSwap = hasSwap;
        }),
      );
      yield* applyMemoryLimits;
      yield* setProperties(AGENTS_PARENT_SLICE, AGENTS_PARENT_PROPERTIES);
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        ...agentSliceMemoryLimits(NodeOS.totalmem(), yield* readHasSwap),
        oomPolicy: supportsOomPolicy,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        supportsOomPolicy,
        applyMemoryLimits,
      };
    }),
  );

  // Layer acquisition is the startup barrier: recovery must not terminalize or
  // continue old runs while a previous server's providers can still execute.
  yield* systemd;

  // `shared` scopes serve other threads too: tracked only for OOM diagnosis on old systemd.
  const scopeByThread = new Map<string, { unit: string; oomKilled: boolean; shared: boolean }>();

  const readScope = Effect.fn("agentScope.readScope")(function* (systemctl: string, unit: string) {
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      unit,
      "--property=LoadState,ActiveState,Result,ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return undefined;
    const values = parseKeyValues(shown.value.stdout);
    const controlGroup = values.get("ControlGroup") ?? "";
    const memoryEvents = controlGroup ? yield* readCgroupFile(controlGroup, "memory.events") : "";
    const cgroupEvents = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
    const populated = parseCgroupCounter(cgroupEvents, "populated");
    return {
      loadState: values.get("LoadState") ?? "",
      activeState: values.get("ActiveState") ?? "",
      result: values.get("Result") ?? "",
      oomKills: parseCgroupCounter(memoryEvents, "oom_kill"),
      populated: populated === undefined ? undefined : populated === 1,
      controlGroup,
    } satisfies ScopeState;
  });

  const clearFailed = Effect.fn("agentScope.clearFailed")(function* (
    systemctl: string,
    unit: string,
  ) {
    for (let attempt = 0; attempt < CLEAR_FAILED_ATTEMPTS; attempt++) {
      const state = yield* readScope(systemctl, unit);
      if (state === undefined) return;
      if (state.activeState === "failed") {
        yield* run(systemctl, ["--user", "reset-failed", unit]);
        return;
      }
      if (state.activeState !== "deactivating") return;
      yield* Effect.sleep(CLEAR_FAILED_INTERVAL);
    }
  });

  const forget = (systemctl: string, unit: string) =>
    clearFailed(systemctl, unit).pipe(Effect.forkIn(layerScope), Effect.asVoid);

  const evictOldest = Effect.fn("agentScope.evictOldest")(function* (systemctl: string) {
    const oldest = scopeByThread.entries().next();
    if (oldest.done === true) return;
    const [threadId, tracked] = oldest.value;
    const state = yield* readScope(systemctl, tracked.unit);
    if (scopeByThread.get(threadId) !== tracked) return;
    scopeByThread.delete(threadId);
    const status = state === undefined ? "running" : classifyScope(state);
    if (status === "running" || status === "stopping") {
      scopeByThread.set(threadId, tracked);
      return;
    }
    yield* forget(systemctl, tracked.unit);
  });

  const track = Effect.fn("agentScope.track")(function* (
    systemctl: string,
    threadId: string,
    unit: string | undefined,
    shared = false,
  ) {
    const previous = scopeByThread.get(threadId);
    scopeByThread.delete(threadId);
    if (unit !== undefined) scopeByThread.set(threadId, { unit, oomKilled: false, shared });
    if (previous !== undefined) yield* forget(systemctl, previous.unit);
    if (scopeByThread.size > MAX_TRACKED_THREADS) yield* evictOldest(systemctl);
  });

  const oomKilled: AgentScopeShape["oomKilled"] = Effect.fn("agentScope.oomKilled")(
    function* (threadId) {
      const tracked = scopeByThread.get(threadId);
      if (tracked === undefined) return false;
      if (tracked.oomKilled) return true;
      const scope = yield* systemd;
      if (scope === undefined) return false;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        const state = yield* readScope(scope.systemctl, tracked.unit);
        if (state === undefined) return false;
        const status = classifyScope(state);
        if (status === "running") return false;
        if (status === "stopping") {
          yield* Effect.sleep(STOPPING_POLL_INTERVAL);
          continue;
        }
        yield* forget(scope.systemctl, tracked.unit);
        if (status === "gone") return false;
        yield* Effect.logWarning("Agent scope was killed: out of memory", {
          threadId,
          unit: tracked.unit,
        });
        tracked.oomKilled = true;
        return true;
      }
      return false;
    },
  );

  const readPids = (controlGroup: string) =>
    readCgroupFile(controlGroup, "cgroup.procs").pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    );

  const socketInodesOf = (pid: number) =>
    fileSystem.readDirectory(`/proc/${pid}/fd`).pipe(
      Effect.flatMap((fds) =>
        Effect.forEach(
          fds,
          (fd) =>
            fileSystem.readLink(`/proc/${pid}/fd/${fd}`).pipe(
              Effect.map(socketInode),
              Effect.orElseSucceed(() => undefined),
            ),
          { concurrency: 16 },
        ),
      ),
      Effect.map((inodes) => new Set(inodes.filter((inode) => inode !== undefined))),
      Effect.orElseSucceed(() => new Set<string>()),
    );

  const readScopeProcesses = Effect.fn("agentScope.readScopeProcesses")(function* (
    controlGroup: string,
  ) {
    const pids = yield* readPids(controlGroup);
    const processes = yield* Effect.forEach(
      pids,
      (pid) =>
        Effect.gen(function* () {
          const stat = parseProcStat(
            yield* fileSystem
              .readFileString(`/proc/${pid}/stat`)
              .pipe(Effect.orElseSucceed(() => "")),
          );
          if (stat === undefined) return undefined;
          return { pid, ...stat, socketInodes: yield* socketInodesOf(pid) } satisfies ScopeProcess;
        }),
      { concurrency: 8 },
    );
    return processes.filter((process) => process !== undefined);
  });

  /** Every other cgroup under the agents slice, helper scopes included. */
  const otherAgentInodes = Effect.fn("agentScope.otherAgentInodes")(function* (
    controlGroup: string,
  ) {
    const segments = controlGroup.split("/");
    const sliceIndex = segments.lastIndexOf(AGENT_SLICE);
    const root = sliceIndex > 0 ? segments.slice(0, sliceIndex + 1).join("/") : undefined;
    const inodes = new Set<string>();
    if (root === undefined) return inodes;
    const pending = [root];
    for (let group = pending.pop(); group !== undefined; group = pending.pop()) {
      if (group === controlGroup) continue;
      for (const pid of yield* readPids(group)) {
        for (const inode of yield* socketInodesOf(pid)) inodes.add(inode);
      }
      const entries = yield* fileSystem
        .readDirectory(path.join("/sys/fs/cgroup", group))
        .pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (entry.endsWith(".scope") || entry.endsWith(".slice")) pending.push(`${group}/${entry}`);
      }
    }
    return inodes;
  });

  const readTcpSockets = Effect.forEach(["/proc/net/tcp", "/proc/net/tcp6"], (file) =>
    fileSystem.readFileString(file).pipe(
      Effect.map(parseTcpTable),
      Effect.orElseSucceed(() => []),
    ),
  ).pipe(Effect.map((tables) => tables.flat()));

  /**
   * Moves detached loopback helpers that other agents still use (bili's shared
   * proxy) into their own scope, so stopping or killing this scope leaves them
   * running. They then live as long as their own lifecycle allows.
   */
  const releaseSharedHelpers = Effect.fn("agentScope.releaseSharedHelpers")(function* (
    unit: string,
    controlGroup: string,
  ) {
    if (controlGroup.length === 0) return;
    const processes = yield* readScopeProcesses(controlGroup);
    const sockets = yield* readTcpSockets;
    // Most scopes listen on nothing detached; skip the slice walk for them.
    if (detachedListeners(processes, sockets).size === 0) return;
    const pids = sharedHelperPids({
      processes,
      sockets,
      otherAgentInodes: yield* otherAgentInodes(controlGroup),
    });
    if (pids.length === 0) return;
    const busctl = yield* resolve("busctl", hostEnvironment);
    if (busctl === null) {
      yield* Effect.logWarning("Could not keep a shared helper running: busctl is missing", {
        unit,
        pids,
      });
      return;
    }
    const helperUnit = `t3code-helper-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
    const adopted = yield* run(busctl, [
      "--user",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      helperUnit,
      "fail",
      "4",
      "PIDs",
      "au",
      String(pids.length),
      ...pids.map(String),
      "Slice",
      "s",
      ownedSlice,
      "CollectMode",
      "s",
      "inactive-or-failed",
      "Description",
      "s",
      `Shared agent helper released from ${unit}`,
      "0",
    ]);
    if (adopted._tag === "Some" && adopted.value.code === 0) {
      yield* Effect.logInfo("Kept a shared agent helper running", { unit, helperUnit, pids });
      return;
    }
    yield* Effect.logWarning("Could not keep a shared helper running", {
      unit,
      pids,
      stderr: adopted._tag === "Some" ? adopted.value.stderr.trim() : undefined,
    });
  });

  const stop = Effect.fn("AgentScope.stop")(function* (unit: string) {
    if (!unit.startsWith("t3code-") || !unit.endsWith(".scope")) return;
    const scope = yield* systemd;
    if (scope === undefined) return;
    const state = yield* readScope(scope.systemctl, unit);
    if (
      state === undefined ||
      state.loadState !== "loaded" ||
      state.activeState !== "active" ||
      state.result === "oom-kill" ||
      state.populated === false
    )
      return;
    // The kernel counts OOM kills before signaling the victim. Let OOMPolicy
    // record the result before a manual stop can overwrite it; an unreadable
    // counter cannot rule out that race. Older managers need us to stop it.
    if (scope.supportsOomPolicy && (state.oomKills === undefined || state.oomKills > 0)) return;
    yield* releaseSharedHelpers(unit, state.controlGroup ?? "");
    const stopped = yield* run(scope.systemctl, ["--user", "stop", "--no-block", unit]);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop an exited agent's scope", {
        unit,
        exitCode: stopped._tag === "Some" ? stopped.value.code : undefined,
      });
    }
  });

  const kill: AgentScopeShape["kill"] = Effect.fn("AgentScope.kill")(function* (threadId) {
    const tracked = scopeByThread.get(threadId);
    if (tracked === undefined || tracked.shared) return false;
    const scope = yield* systemd;
    if (scope === undefined) return false;
    const shown = yield* run(scope.systemctl, [
      "--user",
      "show",
      tracked.unit,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return false;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return false;
    const controlGroup = values.get("ControlGroup") ?? "";
    yield* releaseSharedHelpers(tracked.unit, controlGroup);
    // cgroup.kill (Linux 5.14+) kills the whole tree at once; systemd's kill is the fallback.
    const killedByCgroup =
      controlGroup.length > 0 &&
      (yield* fileSystem
        .writeFileString(path.join("/sys/fs/cgroup", controlGroup, "cgroup.kill"), "1")
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
    if (killedByCgroup) return true;
    const killed = yield* run(scope.systemctl, [
      "--user",
      "kill",
      "--signal=SIGKILL",
      tracked.unit,
    ]);
    return killed._tag === "Some" && killed.value.code === 0;
  });

  const clear: AgentScopeShape["clear"] = Effect.fn("agentScope.clear")(function* (threadId) {
    if (!scopeByThread.has(threadId)) return;
    const scope = yield* systemd;
    if (scope !== undefined) yield* track(scope.systemctl, threadId, undefined);
  });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
      shared,
    }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved, args });
      yield* scope.applyMemoryLimits;
      const unit = `t3code-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      // A continuing shared scope cannot attribute a tool's OOM to one thread.
      // Clear the launch thread's previous scope instead.
      const continuing = shared === true && scope.supportsOomPolicy;
      const owned = threadId !== undefined && !continuing;
      if (threadId !== undefined)
        yield* track(scope.systemctl, threadId, owned ? unit : undefined, shared === true);
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        // Without an owning thread nothing reads the result, so let systemd
        // unload the unit even when it fails.
        options: [
          ...SCOPE_OPTIONS,
          ...(scope.supportsOomPolicy
            ? [`--property=OOMPolicy=${continuing ? "continue" : "stop"}`]
            : []),
          ...(owned ? [] : ["--collect"]),
        ],
      };
      return { ...agentScopeCommand({ command: resolved, args, scope: systemdScope }), unit };
    }),
    oomKilled,
    stop,
    kill,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(ProviderProcesses.layer),
);
