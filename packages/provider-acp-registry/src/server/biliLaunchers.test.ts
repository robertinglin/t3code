// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AgentLauncherSettings } from "@t3tools/contracts/settings";
import { AcpRegistrySettings } from "../settings.ts";

import {
  biliNodeCaBundlePath,
  enableGlmAcpProxySupport,
  glmAcpClientModulePath,
  prepareBiliRegistrySpawn,
  resolveBiliRegistryLauncher,
} from "./biliLaunchers.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeLauncherSettings = Schema.decodeSync(AgentLauncherSettings);

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

  it("can patch the pinned GLM agent package transport", () => {
    const agentEntryPath = NodeModule.createRequire(import.meta.url).resolve("glm-acp-agent");
    const clientPath = NodePath.join(NodePath.dirname(agentEntryPath), "llm", "glm-client.js");
    const source = NodeFS.readFileSync(clientPath, "utf8");

    expect(enableGlmAcpProxySupport(source)).toContain("EnvHttpProxyAgent");
  });

  it("locates the managed GLM ACP transport beside its npm launcher", () => {
    expect(glmAcpClientModulePath("/managed/npm/bin/glm-acp-agent")).toBe(
      "/managed/npm/lib/node_modules/glm-acp-agent/dist/llm/glm-client.js",
    );
  });

  it("locates the GLM ACP transport for a Node-launched package entry", () => {
    expect(
      glmAcpClientModulePath("/usr/bin/node", ["/repo/node_modules/glm-acp-agent/dist/index.js"]),
    ).toBe("/repo/node_modules/glm-acp-agent/dist/llm/glm-client.js");
  });

  it("locates the GLM ACP transport beside a pnpm workspace launcher", () => {
    expect(
      glmAcpClientModulePath(
        "/data/programs/t3code/packages/provider-acp-registry/node_modules/.bin/glm-acp-agent",
      ),
    ).toBe(
      "/data/programs/t3code/packages/provider-acp-registry/node_modules/glm-acp-agent/dist/llm/glm-client.js",
    );
  });

  it.effect("keeps native ACP registry launch inputs unchanged", () =>
    Effect.gen(function* () {
      const spawn = {
        command: "/managed/codex",
        args: ["--acp"],
        cwd: "/project",
        env: { TEST: "1" },
      };
      const result = yield* prepareBiliRegistrySpawn({
        settings: decodeSettings({ agentId: "codex" }),
        spawn,
        policy: decodeLauncherSettings({ launcher: "native" }),
      });
      expect(result).toEqual(spawn);
    }),
  );

  it.effect("wraps a verified ACP launch with the selected Bili binary", () =>
    Effect.gen(function* () {
      const result = yield* prepareBiliRegistrySpawn({
        settings: decodeSettings({ agentId: "codex" }),
        spawn: { command: "/managed/codex", args: ["--acp"] },
        policy: decodeLauncherSettings({ launcher: "bili", biliBinaryPath: "/opt/bili" }),
      });
      expect(result).toEqual({
        command: "/opt/bili",
        args: ["--bin", "/managed/codex", "codex", "--acp"],
        env: {},
      });
    }),
  );

  it.effect("wraps Gemini CLI with pxpipe warp", () =>
    Effect.gen(function* () {
      const result = yield* prepareBiliRegistrySpawn({
        settings: decodeSettings({ agentId: "gemini" }),
        spawn: { command: "/managed/gemini", args: ["--acp"] },
        policy: { ...decodeLauncherSettings({}), launcher: "pxpipe" },
      });
      expect(result).toEqual({
        command: "pxpipe",
        args: ["warp", "--", "/managed/gemini", "--acp"],
      });
    }),
  );

  it.effect("refuses an unverified custom ACP launch in Bili mode", () =>
    Effect.gen(function* () {
      const result = yield* prepareBiliRegistrySpawn({
        settings: decodeSettings({
          agentId: "custom-agent",
          source: "local",
          commandPath: "/opt/agent",
        }),
        spawn: { command: "/opt/agent", args: ["--acp"] },
        policy: decodeLauncherSettings({ launcher: "bili" }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("AcpSpawnError");
    }),
  );
});
