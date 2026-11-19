import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { CovenToolkit } from "./tools.ts";

it("accepts a numeric draft version in coven_builder_propose_patch", () => {
  const tool = CovenToolkit.tools.coven_builder_propose_patch;
  const decode = Schema.decodeUnknownExit(tool.parametersSchema);
  expect(
    Exit.isSuccess(decode({ source: "---\n---\n", expectedVersion: 1, summary: "Rename" })),
  ).toBe(true);
  const schema = advertisedJsonSchema(tool) as {
    readonly properties: Readonly<Record<string, unknown>>;
  };
  expect(schema.properties.expectedVersion).toMatchObject({ type: "integer" });
});

// Schema.Number advertises a string branch ("Infinity" | "-Infinity" | "NaN"), so clients
// send numbers as strings and the call fails validation before the handler runs.
it("advertises no non-finite number branches on any coven tool", () => {
  for (const tool of Object.values(CovenToolkit.tools)) {
    expect(JSON.stringify(advertisedJsonSchema(tool)), tool.name).not.toContain("Infinity");
  }
});
