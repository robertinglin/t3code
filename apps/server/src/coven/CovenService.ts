import {
  type CovenCooldown,
  type CovenDefinition,
  type CovenDetail,
  type CovenDraft,
  type CovenDraftUpdate,
  CovenError,
  type CovenEventSummary,
  type CovenListResult,
  type CovenRevision,
  type CovenSummary,
  type ThreadCovenBinding,
  type ThreadCovenState,
  ThreadId,
} from "@t3tools/contracts";
import {
  covenDigest,
  parseCovenSource,
  withCovenFrontMatter,
} from "@t3tools/shared/covenDefinition";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { pickCovenCandidate } from "@t3tools/shared/covenRuntime";

import * as ServerConfig from "../config.ts";
import {
  type CovenRunEventInput,
  type CovenRunRecord,
  type CovenRunState,
  initialRunState,
  isRunActive,
  leaderRole,
  toRunView,
} from "./covenRunState.ts";

/** How a thread takes part in a coven: as the leader that owns the binding, or as a delegated worker. */
export type CovenThreadScope =
  | {
      readonly kind: "leader";
      readonly binding: ThreadCovenBinding;
      readonly definition: CovenDefinition;
      /** The run in progress, if any. Its definition revision may predate the binding's. */
      readonly run: CovenRunRecord | null;
    }
  | {
      readonly kind: "worker";
      readonly roleId: string;
      readonly taskId: string;
      readonly leaderThreadId: ThreadId;
      readonly binding: ThreadCovenBinding;
      readonly definition: CovenDefinition;
      readonly run: CovenRunRecord;
    };

export interface CovenChildLink {
  readonly runId: string;
  readonly taskId: string;
  readonly roleId: string;
}

export interface CovenRunChange<A> {
  readonly state: CovenRunState;
  readonly events?: ReadonlyArray<CovenRunEventInput>;
  readonly result: A;
}

