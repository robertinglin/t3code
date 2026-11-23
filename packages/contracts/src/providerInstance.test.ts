import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceConfig, ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});

describe("ProviderInstanceConfig agent launcher", () => {
  it("keeps an explicit per-instance launcher and leaves unset values inherited", () => {
    const decode = Schema.decodeUnknownSync(ProviderInstanceConfig);
    expect(decode({ driver: "codex", agentLauncher: "bili" }).agentLauncher).toBe("bili");
    expect(decode({ driver: "acpRegistry", agentLauncher: "pxpipe" }).agentLauncher).toBe("pxpipe");
    expect(decode({ driver: "codex" }).agentLauncher).toBeUndefined();
  });
});
