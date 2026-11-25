import { describe, expect, it } from "vite-plus/test";

import {
  defaultAgentLauncher,
  isGoogleModel,
  isModelRoutedLauncherProvider,
  isPxpipeDefaultProvider,
} from "./pxpipe.ts";

describe("pxpipe defaults", () => {
  it("selects Gemini CLI and routes Antigravity by model family", () => {
    expect(defaultAgentLauncher("antigravity", undefined)).toBe("model-aware");
    expect(defaultAgentLauncher("acpRegistry", { agentId: "Gemini" })).toBe("pxpipe");
    expect(defaultAgentLauncher("acpRegistry", { agentId: "claude" })).toBeUndefined();
    expect(isPxpipeDefaultProvider("acpRegistry", { agentId: "Gemini" })).toBe(true);
    expect(isPxpipeDefaultProvider("antigravity", undefined)).toBe(false);
    expect(isModelRoutedLauncherProvider("antigravity")).toBe(true);
    expect(isModelRoutedLauncherProvider("codex")).toBe(false);
    expect(isGoogleModel("gemini-3.8-flash")).toBe(true);
    expect(isGoogleModel("google/gemini-3.8-flash")).toBe(true);
    expect(isGoogleModel("antigravity-default")).toBe(true);
    expect(isGoogleModel("claude-sonnet-4-5")).toBe(false);
    expect(isGoogleModel("gpt-5")).toBe(false);
  });

  it("leaves other providers on the server default", () => {
    expect(isPxpipeDefaultProvider("acpRegistry", { agentId: "claude" })).toBe(false);
    expect(isPxpipeDefaultProvider("codex", undefined)).toBe(false);
    expect(isPxpipeDefaultProvider("acpRegistry", null)).toBe(false);
  });
});