export class CovenService extends Context.Service<
  CovenService,
  {
    readonly subscribeList: (input: {
      readonly includeArchived?: boolean | undefined;
    }) => Stream.Stream<CovenListResult, CovenError>;
    readonly list: (input: {
      readonly includeArchived?: boolean | undefined;
    }) => Effect.Effect<CovenListResult, CovenError>;
    readonly get: (covenId: string) => Effect.Effect<CovenDetail, CovenError>;
    readonly getRevision: (
      covenId: string,
      revision: number,
    ) => Effect.Effect<CovenRevision, CovenError>;
    readonly save: (input: {
      readonly source: string;
      readonly expectedRevision?: number | undefined;
    }) => Effect.Effect<CovenDetail, CovenError>;
    readonly archive: (covenId: string) => Effect.Effect<{ readonly covenId: string }, CovenError>;
    /** Threads the coven is attached to. */
    readonly boundThreads: (covenId: string) => Effect.Effect<ReadonlyArray<ThreadId>, CovenError>;
    readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<ThreadCovenState, CovenError>;
    readonly threadState: (threadId: ThreadId) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly setThread: (
      threadId: ThreadId,
      covenId: string,
    ) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly clearThread: (threadId: ThreadId) => Effect.Effect<ThreadCovenState, CovenError>;
    readonly threadScope: (
      threadId: ThreadId,
    ) => Effect.Effect<CovenThreadScope | null, CovenError>;
    readonly definitionAt: (
      covenId: string,
      revision: number,
    ) => Effect.Effect<CovenDefinition | null, CovenError>;
    /** The leader's run in progress; starts one when the thread has a coven and none is running. */
    readonly ensureRun: (
      leaderThreadId: ThreadId,
    ) => Effect.Effect<CovenRunRecord | null, CovenError>;
    readonly getRun: (runId: string) => Effect.Effect<CovenRunRecord | null, CovenError>;
    readonly activeRuns: Effect.Effect<ReadonlyArray<CovenRunRecord>, CovenError>;
    /** Changes a run under its lock. The change function must not call back into this service. */
    readonly updateRun: <A>(
      runId: string,
      change: (record: CovenRunRecord) => Effect.Effect<CovenRunChange<A>, CovenError>,
    ) => Effect.Effect<A, CovenError>;
    readonly runEvents: (
      runId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<CovenEventSummary>, CovenError>;
    readonly childLink: (
      childThreadId: ThreadId,
    ) => Effect.Effect<CovenChildLink | null, CovenError>;
    readonly registerChild: (
      childThreadId: ThreadId,
      link: CovenChildLink,
    ) => Effect.Effect<void, CovenError>;
    readonly cooldowns: Effect.Effect<ReadonlyArray<CovenCooldown>, CovenError>;
    readonly addCooldown: (cooldown: CovenCooldown) => Effect.Effect<void, CovenError>;
    readonly clearCooldown: (
      providerInstanceId: string,
      modelId: string,
    ) => Effect.Effect<void, CovenError>;
    readonly createDraft: (input: {
      readonly builderThreadId: ThreadId | null;
      readonly baseCovenId: string | null;
      readonly baseRevision: number | null;
      readonly source: string;
    }) => Effect.Effect<CovenDraft, CovenError>;
    readonly setDraftThread: (
      draftId: string,
      builderThreadId: ThreadId,
    ) => Effect.Effect<CovenDraft, CovenError>;
    readonly getDraft: (draftId: string) => Effect.Effect<CovenDraft | null, CovenError>;
    readonly draftForThread: (threadId: ThreadId) => Effect.Effect<CovenDraft | null, CovenError>;
    readonly updateDraft: (input: {
      readonly draftId: string;
      readonly source: string;
      readonly expectedVersion: number;
      readonly by: CovenDraft["lastChangeBy"];
      readonly summary: string | null;
    }) => Effect.Effect<CovenDraft, CovenError>;
    readonly markDraftSaved: (
      draftId: string,
      covenId: string,
      revision: number,
    ) => Effect.Effect<CovenDraft, CovenError>;
    /** Ids of runs as they change, for projections such as the run's docs folder. */
    readonly runChanges: Stream.Stream<string>;
    readonly subscribeDraft: (draftId: string) => Stream.Stream<CovenDraftUpdate, CovenError>;
  }
>()("t3/coven/CovenService") {}

interface CovenRow {
  readonly coven_id: string;
  readonly slug: string;
  readonly name: string;
  readonly current_revision: number;
  readonly archived_at: string | null;
  readonly updated_at: string;
  readonly source: string;
}

interface RunRow {
  readonly run_id: string;
  readonly leader_thread_id: string;
  readonly coven_id: string;
  readonly revision: number;
  readonly state_json: string;
  readonly started_at: string;
  readonly ended_at: string | null;
}

interface DraftRow {
  readonly draft_id: string;
  readonly builder_thread_id: string | null;
  readonly base_coven_id: string | null;
  readonly base_revision: number | null;
  readonly source: string;
  readonly version: number;
  readonly last_change_by: string;
  readonly last_change_summary: string | null;
  readonly saved_revision: number | null;
  readonly updated_at: string;
}

interface BindingRow {
  readonly thread_id: string;
  readonly coven_id: string;
  readonly revision: number;
  readonly bound_at: string;
  readonly name: string;
  readonly slug: string;
}

const encodeStateJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const storageError = (message: string) => (cause: unknown) =>
  new CovenError({
    reason: "conflict",
    message: `${message}${cause instanceof Error && cause.message ? ` ${cause.message}` : ""}`,
  });

const notFound = (message: string) => new CovenError({ reason: "not-found", message });

function parseStored(source: string): CovenDefinition | null {
  const parsed = parseCovenSource(source);
  return parsed.ok ? parsed.definition : null;
}

function summarize(row: CovenRow, definition: CovenDefinition): CovenSummary {
  const frontMatter = definition.frontMatter;
  return {
    id: row.coven_id,
    slug: row.slug,
    name: row.name,
    description: frontMatter.description ?? "",
    aliases: frontMatter.aliases ?? [],
    revision: row.current_revision,
    roles: frontMatter.roles.map((role) => ({
      id: role.id,
      kind: role.kind,
      name: role.name,
      primary: role.candidates[0]!,
      fallbackCount: role.candidates.length - 1,
    })),
    archived: row.archived_at !== null,
    updatedAt: row.updated_at,
  };
}

function toBinding(row: BindingRow): ThreadCovenBinding {
  return {
    threadId: ThreadId.make(row.thread_id),
    covenId: row.coven_id,
    revision: row.revision,
    name: row.name,
    slug: row.slug,
    boundAt: row.bound_at,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const covensDir = path.join(config.stateDir, "covens");

  const readRows = (input: { readonly includeArchived?: boolean | undefined }) =>
    sql<CovenRow>`
      SELECT c.coven_id, c.slug, c.name, c.current_revision, c.archived_at, c.updated_at, r.source
      FROM covens c
      JOIN coven_revisions r ON r.coven_id = c.coven_id AND r.revision = c.current_revision
      WHERE ${input.includeArchived === true ? sql`1 = 1` : sql`c.archived_at IS NULL`}
      ORDER BY c.name COLLATE NOCASE
    `.pipe(Effect.mapError(storageError("Could not read covens.")));

  const list: CovenService["Service"]["list"] = Effect.fn("CovenService.list")(function* (input) {
    const rows = yield* readRows(input);
    const covens: CovenSummary[] = [];
    for (const row of rows) {
      const definition = parseStored(row.source);
      if (definition !== null) covens.push(summarize(row, definition));
    }
    return { covens };
  });

  const readRow = (covenId: string) =>
    sql<CovenRow>`
      SELECT c.coven_id, c.slug, c.name, c.current_revision, c.archived_at, c.updated_at, r.source
      FROM covens c
      JOIN coven_revisions r ON r.coven_id = c.coven_id AND r.revision = c.current_revision
      WHERE c.coven_id = ${covenId}
    `.pipe(
      Effect.mapError(storageError("Could not read the coven.")),
      Effect.map((rows) => rows[0] ?? null),
    );

  const get: CovenService["Service"]["get"] = Effect.fn("CovenService.get")(function* (covenId) {
    const row = yield* readRow(covenId);
    const definition = row === null ? null : parseStored(row.source);
    if (row === null || definition === null) {
      return yield* notFound(`No coven has the id ${covenId}.`);
    }
    const revisions = yield* sql<{ revision: number; digest: string; created_at: string }>`
      SELECT revision, digest, created_at FROM coven_revisions
      WHERE coven_id = ${covenId} ORDER BY revision DESC
    `.pipe(Effect.mapError(storageError("Could not read coven history.")));
    return {
      summary: summarize(row, definition),
      source: row.source,
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        digest: revision.digest,
        createdAt: revision.created_at,
      })),
    };
  });

  // The database is authoritative; the file is a readable copy for the user.
  const writeRevisionFile = (covenId: string, revision: number, source: string) => {
    const directory = path.join(covensDir, covenId);
    const target = path.join(directory, `rev-${String(revision).padStart(4, "0")}.md`);
    return fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(`${target}.tmp`, source)),
      Effect.andThen(fs.rename(`${target}.tmp`, target)),
      Effect.catch((cause) =>
        Effect.logWarning("Could not write the coven revision file.", { covenId, cause }),
      ),
    );
  };

  const save: CovenService["Service"]["save"] = Effect.fn("CovenService.save")(function* (input) {
    const parsed = parseCovenSource(input.source);
    if (!parsed.ok) {
      return yield* new CovenError({
        reason: "invalid-definition",
        message: parsed.issues[0]?.message ?? "The coven definition is not valid.",
        issues: parsed.issues,
      });
    }
    const frontMatter = parsed.definition.frontMatter;
    const existing = yield* readRow(frontMatter.id);
    if (
      existing !== null &&
      input.expectedRevision !== undefined &&
      existing.current_revision !== input.expectedRevision
    ) {
      return yield* new CovenError({
        reason: "conflict",
        message: `This coven changed since you opened it (now revision ${existing.current_revision}).`,
      });
    }
    const revision = existing === null ? 1 : existing.current_revision + 1;
    const source = withCovenFrontMatter(parsed.source, (current) => ({ ...current, revision }));
    const reparsed = parseCovenSource(source);
    if (!reparsed.ok) {
      return yield* new CovenError({
        reason: "invalid-definition",
        message: "The coven definition could not be stored.",
        issues: reparsed.issues,
      });
    }
    const digest = yield* Effect.promise(() => covenDigest(reparsed.definition));
    const now = yield* nowIso;
    const slugOwner = yield* sql<{ coven_id: string }>`
      SELECT coven_id FROM covens
      WHERE slug = ${frontMatter.slug} AND archived_at IS NULL AND coven_id <> ${frontMatter.id}
    `.pipe(Effect.mapError(storageError("Could not check the coven slug.")));
    if (slugOwner.length > 0) {
      return yield* new CovenError({
        reason: "conflict",
        message: `Another coven already uses the slug "${frontMatter.slug}".`,
      });
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO coven_revisions (coven_id, revision, source, digest, created_at)
            VALUES (${frontMatter.id}, ${revision}, ${source}, ${digest}, ${now})
          `;
          yield* existing === null
            ? sql`
                INSERT INTO covens (coven_id, slug, name, current_revision, archived_at, created_at, updated_at)
                VALUES (${frontMatter.id}, ${frontMatter.slug}, ${frontMatter.name}, ${revision}, NULL, ${now}, ${now})
              `
            : sql`
                UPDATE covens
                SET slug = ${frontMatter.slug}, name = ${frontMatter.name},
                    current_revision = ${revision}, archived_at = NULL, updated_at = ${now}
                WHERE coven_id = ${frontMatter.id}
              `;
        }),
      )
      .pipe(Effect.mapError(storageError("Could not save the coven.")));
    yield* writeRevisionFile(frontMatter.id, revision, source);
    yield* notifyChanged;
    return yield* get(frontMatter.id);
  });

  const archive: CovenService["Service"]["archive"] = Effect.fn("CovenService.archive")(
    function* (covenId) {
      const now = yield* nowIso;
      const updated = yield* sql<{ coven_id: string }>`
        UPDATE covens SET archived_at = ${now}, updated_at = ${now}
        WHERE coven_id = ${covenId} AND archived_at IS NULL
        RETURNING coven_id
      `.pipe(Effect.mapError(storageError("Could not archive the coven.")));
      if (updated.length === 0) return yield* notFound(`No active coven has the id ${covenId}.`);
      yield* notifyChanged;
      return { covenId };
    },
  );

  const boundThreads: CovenService["Service"]["boundThreads"] = (covenId) =>
    sql<{ thread_id: string }>`
      SELECT thread_id FROM thread_coven_bindings WHERE coven_id = ${covenId}
    `.pipe(
      Effect.mapError(storageError("Could not read the coven's threads.")),
      Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
    );

  const readBinding = (threadId: string) =>
    sql<BindingRow>`
      SELECT b.thread_id, b.coven_id, b.revision, b.bound_at, c.name, c.slug
      FROM thread_coven_bindings b JOIN covens c ON c.coven_id = b.coven_id
      WHERE b.thread_id = ${threadId}
    `.pipe(
      Effect.mapError(storageError("Could not read the thread's coven.")),
      Effect.map((rows) => (rows[0] === undefined ? null : toBinding(rows[0]))),
    );

  const definitionAt: CovenService["Service"]["definitionAt"] = (covenId, revision) =>
    sql<{ source: string }>`
      SELECT source FROM coven_revisions
      WHERE coven_id = ${covenId} AND revision = ${revision}
    `.pipe(
      Effect.mapError(storageError("Could not read the coven revision.")),
      Effect.map((rows) => (rows[0] === undefined ? null : parseStored(rows[0].source))),
    );

  const getRevision: CovenService["Service"]["getRevision"] = Effect.fn("CovenService.getRevision")(
    function* (covenId, revision) {
      const rows = yield* sql<{ source: string; digest: string; created_at: string }>`
      SELECT source, digest, created_at FROM coven_revisions
      WHERE coven_id = ${covenId} AND revision = ${revision}
    `.pipe(Effect.mapError(storageError("Could not read the coven revision.")));
      const row = rows[0];
      if (row === undefined)
        return yield* notFound(`Coven ${covenId} has no revision ${revision}.`);
      return {
        covenId,
        revision,
        source: row.source,
        digest: row.digest,
        createdAt: row.created_at,
      };
    },
  );

  const toRecord = (row: RunRow): CovenRunRecord => ({
    id: row.run_id,
    leaderThreadId: ThreadId.make(row.leader_thread_id),
    covenId: row.coven_id,
    revision: row.revision,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: JSON.parse(row.state_json) as CovenRunState,
  });

  const runColumns = sql`run_id, leader_thread_id, coven_id, revision, state_json, started_at, ended_at`;

  const getRun: CovenService["Service"]["getRun"] = (runId) =>
    sql<RunRow>`SELECT ${runColumns} FROM coven_runs WHERE run_id = ${runId}`.pipe(
      Effect.mapError(storageError("Could not read the coven run.")),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
    );

  const latestRun = (leaderThreadId: string) =>
    sql<RunRow>`
      SELECT ${runColumns} FROM coven_runs
      WHERE leader_thread_id = ${leaderThreadId}
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `.pipe(
      Effect.mapError(storageError("Could not read the coven run.")),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
    );

  const activeRunFor = (leaderThreadId: string) =>
    latestRun(leaderThreadId).pipe(
      Effect.map((run) => (run !== null && isRunActive(run.state.status) ? run : null)),
    );

  const activeRuns: CovenService["Service"]["activeRuns"] = sql<RunRow>`
    SELECT ${runColumns} FROM coven_runs WHERE ended_at IS NULL
  `.pipe(
    Effect.mapError(storageError("Could not read coven runs.")),
    Effect.map((rows) => rows.map(toRecord)),
  );

  const runEvents: CovenService["Service"]["runEvents"] = (runId, limit) =>
    sql<{ seq: number; kind: string; summary: string; created_at: string }>`
      SELECT seq, kind, summary, created_at FROM coven_run_events
      WHERE run_id = ${runId} ORDER BY seq DESC LIMIT ${limit}
    `.pipe(
      Effect.mapError(storageError("Could not read coven activity.")),
      Effect.map((rows) =>
        rows
          .map((row) => ({
            seq: row.seq,
            kind: row.kind,
            summary: row.summary,
            createdAt: row.created_at,
          }))
          .reverse(),
      ),
    );

  const appendEvents = (runId: string, events: ReadonlyArray<CovenRunEventInput>, now: string) =>
    Effect.forEach(
      events,
      (event) => sql`
        INSERT INTO coven_run_events (run_id, seq, kind, summary, created_at)
        VALUES (
          ${runId},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM coven_run_events WHERE run_id = ${runId}),
          ${event.kind}, ${event.summary.slice(0, 2_000)}, ${now}
        )
      `,
      { discard: true },
    );

  const cooldowns: CovenService["Service"]["cooldowns"] = Effect.gen(function* () {
    const now = yield* nowIso;
    const rows = yield* sql<{
      provider_instance_id: string;
      model_id: string;
      reset_at: string;
      reason: string;
      recorded_at: string;
    }>`
      SELECT provider_instance_id, model_id, reset_at, reason, recorded_at
      FROM coven_cooldowns WHERE reset_at > ${now} ORDER BY reset_at
    `.pipe(Effect.mapError(storageError("Could not read model cooldowns.")));
    return rows.map((row) => ({
      providerInstanceId: row.provider_instance_id,
      modelId: row.model_id,
      resetAt: row.reset_at,
      reason: row.reason,
      recordedAt: row.recorded_at,
    }));
  });

  const addCooldown: CovenService["Service"]["addCooldown"] = (cooldown) =>
    sql`
      INSERT INTO coven_cooldowns (provider_instance_id, model_id, reset_at, reason, recorded_at)
      VALUES (${cooldown.providerInstanceId}, ${cooldown.modelId}, ${cooldown.resetAt},
              ${cooldown.reason}, ${cooldown.recordedAt})
      ON CONFLICT (provider_instance_id, model_id) DO UPDATE SET
        reset_at = excluded.reset_at, reason = excluded.reason, recorded_at = excluded.recorded_at
    `.pipe(
      Effect.mapError(storageError("Could not record the cooldown.")),
      Effect.andThen(notifyChanged),
    );

  const clearCooldown: CovenService["Service"]["clearCooldown"] = (providerInstanceId, modelId) =>
    sql`
      DELETE FROM coven_cooldowns
      WHERE provider_instance_id = ${providerInstanceId} AND model_id = ${modelId}
    `.pipe(
      Effect.mapError(storageError("Could not clear the cooldown.")),
      Effect.andThen(notifyChanged),
    );

  const runLock = yield* Semaphore.make(1);
  const runChangeHub = yield* PubSub.sliding<string>(64);

  const updateRun: CovenService["Service"]["updateRun"] = (runId, change) =>
    runLock.withPermit(
      Effect.gen(function* () {
        const record = yield* getRun(runId);
        if (record === null) return yield* notFound(`No coven run has the id ${runId}.`);
        const next = yield* change(record);
        const now = yield* nowIso;
        const ended = !isRunActive(next.state.status);
        const stateJson = yield* encodeStateJson(next.state).pipe(
          Effect.mapError(storageError("Could not save the coven run.")),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE coven_runs SET
                  status = ${next.state.status},
                  state_json = ${stateJson},
                  updated_at = ${now},
                  ended_at = ${ended ? (record.endedAt ?? now) : null}
                WHERE run_id = ${runId}
              `;
              yield* appendEvents(runId, next.events ?? [], now);
            }),
          )
          .pipe(Effect.mapError(storageError("Could not update the coven run.")));
        yield* notifyChanged;
        yield* PubSub.publish(runChangeHub, runId);
        return next.result;
      }),
    );

  const readBindingOrNull = (threadId: string) => readBinding(threadId);

  const ensureRun: CovenService["Service"]["ensureRun"] = (leaderThreadId) =>
    runLock.withPermit(
      Effect.gen(function* () {
        const binding = yield* readBindingOrNull(leaderThreadId);
        if (binding === null) return null;
        const active = yield* activeRunFor(leaderThreadId);
        if (active !== null) return active;
        const definition = yield* definitionAt(binding.covenId, binding.revision);
        if (definition === null) return null;
        const now = yield* nowIso;
        const nowMs = Date.parse(now);
        const current = yield* cooldowns;
        const candidates = leaderRole(definition).candidates;
        const leaderIndex = pickCovenCandidate(candidates, 0, current, nowMs) ?? 0;
        const state = initialRunState({ definition, leaderCandidateIndex: leaderIndex });
        const runId = yield* random.uuidV4();
        const stateJson = yield* encodeStateJson(state).pipe(
          Effect.mapError(storageError("Could not save the coven run.")),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO coven_runs (
                  run_id, leader_thread_id, coven_id, revision, status, state_json,
                  started_at, updated_at, ended_at
                ) VALUES (
                  ${runId}, ${leaderThreadId}, ${binding.covenId}, ${binding.revision},
                  ${state.status}, ${stateJson}, ${now}, ${now}, NULL
                )
              `;
              yield* appendEvents(
                runId,
                [
                  {
                    kind: "run.started",
                    summary: `Run started with ${definition.frontMatter.name} revision ${binding.revision}.`,
                  },
                ],
                now,
              );
            }),
          )
          .pipe(Effect.mapError(storageError("Could not start the coven run.")));
        yield* notifyChanged;
        yield* PubSub.publish(runChangeHub, runId);
        return yield* getRun(runId).pipe(Effect.map((run) => run!));
      }),
    );

  const childLink: CovenService["Service"]["childLink"] = (childThreadId) =>
    sql<{ run_id: string; task_id: string; role_id: string }>`
      SELECT run_id, task_id, role_id FROM coven_run_children WHERE child_thread_id = ${childThreadId}
    `.pipe(
      Effect.mapError(storageError("Could not read coven workers.")),
      Effect.map((rows) =>
        rows[0] === undefined
          ? null
          : { runId: rows[0].run_id, taskId: rows[0].task_id, roleId: rows[0].role_id },
      ),
    );

  const registerChild: CovenService["Service"]["registerChild"] = (childThreadId, link) =>
    sql`
      INSERT INTO coven_run_children (child_thread_id, run_id, task_id, role_id)
      VALUES (${childThreadId}, ${link.runId}, ${link.taskId}, ${link.roleId})
      ON CONFLICT (child_thread_id) DO NOTHING
    `.pipe(Effect.mapError(storageError("Could not record the coven worker.")));

  const threadState: CovenService["Service"]["threadState"] = Effect.fn("CovenService.threadState")(
    function* (threadId) {
      const binding = yield* readBinding(threadId);
      const run = yield* latestRun(threadId);
      const events = run === null ? [] : yield* runEvents(run.id, 40);
      return {
        binding,
        run: run === null ? null : toRunView(run, events),
        cooldowns: yield* cooldowns,
      };
    },
  );

  const refuseWhileRunning = Effect.fn("refuseWhileRunning")(function* (
    threadId: string,
    action: string,
  ) {
    const active = yield* activeRunFor(threadId);
    if (active !== null) {
      return yield* new CovenError({
        reason: "policy-denied",
        message: `This thread's coven is still working. End its work before you ${action}.`,
      });
    }
  });

  const setThread: CovenService["Service"]["setThread"] = Effect.fn("CovenService.setThread")(
    function* (threadId, covenId) {
      const row = yield* readRow(covenId);
      if (row === null || row.archived_at !== null) {
        return yield* notFound(`No active coven has the id ${covenId}.`);
      }
      if ((yield* childLink(threadId)) !== null) {
        return yield* new CovenError({
          reason: "policy-denied",
          message: "This thread is a coven worker; change the coven from its leader thread.",
        });
      }
      const current = yield* activeRunFor(threadId);
      // Re-picking the coven that's already working here keeps it as is.
      if (current !== null && current.covenId === covenId) return yield* threadState(threadId);
      yield* refuseWhileRunning(threadId, "change the coven");
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO thread_coven_bindings (thread_id, coven_id, revision, bound_at)
        VALUES (${threadId}, ${covenId}, ${row.current_revision}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          coven_id = excluded.coven_id, revision = excluded.revision, bound_at = excluded.bound_at
      `.pipe(Effect.mapError(storageError("Could not bind the coven.")));
      yield* notifyChanged;
      return yield* threadState(threadId);
    },
  );

  const clearThread: CovenService["Service"]["clearThread"] = Effect.fn("CovenService.clearThread")(
    function* (threadId) {
      yield* refuseWhileRunning(threadId, "turn the coven off");
      yield* sql`DELETE FROM thread_coven_bindings WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(storageError("Could not clear the thread's coven.")),
      );
      yield* notifyChanged;
      return yield* threadState(threadId);
    },
  );

  const threadScope: CovenService["Service"]["threadScope"] = Effect.fn("CovenService.threadScope")(
    function* (threadId) {
      const binding = yield* readBinding(threadId);
      if (binding !== null) {
        const run = yield* activeRunFor(threadId);
        const definition = yield* definitionAt(
          binding.covenId,
          run === null ? binding.revision : run.revision,
        );
        return definition === null ? null : { kind: "leader" as const, binding, definition, run };
      }
      const link = yield* childLink(threadId);
      if (link === null) return null;
      const run = yield* getRun(link.runId);
      if (run === null) return null;
      const leaderBinding = yield* readBinding(run.leaderThreadId);
      if (leaderBinding === null) return null;
      const definition = yield* definitionAt(run.covenId, run.revision);
      return definition === null
        ? null
        : {
            kind: "worker" as const,
            roleId: link.roleId,
            taskId: link.taskId,
            leaderThreadId: run.leaderThreadId,
            binding: leaderBinding,
            definition,
            run,
          };
    },
  );

  const draftChanges = yield* PubSub.sliding<string>(16);

  const toDraft = (row: DraftRow): CovenDraft => ({
    id: row.draft_id,
    builderThreadId: row.builder_thread_id === null ? null : ThreadId.make(row.builder_thread_id),
    baseCovenId: row.base_coven_id,
    baseRevision: row.base_revision,
    source: row.source,
    version: row.version,
    lastChangeBy: row.last_change_by === "builder" ? "builder" : "user",
    lastChangeSummary: row.last_change_summary,
    savedRevision: row.saved_revision,
    updatedAt: row.updated_at,
  });

  const getDraft: CovenService["Service"]["getDraft"] = (draftId) =>
    sql<DraftRow>`SELECT * FROM coven_drafts WHERE draft_id = ${draftId}`.pipe(
      Effect.mapError(storageError("Could not read the coven draft.")),
      Effect.map((rows) => (rows[0] === undefined ? null : toDraft(rows[0]))),
    );

  const draftForThread: CovenService["Service"]["draftForThread"] = (threadId) =>
    sql<DraftRow>`SELECT * FROM coven_drafts WHERE builder_thread_id = ${threadId}`.pipe(
      Effect.mapError(storageError("Could not read the coven draft.")),
      Effect.map((rows) => (rows[0] === undefined ? null : toDraft(rows[0]))),
    );

  const requireDraft = (draftId: string) =>
    getDraft(draftId).pipe(
      Effect.filterOrFail(
        (draft): draft is CovenDraft => draft !== null,
        () => notFound("That coven draft no longer exists."),
      ),
    );

  const draftChanged = (draftId: string) =>
    PubSub.publish(draftChanges, draftId).pipe(Effect.andThen(requireDraft(draftId)));

  const createDraft: CovenService["Service"]["createDraft"] = Effect.fn("CovenService.createDraft")(
    function* (input) {
      const id = yield* random.uuidV4();
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO coven_drafts (
          draft_id, builder_thread_id, base_coven_id, base_revision, source, version,
          last_change_by, last_change_summary, saved_revision, updated_at
        ) VALUES (
          ${id}, ${input.builderThreadId}, ${input.baseCovenId}, ${input.baseRevision},
          ${input.source}, 1, 'user', NULL, NULL, ${now}
        )
      `.pipe(Effect.mapError(storageError("Could not create the coven draft.")));
      return yield* draftChanged(id);
    },
  );

  const setDraftThread: CovenService["Service"]["setDraftThread"] = (draftId, builderThreadId) =>
    sql`UPDATE coven_drafts SET builder_thread_id = ${builderThreadId} WHERE draft_id = ${draftId}`.pipe(
      Effect.mapError(storageError("Could not link the coven draft.")),
      Effect.andThen(draftChanged(draftId)),
    );

  const updateDraft: CovenService["Service"]["updateDraft"] = Effect.fn("CovenService.updateDraft")(
    function* (input) {
      const now = yield* nowIso;
      const updated = yield* sql<{ draft_id: string }>`
        UPDATE coven_drafts SET
          source = ${input.source}, version = version + 1, last_change_by = ${input.by},
          last_change_summary = ${input.summary}, updated_at = ${now}
        WHERE draft_id = ${input.draftId} AND version = ${input.expectedVersion}
        RETURNING draft_id
      `.pipe(Effect.mapError(storageError("Could not update the coven draft.")));
      if (updated.length === 0) {
        const current = yield* requireDraft(input.draftId);
        return yield* new CovenError({
          reason: "conflict",
          message: `The draft changed (now version ${current.version}, last edited by the ${current.lastChangeBy}). Reload it and apply your change again.`,
        });
      }
      return yield* draftChanged(input.draftId);
    },
  );

  const markDraftSaved: CovenService["Service"]["markDraftSaved"] = (draftId, covenId, revision) =>
    sql`
      UPDATE coven_drafts SET
        saved_revision = ${revision},
        base_coven_id = ${covenId},
        base_revision = ${revision}
      WHERE draft_id = ${draftId}
    `.pipe(
      Effect.mapError(storageError("Could not update the coven draft.")),
      Effect.andThen(draftChanged(draftId)),
    );

  const subscribeDraft: CovenService["Service"]["subscribeDraft"] = (draftId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(draftChanges);
        const read = getDraft(draftId).pipe(Effect.map((draft) => ({ draft })));
        return Stream.concat(
          Stream.fromEffect(read),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === draftId),
            Stream.mapEffect(() => read),
          ),
        );
      }),
    );

  const changesThen = <A>(read: Effect.Effect<A, CovenError>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(read),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
        );
      }),
    );

  return CovenService.of({
    subscribeList: (input) => changesThen(list(input)),
    list,
    get,
    getRevision,
    save,
    archive,
    boundThreads,
    subscribeThread: (threadId) => changesThen(threadState(threadId)),
    threadState,
    setThread,
    clearThread,
    threadScope,
    definitionAt,
    ensureRun,
    getRun,
    activeRuns,
    updateRun,
    runEvents,
    childLink,
    registerChild,
    cooldowns,
    addCooldown,
    clearCooldown,
    createDraft,
    setDraftThread,
    getDraft,
    draftForThread,
    updateDraft,
    markDraftSaved,
    subscribeDraft,
    runChanges: Stream.fromPubSub(runChangeHub),
  });
});

export const layer = Layer.effect(CovenService, make);
