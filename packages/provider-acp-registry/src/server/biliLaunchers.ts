// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

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
