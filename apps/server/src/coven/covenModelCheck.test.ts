import { describe, expect, it } from "vite-plus/test";
import {
  parseCovenSource,
  starterCovenSource,
  withCovenFrontMatter,
} from "@t3tools/shared/covenDefinition";

import { checkCovenModels } from "./covenModelCheck.ts";

const withLeaderOptions = (options: Record<string, unknown>) => {
  const source = withCovenFrontMatter(
    starterCovenSource({
      id: "check",
      name: "Check",
      leader: { providerInstanceId: "claudeAgent", modelId: "claude-opus-5-5" },
    }),
    (frontMatter) => ({
      ...frontMatter,
      roles: (frontMatter.roles as ReadonlyArray<Record<string, unknown>>).map((role) => ({
        ...role,
        candidates: [
          {
            providerInstanceId: "claudeAgent",
            modelId: "claude-opus-5-5",
            options: { ...options },
          },
        ],
      })),
    }),
  );
  const parsed = parseCovenSource(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.definition;
};

const catalog = [
  {
    providerInstanceId: "claudeAgent",
    models: [
      { id: "claude-opus-5-5", options: [{ id: "effort", values: ["low", "medium", "high"] }] },
    ],
  },
];

describe("checkCovenModels", () => {
  it("accepts a real option and value", () => {
    expect(checkCovenModels(withLeaderOptions({ effort: "medium" }), catalog)).toEqual([]);
  });

  it("flags an unknown option name and a bad value", () => {
    const messages = checkCovenModels(
      withLeaderOptions({ reasoningEffort: "medium" }),
      catalog,
    ).map((issue) => issue.message);
    expect(messages[0]).toMatch(/no option reasoningEffort. Its options: effort/);
    expect(checkCovenModels(withLeaderOptions({ effort: "ultra" }), catalog)[0]?.message).toMatch(
      /must be one of: low, medium, high/,
    );
  });

  it("flags a model the provider doesn't offer", () => {
    const issues = checkCovenModels(withLeaderOptions({}), [
      { providerInstanceId: "claudeAgent", models: [] },
    ]);
    expect(issues[0]?.message).toMatch(/isn't offered/);
  });
});
