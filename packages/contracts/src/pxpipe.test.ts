import { describe, expect, it } from "vite-plus/test";

import { isPxpipeDefaultProvider } from "./pxpipe.ts";

describe("pxpipe defaults", () => {
  it("selects Gemini CLI and Antigravity", () => {
    expect(isPxpipeDefaultProvider("antigravity", undefined)).toBe(true);
    expect(isPxpipeDefaultProvider("acpRegistry", { agentId: "Gemini" })).toBe(true);
  });

  it("leaves other providers on the server default", () => {
    expect(isPxpipeDefaultProvider("acpRegistry", { agentId: "claude" })).toBe(false);
    expect(isPxpipeDefaultProvider("codex", undefined)).toBe(false);
    expect(isPxpipeDefaultProvider("acpRegistry", null)).toBe(false);
  });
});
