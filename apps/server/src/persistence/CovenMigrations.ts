import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./CovenMigrations/001_Covens.ts";

const migrationEntries = [[1, "Covens", Migration0001]] as const;

export const covenMigrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const run = Migrator.make({});
const table = "coven_sql_migrations";
const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

export const hasPendingCovenMigrations = Effect.fn("hasPendingCovenMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  if (tables.length === 0) return true;

  const [latest] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM ${sql(table)}
  `;
  return (latest?.id ?? 0) < (migrationEntries.at(-1)?.[0] ?? 0);
});

export const runCovenMigrations = Effect.fn("runCovenMigrations")(function* () {
  return yield* run({ loader, table });
});
