import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type MigrationRow = { readonly id: number; readonly name: string };
type MigrationManifest = ReadonlyArray<readonly [id: number, name: string]>;

const legacyCovenMigrationIds = [92, 103] as const;

export function legacyCovenMigrationId(
  history: ReadonlyArray<MigrationRow>,
  mainManifest: MigrationManifest,
): number | undefined {
  for (const legacyId of legacyCovenMigrationIds) {
    const mainPrefix = mainManifest.filter(([id]) => id < legacyId);
    if (history.length !== mainPrefix.length + 1) continue;

    const matchesMainPrefix = mainPrefix.every(
      ([id, name], index) => history[index]?.id === id && history[index]?.name === name,
    );
    const legacyRow = history[history.length - 1];
    if (matchesMainPrefix && legacyRow?.id === legacyId && legacyRow.name === "Covens") {
      return legacyId;
    }
  }

  return undefined;
}

export const reconcileLegacyCovenMigration = Effect.fn("reconcileLegacyCovenMigration")(function* (
  mainManifest: MigrationManifest,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return false;

      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      const legacyId = legacyCovenMigrationId(
        history.map((row) => ({ id: row.migration_id, name: row.name })),
        mainManifest,
      );
      if (legacyId === undefined) return false;

      yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${legacyId} AND name = 'Covens'
        `;
      return true;
    }),
  );
});
