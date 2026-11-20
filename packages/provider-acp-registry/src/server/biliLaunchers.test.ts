import { describe, expect, it } from "vite-plus/test";

import {
  biliNodeCaBundlePath,
  enableGlmAcpProxySupport,
  glmAcpClientModulePath,
  resolveBiliRegistryLauncher,
} from "./biliLaunchers.ts";

describe("resolveBiliRegistryLauncher", () => {
  it("uses the configured bili lane for every verified ACP registry alias", () => {
    const launchers = [
      ["antigravity", "antigravity"],
      ["agy", "antigravity"],
      ["claude", "claude"],
      ["cline", "qwen"],
      ["clinebot", "qwen"],
      ["codex", "codex"],
      ["glm-acp-agent", "jcode"],
      ["omp", "omp"],
      ["opencode", "opencode"],
      ["opencode-v2", "opencode"],
      ["pi", "pi"],
    ] as const;

    for (const [agentId, biliAgent] of launchers) {
      expect(
        resolveBiliRegistryLauncher({
          agentId,
          source: "registry",
          commandPath: `/managed/${agentId}`,
        })?.agent,
      ).toBe(biliAgent);
    }
  });

  it("resolves local ACP executable aliases", () => {
    expect(
      resolveBiliRegistryLauncher({
        agentId: "custom-agent",
        source: "local",
        commandPath: "C:\\tools\\cline.cmd",
      })?.agent,
    ).toBe("qwen");
  });

  it("routes the GLM ACP executable through Bili's Z.AI lane", () => {
    expect(
      resolveBiliRegistryLauncher({
        agentId: "glm-acp-agent",
        source: "registry",
        commandPath: "/managed/glm-acp-agent",
      }),
    ).toEqual({
      agent: "jcode",
      environment: { NODE_USE_ENV_PROXY: "1" },
    });
  });

  it("keeps unknown custom ACP executables unsupported", () => {
    expect(
      resolveBiliRegistryLauncher({
        agentId: "custom-agent",
        source: "local",
        commandPath: "/opt/custom-agent",
      }),
    ).toBeUndefined();
  });

  it("uses Bili's configured data directory for Node's additional trust bundle", () => {
    expect(biliNodeCaBundlePath("/state", "/home/test")).toBe(
      "/state/billion-context/ca/combined-ca.pem",
    );
    expect(biliNodeCaBundlePath(undefined, "/home/test")).toBe(
      "/home/test/.local/share/billion-context/ca/combined-ca.pem",
    );
  });

  it("patches GLM ACP's custom Undici dispatcher to honor Bili's proxy", () => {
    const source = [
      'import { Agent, fetch as undiciFetch } from "undici";',
      "        const dispatcher = new Agent();",
    ].join("\n");
    const patched = enableGlmAcpProxySupport(source);
    expect(patched).toContain("EnvHttpProxyAgent");
    expect(enableGlmAcpProxySupport(patched ?? "")).toBe(patched);
    expect(enableGlmAcpProxySupport('import { EnvHttpProxyAgent } from "undici";')).toBeUndefined();
    expect(enableGlmAcpProxySupport("different upstream transport")).toBeUndefined();
  });

  it("locates the managed GLM ACP transport beside its npm launcher", () => {
    expect(glmAcpClientModulePath("/managed/npm/bin/glm-acp-agent")).toBe(
      "/managed/npm/lib/node_modules/glm-acp-agent/dist/llm/glm-client.js",
    );
  });
});
