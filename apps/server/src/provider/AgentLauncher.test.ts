import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AgentLauncherSettings } from "@t3tools/contracts/settings";
import { resolveAgentLaunch } from "./AgentLauncher.ts";

const settings = Schema.decodeSync(AgentLauncherSettings);

it("keeps native executable and arguments unchanged", () => {
  const env = { API_TOKEN: "test" };
  assert.deepEqual(
    resolveAgentLaunch(
      {
        agent: "codex",
        executable: "/opt/codex",
        args: ["--resume", "id"],
        cwd: "/repo",
        env,
      },
      settings({ launcher: "native" }),
    ),
    {
      _tag: "Resolved",
      launch: { command: "/opt/codex", args: ["--resume", "id"], cwd: "/repo", env },
    },
  );
});

it("uses the configured bili executable and preserves agent argument order", () => {
  const env = { API_TOKEN: "test" };
  assert.deepEqual(
    resolveAgentLaunch(
      {
        agent: "codex",
        executable: "/opt/codex",
        args: ["--resume", "id"],
        cwd: "/repo",
        env,
        biliCompatibility: { supported: true },
      },
      settings({ launcher: "bili", biliBinaryPath: "/opt/bin/bili" }),
    ),
    {
      _tag: "Resolved",
      launch: {
        command: "/opt/bin/bili",
        args: ["--bin", "/opt/codex", "codex", "--resume", "id"],
        cwd: "/repo",
        env,
      },
    },
  );
});

it("uses bili's Qwen proxy lane to launch Cline's ACP executable", () => {
  assert.deepEqual(
    resolveAgentLaunch(
      {
        agent: "qwen",
        executable: "/managed/cline/bin/cline",
        args: ["--acp"],
        env: { CLINE_PROVIDER: "cline-pass" },
        biliEnvironment: {
          NODE_USE_ENV_PROXY: "1",
        },
        biliOptions: ["--mitm-domain", "api.cline.bot"],
        biliCompatibility: { supported: true },
      },
      settings({ launcher: "bili" }),
    ),
    {
      _tag: "Resolved",
      launch: {
        command: "bili",
        args: [
          "--mitm-domain",
          "api.cline.bot",
          "--bin",
          "/managed/cline/bin/cline",
          "qwen",
          "--acp",
        ],
        env: {
          CLINE_PROVIDER: "cline-pass",
          NODE_USE_ENV_PROXY: "1",
        },
      },
    },
  );
});

it("does not fall back to native when bili does not support the requested launch", () => {
  assert.deepEqual(
    resolveAgentLaunch(
      {
        agent: "custom-acp",
        executable: "/opt/custom-acp",
        args: ["--stdio"],
        biliCompatibility: {
          supported: false,
          reason: "This ACP executable has no bili launcher.",
        },
      },
      settings({ launcher: "bili" }),
    ),
    {
      _tag: "Unsupported",
      message:
        "custom-acp cannot be launched through bili: This ACP executable has no bili launcher.",
    },
  );
});
