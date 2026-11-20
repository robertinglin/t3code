import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS covens (
      coven_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_covens_active_slug
    ON covens(slug) WHERE archived_at IS NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_revisions (
      coven_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (coven_id, revision)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_coven_bindings (
      thread_id TEXT PRIMARY KEY,
      coven_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bound_at TEXT NOT NULL
    )
  `;
  // One row per coven run; the run's tasks, attempts, gates and approvals are
  // its state document, changed only under the run's lock.
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_runs (
      run_id TEXT PRIMARY KEY,
      leader_thread_id TEXT NOT NULL,
      coven_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_coven_runs_leader
    ON coven_runs(leader_thread_id, started_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_run_children (
      child_thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      role_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_cooldowns (
      provider_instance_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reset_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, model_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS coven_drafts (
      draft_id TEXT PRIMARY KEY,
      builder_thread_id TEXT UNIQUE,
      base_coven_id TEXT,
      base_revision INTEGER,
      source TEXT NOT NULL,
      version INTEGER NOT NULL,
      last_change_by TEXT NOT NULL,
      last_change_summary TEXT,
      saved_revision INTEGER,
      updated_at TEXT NOT NULL
    )
  `;
});
