import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  covenMigrationManifest,
  hasPendingCovenMigrations,
  runCovenMigrations,
} from "./CovenMigrations.ts";

it.effect("records coven schema versions in an independent ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.isTrue(yield* hasPendingCovenMigrations());
    assert.deepStrictEqual(yield* runCovenMigrations(), covenMigrationManifest);
    assert.isFalse(yield* hasPendingCovenMigrations());
    assert.deepStrictEqual(yield* runCovenMigrations(), []);

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    assert.include(
      tables.map((row) => row.name),
      "coven_sql_migrations",
    );
    assert.notInclude(
      tables.map((row) => row.name),
      "effect_sql_migrations",
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM coven_sql_migrations ORDER BY migration_id
      `,
      [{ migration_id: 1, name: "Covens" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("registers each coven migration file in its separate manifest", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "CovenMigrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      covenMigrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
