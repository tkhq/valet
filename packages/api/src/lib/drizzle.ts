/**
 * Application Drizzle handle, backed by either `drizzle-orm/node-postgres`
 * or `drizzle-orm/pglite` — both are structurally assignable to
 * `PgDatabase<PgQueryResultHKT, typeof schema>` in the installed
 * drizzle-orm 0.45.2 (their `NodePgQueryResultHKT`/`PgliteQueryResultHKT`
 * both extend the shared `PgQueryResultHKT`), so `AppDb` uses the real
 * common base rather than `PgDatabase<any, any, any>` (forbidden by the
 * no-`any` rule — decision 8 of docs/specs/2026-07-15-postgres-backend-design.md).
 *
 * Mirrors `packages/store-postgres/src/migrate.ts`'s conventions
 * (`information_schema` probe, `__valet_*_migrations` tracker, one
 * transaction per migration file, `import.meta.url` dir resolution): async
 * throughout, `--> statement-breakpoint`-delimited multi-statement files, no
 * sqlite-style backfill path (decision 10: no pg database predates the
 * tracker).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { applyEngineMigrations, isPgLockTimeout, pgDbFromPglite, pgDbFromPool, type PgDb } from "@valet/store-postgres";
import { readFileSync } from "node:fs";
import * as schema from "../schema/index.js";

/** Application Drizzle handle. The engine's session store has its own
 * Drizzle handle over the same connection source — both reach the same
 * pg database. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The transaction handle Drizzle's pg drivers pass to
 * `db.transaction(tx => ...)` callbacks. Derived from `AppDb["transaction"]`
 * (rather than importing internal driver-specific transaction class names)
 * so services that need to run reads + writes atomically can type their
 * helpers to accept either `AppDb` or this transaction handle without a
 * type assertion.
 */
