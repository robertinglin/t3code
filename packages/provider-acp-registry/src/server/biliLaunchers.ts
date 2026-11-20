// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BILI_AGENT_COMPATIBILITY } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as EffectAcpErrors from "effect-acp/errors";

import type { AgentLauncherSettings } from "@t3tools/contracts/settings";
import * as AgentLauncherPolicy from "@t3tools/provider-core/server/AgentLauncherPolicy";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpRegistrySettings } from "../settings.ts";

export interface BiliRegistryLauncher {
  readonly agent: string;
  readonly options?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}

const CLINE_BILI_LAUNCHER: BiliRegistryLauncher = {
  agent: "qwen",
  options: ["--mitm-domain", "api.cline.bot"],
  environment: { NODE_USE_ENV_PROXY: "1" },
};

const BILI_REGISTRY_LAUNCHERS = new Map<string, BiliRegistryLauncher>([
  ["antigravity", { agent: "antigravity" }],
  ["agy", { agent: "antigravity" }],
  ["claude", { agent: "claude" }],
  ["cline", CLINE_BILI_LAUNCHER],
  ["clinebot", CLINE_BILI_LAUNCHER],
  ["codex", { agent: "codex" }],
  ["glm-acp-agent", { agent: "jcode", environment: { NODE_USE_ENV_PROXY: "1" } }],
  ["omp", { agent: "omp" }],
  ["opencode", { agent: "opencode" }],
  ["opencode-v2", { agent: "opencode" }],
  ["pi", { agent: "pi" }],
]);

export function resolveBiliRegistryLauncher(input: {
  readonly agentId: string;
  readonly source: "registry" | "local";
  readonly commandPath: string;
}): BiliRegistryLauncher | undefined {
  const executableName = input.commandPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const launcherKey = input.source === "registry" ? input.agentId.toLowerCase() : executableName;
  return launcherKey === undefined ? undefined : BILI_REGISTRY_LAUNCHERS.get(launcherKey);
}

export function biliNodeCaBundlePath(dataHome: string | undefined, home: string): string {
  return NodePath.join(
    dataHome?.trim() || NodePath.join(home, ".local", "share"),
    "billion-context",
    "ca",
    "combined-ca.pem",
  );
}

export function glmAcpClientModulePath(commandPath: string): string {
  return NodePath.join(
    NodePath.dirname(NodePath.dirname(commandPath)),
    "lib",
    "node_modules",
    "glm-acp-agent",
    "dist",
    "llm",
    "glm-client.js",
  );
}

export function enableGlmAcpProxySupport(source: string): string | undefined {
  if (source.includes("EnvHttpProxyAgent")) {
    return source.includes("new EnvHttpProxyAgent()") ? source : undefined;
  }
  const importStatement = 'import { Agent, fetch as undiciFetch } from "undici";';
  const dispatcherCreation = "        const dispatcher = new Agent();";
  if (!source.includes(importStatement) || !source.includes(dispatcherCreation)) return undefined;
  return source
    .replace(
      importStatement,
      'import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";',
    )
    .replace(
      dispatcherCreation,
      '        const dispatcher = process.env["HTTPS_PROXY"] || process.env["https_proxy"]\n' +
        "            ? new EnvHttpProxyAgent()\n" +
        "            : new Agent();",
    );
}

export const prepareBiliRegistrySpawn = Effect.fn("BiliLaunchers.prepareRegistrySpawn")(
  function* (input: {
    readonly settings: AcpRegistrySettings;
    readonly spawn: AcpSessionRuntime.AcpSpawnInput;
    readonly policy: AgentLauncherSettings;
  }): Effect.fn.Return<AcpSessionRuntime.AcpSpawnInput, EffectAcpErrors.AcpSpawnError> {
    const biliLauncher = resolveBiliRegistryLauncher(input.settings);
    if (
      input.policy.launcher === "bili" &&
      biliLauncher?.agent === "jcode" &&
      input.settings.agentId.toLowerCase() === "glm-acp-agent"
    ) {
      yield* Effect.try({
        try: () => {
          const clientModulePath = glmAcpClientModulePath(input.spawn.command);
          const clientSource = NodeFS.readFileSync(clientModulePath, "utf8");
          const proxyAwareClientSource = enableGlmAcpProxySupport(clientSource);
          if (proxyAwareClientSource === undefined) {
            throw new Error("The installed GLM ACP transport cannot be patched for Bili proxying.");
          }
          if (proxyAwareClientSource !== clientSource) {
            NodeFS.writeFileSync(clientModulePath, proxyAwareClientSource);
          }
        },
        catch: (cause) =>
          new EffectAcpErrors.AcpSpawnError({ command: input.spawn.command, cause }),
      });
    }

    const compatibility = BILI_AGENT_COMPATIBILITY.find(
      (entry) => entry.id === input.settings.agentId.toLowerCase(),
    );
    const biliEnvironment =
      biliLauncher?.agent === "jcode"
        ? {
            ...biliLauncher.environment,
            NODE_EXTRA_CA_CERTS: biliNodeCaBundlePath(
              (yield* HostProcess.Environment).XDG_DATA_HOME,
              yield* HostProcess.HomeDirectory,
            ),
          }
        : biliLauncher?.environment;
    const launch = AgentLauncherPolicy.resolveAgentLaunch(
      {
        agent:
          biliLauncher?.agent ??
          (input.settings.agentId || input.settings.commandPath || "ACP agent"),
        executable: input.spawn.command,
        args: input.spawn.args,
        ...(biliLauncher?.options === undefined ? {} : { biliOptions: biliLauncher.options }),
        ...(biliEnvironment === undefined ? {} : { biliEnvironment }),
        ...(input.spawn.cwd === undefined ? {} : { cwd: input.spawn.cwd }),
        ...(input.spawn.env === undefined ? {} : { env: input.spawn.env }),
        ...(biliLauncher === undefined
          ? {
              biliCompatibility: {
                supported: false as const,
                reason:
                  compatibility?.supported === false
                    ? compatibility.reason
                    : "This ACP agent does not have a verified bili launcher command.",
              },
            }
          : { biliCompatibility: { supported: true as const } }),
      },
      input.policy,
    );
    if (launch._tag === "Unsupported") {
      return yield* new EffectAcpErrors.AcpSpawnError({
        command: input.spawn.command,
        cause: new Error(launch.message),
      });
    }
    if (launch.launch.command === input.spawn.command) return input.spawn;
    const { shell: _shell, ...spawnOptions } = input.spawn;
    return {
      ...spawnOptions,
      command: launch.launch.command,
      args: [...launch.launch.args],
      ...(launch.launch.cwd === undefined ? {} : { cwd: launch.launch.cwd }),
      ...(launch.launch.env === undefined ? {} : { env: launch.launch.env }),
    };
  },
);
