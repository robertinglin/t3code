import { expect, it } from "@effect/vitest";

import { standaloneBiliEnvironment } from "./localBiliEnvironment.ts";

it("uses the standalone XDG config and session directories for Bili", () => {
  expect(standaloneBiliEnvironment({}, "/home/test")).toEqual({
    BILI_CONFIG_FILE: "/home/test/.config/billion-context/billion-context.json",
    BILI_SESSIONS_DIR: "/home/test/.local/share/billion-context/sessions",
  });
});

it("preserves Bili-specific config paths and respects custom XDG directories", () => {
  expect(
    standaloneBiliEnvironment(
      {
        XDG_CONFIG_HOME: "/config",
        XDG_DATA_HOME: "/data",
        BILI_CONFIG_FILE: "/bili/custom.json",
        BILI_SESSIONS_DIR: "/bili/sessions",
      },
      "/home/test",
    ),
  ).toEqual({
    BILI_CONFIG_FILE: "/bili/custom.json",
    BILI_SESSIONS_DIR: "/bili/sessions",
  });
});
