// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import glmAcpAgentPackage from "glm-acp-agent/package.json" with { type: "json" };
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpRegistrySettings } from "../settings.ts";

const DEFAULT_GLM_MODELS = ["glm-5.4", "glm-5.3", "glm-5.3-flash", "glm-5-turbo", "glm-4.7"];

export function configureGlmAcpAgentSpawn(
  settings: AcpRegistrySettings,
  spawn: AcpSessionRuntime.AcpSpawnInput,
): AcpSessionRuntime.AcpSpawnInput {
  if (
    settings.source !== "registry" ||
    settings.agentId.toLowerCase() !== "glm-acp-agent" ||
    settings.commandPath.trim() !== ""
  ) {
    return spawn;
  }

  const packageJsonPath = NodeModule.createRequire(import.meta.url).resolve(
    "glm-acp-agent/package.json",
  );
  const agentEntryPath = NodePath.resolve(
    NodePath.dirname(packageJsonPath),
    glmAcpAgentPackage.bin["glm-acp-agent"],
  );

  return {
    ...spawn,
    command: process.execPath,
    args: [agentEntryPath],
  };
}

export function configureGlmAcpModels(
  settings: AcpRegistrySettings,
  spawn: AcpSessionRuntime.AcpSpawnInput,
): AcpSessionRuntime.AcpSpawnInput {
  const executable = spawn.command
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const isRegistryAgent =
    settings.source === "registry" && settings.agentId.toLowerCase() === "glm-acp-agent";
  const isLocalAgent =
    settings.source === "local" && /^glm(?:-acp-agent)?$/i.test(executable ?? "");
  if (!isRegistryAgent && !isLocalAgent) return spawn;

  const environment = spawn.env ?? {};
  const configuredModels = environment["ACP_GLM_AVAILABLE_MODELS"]
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configuredModels?.length ? configuredModels : DEFAULT_GLM_MODELS;
  const availableModels = ["glm-5.4", ...models.filter((model) => model !== "glm-5.4")];

  return {
    ...spawn,
    env: {
      ...environment,
      ACP_GLM_MODEL: environment["ACP_GLM_MODEL"] ?? "glm-5.4",
      ACP_GLM_AVAILABLE_MODELS: [...new Set(availableModels)].join(","),
    },
  };
}
