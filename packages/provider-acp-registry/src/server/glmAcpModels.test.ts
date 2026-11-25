import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "../settings.ts";
import { configureGlmAcpAgentSpawn, configureGlmAcpModels } from "./glmAcpModels.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("configureGlmAcpAgentSpawn", () => {
  it("launches the pinned Git package for the registry agent", () => {
    const spawn = { command: "/managed/glm-acp-agent", args: ["--acp"], env: { KEEP: "yes" } };
    const configured = configureGlmAcpAgentSpawn(
      decodeSettings({ agentId: "glm-acp-agent" }),
      spawn,
    );

    expect(configured.command).toBe(process.execPath);
    expect(configured.args).toHaveLength(1);
    expect(configured.args[0]).toContain("glm-acp-agent");
    expect(configured.env).toEqual(spawn.env);
  });

  it("keeps an explicit executable override", () => {
    const spawn = { command: "/custom/glm-acp-agent", args: [], env: { KEEP: "yes" } };
    expect(
      configureGlmAcpAgentSpawn(
        decodeSettings({ agentId: "glm-acp-agent", commandPath: "/custom/glm-acp-agent" }),
        spawn,
      ),
    ).toBe(spawn);
  });
});

describe("configureGlmAcpModels", () => {
  it("advertises GLM-5.4 first and selects it by default for the Registry agent", () => {
    const spawn = {
      command: "/managed/glm-acp-agent",
      args: [],
      env: { Z_AI_API_KEY: "test-api-key" },
    };

    const configured = configureGlmAcpModels(decodeSettings({ agentId: "glm-acp-agent" }), spawn);

    expect(configured.env).toEqual({
      Z_AI_API_KEY: "test-api-key",
      ACP_GLM_MODEL: "glm-5.4",
      ACP_GLM_AVAILABLE_MODELS: "glm-5.4,glm-5.3,glm-5.3-flash,glm-5-turbo,glm-4.7",
    });
  });

  it("keeps explicit model settings and adds GLM-5.4 to a custom list once", () => {
    const spawn = {
      command: "/managed/glm-acp-agent",
      args: [],
      env: {
        ACP_GLM_MODEL: "glm-5.3",
        ACP_GLM_AVAILABLE_MODELS: "glm-5.3,glm-4.7,glm-5.4",
      },
    };

    const configured = configureGlmAcpModels(decodeSettings({ agentId: "glm-acp-agent" }), spawn);

    expect(configured.env).toEqual({
      ACP_GLM_MODEL: "glm-5.3",
      ACP_GLM_AVAILABLE_MODELS: "glm-5.4,glm-5.3,glm-4.7",
    });
  });

  it("leaves unrelated agents unchanged", () => {
    const spawn = { command: "/managed/codex", args: [], env: { KEEP: "yes" } };
    expect(configureGlmAcpModels(decodeSettings({ agentId: "codex" }), spawn)).toBe(spawn);
  });
});
