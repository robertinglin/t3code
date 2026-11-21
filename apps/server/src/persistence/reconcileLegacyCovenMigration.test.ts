import { expect, it } from "@effect/vitest";

import { migrationManifest } from "./Migrations.ts";
import { legacyCovenMigrationId } from "./reconcileLegacyCovenMigration.ts";

it("recognizes the old coven entry at id 92", () => {
  const history = [
    ...migrationManifest.filter(([id]) => id < 92).map(([id, name]) => ({ id, name })),
    { id: 92, name: "Covens" },
  ];

  expect(legacyCovenMigrationId(history, migrationManifest)).toBe(92);
});

it("recognizes the temporary coven entry at id 103 when main also reaches 103", () => {
  const history = [
    ...migrationManifest.filter(([id]) => id < 103).map(([id, name]) => ({ id, name })),
    { id: 103, name: "Covens" },
  ];

  expect(legacyCovenMigrationId(history, migrationManifest)).toBe(103);
});

it("leaves unrelated or extended migration histories alone", () => {
  const prefix = migrationManifest.filter(([id]) => id < 92).map(([id, name]) => ({ id, name }));

  expect(
    legacyCovenMigrationId(
      [...prefix, { id: 92, name: "Covens" }, { id: 93, name: "Unknown" }],
      migrationManifest,
    ),
  ).toBeUndefined();
  expect(
    legacyCovenMigrationId(
      [...prefix.slice(0, -1), { id: 91, name: "Unknown" }, { id: 92, name: "Covens" }],
      migrationManifest,
    ),
  ).toBeUndefined();
});