export type AppTx = Parameters<AppDb["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;

/** Either a top-level `AppDb` handle or an in-flight transaction on one. */
export type AppQueryable = AppDb | AppTx;

/**
 * Builds the app Drizzle instance over either connection source. `source`
 * is the raw driver object (a `pg.Pool` or an `@electric-sql/pglite`
 * `PGlite` instance) — NOT the `PgDb` query wrapper, since each drizzle
 * driver needs its own native client, not the normalized `PgQueryable`
 * surface `PgDb` exposes (`buildAppQueryable` below wraps the SAME
 * underlying object separately, for the raw-SQL stores that share a
 * connection source with this Drizzle instance).
 */
export function buildAppDb(source: Pool | PGlite): AppDb {
  if (source instanceof PGlite) {
    return drizzlePglite(source, { schema, casing: "snake_case" });
  }
  return drizzleNodePg(source, { schema, casing: "snake_case" });
}

/** Wraps a raw connection source in the shared `PgDb` query interface
 * (decision 4) — the same source `buildAppDb` above builds a Drizzle
 * instance over, so raw-SQL call sites (migrations, the memory service's
 * tsvector queries) and Drizzle call sites share one physical connection. */
export function buildAppQueryable(source: Pool | PGlite): PgDb {
  return source instanceof PGlite ? pgDbFromPglite(source) : pgDbFromPool(source);
}

/**
 * The one pre-1.0 app migration. CLAUDE.md rule: we edit `0000` in place,
 * never add `0001`/`0002`, so this is an explicit single-file read rather than
 * a directory scan. Read via `new URL(..., import.meta.url)` so the asset
 * resolves relative to this module (the seam a later bundling step relies on).
 */
const APP_MIGRATION_FILES = ["0000_app.sql"] as const;

const migrationSql: Record<(typeof APP_MIGRATION_FILES)[number], () => string> = {
  "0000_app.sql": () =>
    readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8"),
};

/**
 * Apply this package's postgres migrations to an open `PgDb`.
 *
 * Tracks applied migrations in `__valet_app_migrations` (filename + timestamp)
 * so re-runs across server restarts are no-ops. Each migration runs in a
 * transaction — partial application leaves the tracker untouched.
 *
 * The app schema now spans both migration sets: the `cost_entries` view reads
 * `engine_entries` (engine schema) alongside `agent_sessions`/`workflow_runs`/
 * `workflow_definitions`. So this function applies the engine schema FIRST.
 * `applyEngineMigrations` is idempotent and tracks itself separately, so a
 * caller that also applies it explicitly (`providers/node.ts`) is unaffected.
 * The dependency only runs this way: the engine schema never reads app tables.
 */
export async function applyAppMigrations(db: PgDb, pgDataDir?: string): Promise<void> {
  await applyEngineMigrations(db, pgDataDir);

  await db.query(`
    CREATE TABLE IF NOT EXISTS __valet_app_migrations (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `);

  for (const file of APP_MIGRATION_FILES) {
    const applied = await db.query("SELECT 1 FROM __valet_app_migrations WHERE filename = $1", [file]);
    if (applied.rows.length > 0) continue;

    const sql = migrationSql[file]();
    const statements = sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await db.transaction(async (tx) => {
      for (const stmt of statements) {
        await tx.query(stmt);
      }
      await tx.query("INSERT INTO __valet_app_migrations (filename, applied_at) VALUES ($1, $2)", [
        file,
        Date.now(),
      ]);
    });
  }

  await addColumnsMissingFromAppliedMigrations(db);
}

/**
 * One schema element that a pre-1.0 in-place edit added to an
 * ALREADY-APPLIED `0000_app.sql`, plus the catalog probe that tells whether
 * this database still lacks it. The probe is the point (TKAI-244): a no-op
 * `ALTER TABLE ... IF NOT EXISTS` still takes an ACCESS EXCLUSIVE lock, and
 * during a rolling update that lock queues behind the old api pod's open
 * transactions — the new pod hangs, the queued lock blocks the old pod's
 * reads, and the deploy deadlocks. Probing the catalog first means a boot
 * where nothing is missing issues no DDL at all.
 */
interface SchemaRepair {
  /** Names the element in logs and errors, e.g. "orgs.sso_team_groups column". */
  describe: string;
  probe:
    | { kind: "column"; table: string; column: string }
    | { kind: "table"; table: string }
    | { kind: "index"; index: string };
  sql: string;
}

/**
 * The pre-1.0 in-place-edit repair list. Add an entry when an edit to
 * `0000_app.sql` adds a NULLABLE (or DEFAULT-backfilled) column, a table,
 * or an index; a column that needs a computed value cannot be repaired this
 * way and does need a real migration. Keep each `sql` in lockstep with
 * `0000_app.sql`. Delete this list at 1.0, when numbered migrations take
 * over.
 */
const SCHEMA_REPAIRS: SchemaRepair[] = [
  {
    // Records which person's GitHub credential a team skill source may use.
    // Null on every row written before the column existed, which the sync
    // reads as "no credential" rather than climbing to the org's App.
    describe: "skill_sources.created_by column",
    probe: { kind: "column", table: "skill_sources", column: "created_by" },
    sql: 'ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "created_by" text',
  },
  {
    // The per-group team-sync allowlist. Null on every row written before
    // the column existed, which the sync and Settings read as "never set" —
    // fail-closed, same as an empty list.
    describe: "orgs.sso_team_groups column",
    probe: { kind: "column", table: "orgs", column: "sso_team_groups" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "sso_team_groups" jsonb',
  },
  {
    // Artifact-sharing opt-in (artifacts design). The DEFAULT backfills
    // every pre-existing org row to `false` — anonymous sharing stays off
    // until an admin opts in, the same answer a fresh database gets.
    describe: "orgs.allow_public_artifacts column",
    probe: { kind: "column", table: "orgs", column: "allow_public_artifacts" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_public_artifacts" boolean NOT NULL DEFAULT false',
  },
  {
    // The artifacts table itself (artifacts design) — a whole-table sibling
    // of the column repairs, for the same reason.
    describe: "artifacts table",
    probe: { kind: "table", table: "artifacts" },
    sql: `CREATE TABLE IF NOT EXISTS "artifacts" (
      "id" text PRIMARY KEY NOT NULL,
      "token" text NOT NULL,
      "owner_type" text NOT NULL,
      "owner_id" text NOT NULL,
      "org_id" text NOT NULL,
      "actor_user_id" text NOT NULL,
      "source_session_id" text DEFAULT '' NOT NULL,
      "source_memory_path" text NOT NULL,
      "title" text DEFAULT '' NOT NULL,
      "content" text NOT NULL,
      "visibility" text DEFAULT 'org' NOT NULL,
      "public_by" text,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL,
      "revoked_at" bigint
    )`,
  },
  {
    describe: "artifacts_token_unique index",
    probe: { kind: "index", index: "artifacts_token_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_token_unique" ON "artifacts" ("token")',
  },
  {
    describe: "artifacts_owner_path_unique index",
    probe: { kind: "index", index: "artifacts_owner_path_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path")',
  },
  {
    // Hibernated-sandbox reaper bookkeeping. Null on rows hibernated before
    // the columns existed — the reaper falls back to a derived handle for
    // those (engine/hibernation-reaper.ts).
    describe: "agent_sessions.hibernated_sandbox_id column",
    probe: { kind: "column", table: "agent_sessions", column: "hibernated_sandbox_id" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "hibernated_sandbox_id" text',
  },
  {
    describe: "agent_sessions.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "agent_sessions", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // Settled-run sandbox reclaim bookkeeping (workflows/sandbox-reclaim.ts).
    // Null on every run settled before the column existed — exactly the rows
    // the reclaim sweep must pick up.
    describe: "workflow_runs.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "workflow_runs", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // The RFC 7591 scope set an MCP OAuth client was registered with
    // (integration-oauth.ts, TKAI-243). Null on rows registered before
    // scopes support, which the compare reads as "no scopes" — a declared
    // scope set then re-registers the client.
    describe: "mcp_oauth_clients.registered_scopes column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "registered_scopes" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "registered_scopes" jsonb',
  },
  {
    // The server's advertised scopes_supported, captured at registration or
    // lazily backfilled (integration-oauth.ts). Null on rows from before the
    // column existed — exactly the rows the backfill fills in.
    describe: "mcp_oauth_clients.scopes_supported column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "scopes_supported" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "scopes_supported" jsonb',
  },
  {
    // The LLM recording gateway's request log (#432). The gateway writes a row
    // here on every recorded call, so an already-migrated DB without it 500s
    // at runtime. Columns are in lockstep with `llm_proxy_requests` in
    // 0000_app.sql.
    describe: "llm_proxy_requests table",
    probe: { kind: "table", table: "llm_proxy_requests" },
    sql: `CREATE TABLE IF NOT EXISTS "llm_proxy_requests" (
      "id" text PRIMARY KEY NOT NULL,
      "created_at" bigint NOT NULL,
      "org_id" text NOT NULL,
      "user_id" text NOT NULL,
      "api_key_id" text NOT NULL,
      "provider_kind" text NOT NULL,
      "model" text,
      "harness" text,
      "endpoint" text NOT NULL,
      "provider_response_id" text,
      "previous_response_id" text,
      "stream" boolean NOT NULL,
      "status_code" integer NOT NULL,
      "request_body" text NOT NULL,
      "response_body" text,
      "input_tokens" bigint NOT NULL DEFAULT 0,
      "output_tokens" bigint NOT NULL DEFAULT 0,
      "cache_read_tokens" bigint NOT NULL DEFAULT 0,
      "cache_write_tokens" bigint NOT NULL DEFAULT 0,
      "total_tokens" bigint NOT NULL DEFAULT 0,
      "cost_usd" double precision,
      "latency_ms" integer,
      "error" text,
      "parsed" jsonb,
      "parse_version" integer,
      "parse_error" text
    )`,
  },
  {
    describe: "llm_proxy_requests_org_created index",
    probe: { kind: "index", index: "llm_proxy_requests_org_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at")',
  },
  {
    describe: "llm_proxy_requests_user_created index",
    probe: { kind: "index", index: "llm_proxy_requests_user_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at")',
  },
  {
    // The cost_entries VIEW was rewritten (#432): it added a `use_case` column
    // and a UNION ALL leg over llm_proxy_requests. A view's output columns
    // appear in information_schema.columns, so the `column` probe on the new
    // use_case column detects the pre-rewrite view; CREATE OR REPLACE swaps the
    // definition in place. The replace is safe because the rewrite only appends
    // use_case after `priced` and leaves every prior column identical, so
    // Postgres allows it without a DROP (which would take a heavier lock and
    // fail on any dependent). This entry MUST stay after the table entry above
    // — the UNION leg references llm_proxy_requests. Keep the SELECT in lockstep
    // with the cost_entries view in 0000_app.sql.
    describe: "cost_entries.use_case (view rewrite)",
    probe: { kind: "column", table: "cost_entries", column: "use_case" },
    sql: `CREATE OR REPLACE VIEW "cost_entries" AS
      SELECT
        e."id"                                                     AS "entry_id",
        e."session_id"                                             AS "session_id",
        e."created_at"                                             AS "created_at",
        e."model"                                                  AS "model",
        COALESCE(s."org_id", d."org_id")                           AS "org_id",
        CASE
          WHEN s."id" IS NOT NULL THEN s."user_id"
          WHEN r."owner_type" = 'user' THEN NULLIF(r."owner_id", '')
        END                                                        AS "user_id",
        COALESCE(s."owner_type", r."owner_type")                   AS "owner_type",
        NULLIF(COALESCE(s."owner_id", r."owner_id"), '')           AS "owner_id",
        r."workflow_id"                                            AS "workflow_id",
        r."id"                                                     AS "workflow_run_id",
        COALESCE((e."usage"::jsonb->>'input')::bigint, 0)          AS "input_tokens",
        COALESCE((e."usage"::jsonb->>'output')::bigint, 0)         AS "output_tokens",
        COALESCE((e."usage"::jsonb->>'cacheRead')::bigint, 0)      AS "cache_read_tokens",
        COALESCE((e."usage"::jsonb->>'cacheWrite')::bigint, 0)     AS "cache_write_tokens",
        COALESCE((e."usage"::jsonb->>'total')::bigint, 0)          AS "total_tokens",
        (e."cost"::jsonb->>'total')::float8                        AS "cost_total",
        ((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced",
        CASE
          WHEN e."session_id" LIKE 'orchestrator:%' THEN 'orchestrator'
          WHEN e."session_id" LIKE 'wf:%'           THEN 'workflow'
          ELSE 'session'
        END                                                        AS "use_case"
      FROM "engine_entries" e
      LEFT JOIN "agent_sessions" s
        ON s."id" = e."session_id"
      LEFT JOIN "workflow_runs" r
        ON e."session_id" LIKE 'wf:%'
        AND r."id" = split_part(e."session_id", ':', 2)
      LEFT JOIN "workflow_definitions" d
        ON d."id" = r."workflow_id"
      WHERE e."usage" IS NOT NULL
        AND COALESCE(s."org_id", d."org_id") IS NOT NULL
      UNION ALL
      SELECT
        p."id" AS "entry_id", NULL AS "session_id", p."created_at" AS "created_at", p."model" AS "model",
        p."org_id" AS "org_id", p."user_id" AS "user_id", 'user' AS "owner_type", p."user_id" AS "owner_id",
        NULL AS "workflow_id", NULL AS "workflow_run_id",
        p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
        p."cost_usd" AS "cost_total", (p."cost_usd" IS NOT NULL) AS "priced", 'proxy' AS "use_case"
      FROM "llm_proxy_requests" p
      WHERE p."total_tokens" > 0`,
  },
  {
    // Which authoring surface a session drives (Valet Security spec; shared
    // shape with the Valet Design PR #396). DEFAULT backfills every
    // pre-existing row to 'code' — the answer a fresh database gives.
    describe: "agent_sessions.kind column",
    probe: { kind: "column", table: "agent_sessions", column: "kind" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT \'code\'',
  },
  {
    // Valet Security tables (docs/specs/2026-08-27-valet-security-design.md).
    // Whole-table siblings of the column repairs; keep each in lockstep with
    // 0000_app.sql.
    describe: "security_engagements table",
    probe: { kind: "table", table: "security_engagements" },
    sql: `CREATE TABLE IF NOT EXISTS "security_engagements" (
      "id" text PRIMARY KEY NOT NULL,
      "session_id" text NOT NULL,
      "status" text DEFAULT 'planning' NOT NULL,
      "repo_full_name" text NOT NULL,
      "repo_ref" text DEFAULT '' NOT NULL,
      "plan" text DEFAULT '' NOT NULL,
      "parent_engagement_id" text,
      "base_ref" text,
      "changed_paths" text,
      "focus" text,
      "invariants" text,
      "categories" text,
      "config_personas" text,
      "config_persona_markdown" text,
      "config_tools" text,
      "has_repo_config" boolean DEFAULT false NOT NULL,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_engagements_session_unique index",
    probe: { kind: "index", index: "security_engagements_session_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_engagements_session_unique" ON "security_engagements" ("session_id")',
  },
  {
    // The re-scan lineage link (re-scan / iterate). Null on every engagement
    // written before the column existed — read as "not a re-scan", the same
    // answer a first review gets. The whole-table CREATE above does not add a
    // column to an already-created table, so this column repair is separate.
    describe: "security_engagements.parent_engagement_id column",
    probe: { kind: "column", table: "security_engagements", column: "parent_engagement_id" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "parent_engagement_id" text',
  },
  {
    // Diff-scoped re-scan (re-scan / iterate): the parent SHA the diff ran
    // against. Null on a first review, or a full-scan fallback. Separate
    // column repair because the whole-table CREATE does not add a column to an
    // already-created table.
    describe: "security_engagements.base_ref column",
    probe: { kind: "column", table: "security_engagements", column: "base_ref" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "base_ref" text',
  },
  {
    // Diff-scoped re-scan (re-scan / iterate): the JSON array of changed file
    // paths the sweeps scoped to. Null on a first review or a full-scan
    // fallback.
    describe: "security_engagements.changed_paths column",
    probe: { kind: "column", table: "security_engagements", column: "changed_paths" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "changed_paths" text',
  },
  {
    // Repo config context (dynamic-config M-F1): parsed from `.valet/security.yml`
    // at create. Null on a preset-seeded engagement. Separate column repairs
    // because the whole-table CREATE does not add a column to an existing table.
    describe: "security_engagements.focus column",
    probe: { kind: "column", table: "security_engagements", column: "focus" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "focus" text',
  },
  {
    describe: "security_engagements.invariants column",
    probe: { kind: "column", table: "security_engagements", column: "invariants" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "invariants" text',
  },
  {
    describe: "security_engagements.categories column",
    probe: { kind: "column", table: "security_engagements", column: "categories" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "categories" text',
  },
  {
    describe: "security_engagements.config_personas column",
    probe: { kind: "column", table: "security_engagements", column: "config_personas" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_personas" text',
  },
  {
    describe: "security_engagements.config_persona_markdown column",
    probe: { kind: "column", table: "security_engagements", column: "config_persona_markdown" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_persona_markdown" text',
  },
  {
    describe: "security_engagements.config_tools column",
    probe: { kind: "column", table: "security_engagements", column: "config_tools" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_tools" text',
  },
  {
    describe: "security_engagements.has_repo_config column",
    probe: { kind: "column", table: "security_engagements", column: "has_repo_config" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "has_repo_config" boolean DEFAULT false NOT NULL',
  },
  {
    describe: "security_engagements_parent index",
    probe: { kind: "index", index: "security_engagements_parent" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_engagements_parent" ON "security_engagements" ("parent_engagement_id")',
  },
  {
    describe: "security_cells table",
    probe: { kind: "table", table: "security_cells" },
    sql: `CREATE TABLE IF NOT EXISTS "security_cells" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "ordinal" integer NOT NULL,
      "persona" text NOT NULL,
      "mode" text DEFAULT 'fresh' NOT NULL,
      "goal" text NOT NULL,
      "dir" text NOT NULL,
      "reads" text DEFAULT '[]' NOT NULL,
      "review" boolean DEFAULT false NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "attempts" integer DEFAULT 0 NOT NULL,
      "compacted_at" bigint,
      "child_session_id" text,
      "dispatched_at" bigint,
      "settled_at" bigint,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_cells_engagement_ordinal_unique index",
    probe: { kind: "index", index: "security_cells_engagement_ordinal_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_cells_engagement_ordinal_unique" ON "security_cells" ("engagement_id", "ordinal")',
  },
  {
    describe: "security_cells_child_session index",
    probe: { kind: "index", index: "security_cells_child_session" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_cells_child_session" ON "security_cells" ("child_session_id")',
  },
  {
    describe: "security_files table",
    probe: { kind: "table", table: "security_files" },
    sql: `CREATE TABLE IF NOT EXISTS "security_files" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "path" text NOT NULL,
      "revision" integer NOT NULL,
      "content" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_files_path_revision_unique index",
    probe: { kind: "index", index: "security_files_path_revision_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_files_path_revision_unique" ON "security_files" ("engagement_id", "path", "revision")',
  },
  {
    describe: "security_findings table",
    probe: { kind: "table", table: "security_findings" },
    sql: `CREATE TABLE IF NOT EXISTS "security_findings" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "fingerprint" text NOT NULL,
      "severity" text NOT NULL,
      "title" text NOT NULL,
      "file" text,
      "line" integer,
      "body" text DEFAULT '' NOT NULL,
      "status" text DEFAULT 'open' NOT NULL,
      "status_reason" text,
      "status_actor" text,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_findings_engagement index",
    probe: { kind: "index", index: "security_findings_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_findings_engagement" ON "security_findings" ("engagement_id")',
  },
  {
    describe: "security_finding_links table",
    probe: { kind: "table", table: "security_finding_links" },
    sql: `CREATE TABLE IF NOT EXISTS "security_finding_links" (
      "id" text PRIMARY KEY NOT NULL,
      "finding_id" text NOT NULL,
      "engagement_id" text NOT NULL,
      "provider" text NOT NULL,
      "external_id" text NOT NULL,
      "url" text NOT NULL,
      "created_by" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_finding_links_provider_unique index",
    probe: { kind: "index", index: "security_finding_links_provider_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_finding_links_provider_unique" ON "security_finding_links" ("finding_id", "provider")',
  },
  {
    describe: "security_handoffs table",
    probe: { kind: "table", table: "security_handoffs" },
    sql: `CREATE TABLE IF NOT EXISTS "security_handoffs" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "finding_id" text NOT NULL,
      "child_session_id" text NOT NULL,
      "title" text NOT NULL,
      "task" text,
      "created_by" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_handoffs_engagement index",
    probe: { kind: "index", index: "security_handoffs_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_handoffs_engagement" ON "security_handoffs" ("engagement_id")',
  },
  {
    describe: "security_handoffs_finding index",
    probe: { kind: "index", index: "security_handoffs_finding" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_handoffs_finding" ON "security_handoffs" ("finding_id")',
  },
  {
    describe: "security_finding_comments table",
    probe: { kind: "table", table: "security_finding_comments" },
    sql: `CREATE TABLE IF NOT EXISTS "security_finding_comments" (
      "id" text PRIMARY KEY NOT NULL,
      "finding_id" text NOT NULL,
      "engagement_id" text NOT NULL,
      "body" text NOT NULL,
      "author_user_id" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_finding_comments_finding index",
    probe: { kind: "index", index: "security_finding_comments_finding" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_finding_comments_finding" ON "security_finding_comments" ("finding_id")',
  },
  {
    describe: "security_finding_comments_engagement index",
    probe: { kind: "index", index: "security_finding_comments_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_finding_comments_engagement" ON "security_finding_comments" ("engagement_id")',
  },
  {
    describe: "security_coverage table",
    probe: { kind: "table", table: "security_coverage" },
    sql: `CREATE TABLE IF NOT EXISTS "security_coverage" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "area" text NOT NULL,
      "status" text NOT NULL,
      "tool" text,
      "reason" text,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_coverage_engagement index",
    probe: { kind: "index", index: "security_coverage_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_coverage_engagement" ON "security_coverage" ("engagement_id")',
  },
  {
    describe: "security_coverage_cell index",
    probe: { kind: "index", index: "security_coverage_cell" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_coverage_cell" ON "security_coverage" ("cell_id")',
  },
  {
    describe: "security_needs table",
    probe: { kind: "table", table: "security_needs" },
    sql: `CREATE TABLE IF NOT EXISTS "security_needs" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "kind" text NOT NULL,
      "description" text NOT NULL,
      "status" text DEFAULT 'open' NOT NULL,
      "resolution" text,
      "created_at" bigint NOT NULL,
      "resolved_at" bigint
    )`,
  },
  {
    describe: "security_needs_engagement index",
    probe: { kind: "index", index: "security_needs_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_needs_engagement" ON "security_needs" ("engagement_id")',
  },
  {
    describe: "security_needs_cell index",
    probe: { kind: "index", index: "security_needs_cell" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_needs_cell" ON "security_needs" ("cell_id")',
  },
];

/** The repairs this database still lacks, by catalog probe — one query per
 * probe kind (3 round-trips), not one per repair. Exported for the schema
 * tests: steady state must return [] — that is the no-locks contract.
 * The probe lists ride as JSON strings so both drivers (node-postgres,
 * PGlite) bind them identically. */
export async function missingSchemaRepairs(db: PgDb): Promise<SchemaRepair[]> {
  const columnTables = new Set<string>();
  const tableNames: string[] = [];
  const indexNames: string[] = [];
  for (const { probe } of SCHEMA_REPAIRS) {
    if (probe.kind === "column") columnTables.add(probe.table);
    else if (probe.kind === "table") tableNames.push(probe.table);
    else indexNames.push(probe.index);
  }

  const present = new Set<string>();
  const collect = async (sql: string, names: string[], toKey: (row: Record<string, unknown>) => string) => {
    if (names.length === 0) return;
    const result = await db.query(sql, [JSON.stringify(names)]);
    for (const row of result.rows) present.add(toKey(row));
  };
  await collect(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [...columnTables],
    (row) => `column:${String(row["table_name"])}.${String(row["column_name"])}`,
  );
  await collect(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    tableNames,
    (row) => `table:${String(row["table_name"])}`,
  );
  await collect(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    indexNames,
    (row) => `index:${String(row["indexname"])}`,
  );

  return SCHEMA_REPAIRS.filter(({ probe: p }) => {
    const key = p.kind === "column" ? `column:${p.table}.${p.column}` : p.kind === "table" ? `table:${p.table}` : `index:${p.index}`;
    return !present.has(key);
  });
}

const REPAIR_LOCK_TIMEOUT = "5s";
const REPAIR_ATTEMPTS = 3;

/**
 * Repair the schema gaps that in-place `0000_app.sql` edits leave in an
 * already-migrated database. Steady state (nothing missing) runs catalog
 * probes only — no DDL, no exclusive locks (TKAI-244). A repair that must
 * run does so under `lock_timeout`, retries briefly, and then fails naming
 * the wait — a hung boot with nothing in the log is the failure mode this
 * replaces.
 */
async function addColumnsMissingFromAppliedMigrations(db: PgDb): Promise<void> {
  for (const repair of await missingSchemaRepairs(db)) {
    await runSchemaRepair(db, repair);
  }
}

async function runSchemaRepair(db: PgDb, repair: SchemaRepair): Promise<void> {
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // SET LOCAL scopes the timeout to this transaction. Without it the
        // ALTER waits forever behind any open transaction on the table —
        // during a rolling update, the previous api pod's.
        await tx.query(`SET LOCAL lock_timeout = '${REPAIR_LOCK_TIMEOUT}'`);
        await tx.query(repair.sql);
      });
      console.log(`schema repair: added ${repair.describe}`);
      return;
    } catch (err) {
      if (!isPgLockTimeout(err)) throw err;
      if (attempt < REPAIR_ATTEMPTS) {
        console.warn(
          `schema repair: ${repair.describe} waited ${REPAIR_LOCK_TIMEOUT} for a table lock (attempt ${attempt}/${REPAIR_ATTEMPTS}); retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw new Error(
        `schema repair: ${repair.describe} could not get a table lock after ${REPAIR_ATTEMPTS} attempts of ${REPAIR_LOCK_TIMEOUT}. ` +
          `Another connection holds a conflicting lock — usually an open transaction from a previous api process. ` +
          `End that process (or its transaction in pg_stat_activity), then restart the api.`,
      );
    }
  }
}
