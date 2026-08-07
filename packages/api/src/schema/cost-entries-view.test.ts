/**
 * `cost_entries` view — owner resolution across both session kinds.
 *
 * The view is the single definition of "who pays for this turn". Grafana
 * reads it directly and `/api/usage/summary` reads it through the same
 * columns, so the two surfaces cannot drift. This suite pins the parts that
 * are easy to get wrong: the workflow run-id extraction (two session-id
 * shapes), the org scoping (a workflow run has no `org_id` of its own), and
 * the unpriced-turn contract (`cost` NULL is not zero).
 *
 * The view spans both migration sets, so this suite applies the engine
 * schema before the app schema — the same order `applyAppMigrations`
 * enforces for itself.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEngineMigrations, pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations } from "../lib/drizzle.js";

const NOW = 1_700_000_000_000;

/** Usage JSON the engine stamps on a turn's final assistant entry. */
function usageJson(u: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): string {
  return JSON.stringify({
    ...u,
    total: u.input + u.output + u.cacheRead + u.cacheWrite,
  });
}

describe("cost_entries view", () => {
  // PGlite's wasm heap is not reliably released on close() (see
  // pg-schema.test.ts), so this file shares ONE instance.
  const pglite = new PGlite();
  const db: PgDb = pgDbFromPglite(pglite);

  beforeAll(async () => {
    await applyEngineMigrations(db);
    await applyAppMigrations(db);

    await db.query(
      "INSERT INTO orgs (id, name, created_at) VALUES ('org-a', 'Org A', $1), ('org-b', 'Org B', $1)",
      [NOW],
    );

    // Interactive and orchestrator sessions carry their own app row.
    await db.query(
      `INSERT INTO agent_sessions
         (id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
       VALUES
         ('sess-interactive',     'u-alice', 'org-a', '/tmp/i', 'active', 'user', 'u-alice', $1, $1),
         ('orchestrator:u-alice', 'u-alice', 'org-a', '/tmp/o', 'active', 'user', 'u-alice', $1, $1),
         ('sess-other-org',       'u-bob',   'org-b', '/tmp/b', 'active', 'user', 'u-bob',   $1, $1)`,
      [NOW],
    );

    // Workflow sessions carry none — they resolve through workflow_runs and
    // then workflow_definitions (the only table of the three with an org_id).
    await db.query(
      `INSERT INTO workflow_definitions
         (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
       VALUES
         ('wf-user',      'org-a', 'user', 'u-alice', 'User workflow',      '{}'::jsonb, $1, $1),
         ('wf-team',      'org-a', 'team', 't-eng',   'Team workflow',      '{}'::jsonb, $1, $1),
         ('wf-other-org', 'org-b', 'user', 'u-bob',   'Other org workflow', '{}'::jsonb, $1, $1)`,
      [NOW],
    );
    await db.query(
      `INSERT INTO workflow_runs
         (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
       VALUES
         ('run-user',      'wf-user',      'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-alice', $1, $1),
         ('run-team',      'wf-team',      'v1', '{}'::jsonb, '{}'::jsonb, 'team', 't-eng',   $1, $1),
         ('run-other-org', 'wf-other-org', 'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-bob',   $1, $1)`,
      [NOW],
    );

    const priced = JSON.stringify({
      input: 0.001,
      output: 0.002,
      cacheRead: 0.0001,
      cacheWrite: 0.0002,
      total: 0.0033,
    });

    await db.query(
      `INSERT INTO engine_entries
         (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
       VALUES
         ('e-interactive', 'sess-interactive',     'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-orch',        'orchestrator:u-alice', 'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-wf',          'wf:run-user:node-a',   'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-wf-foreach',  'wf:run-user:node-a:2', 'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-wf-team',     'wf:run-team:node-b',   'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-other-org',   'sess-other-org',       'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-unpriced',    'sess-interactive',     'th', 'message', 'assistant', 'custom', $2,   NULL, $1),
         ('e-no-usage',    'sess-interactive',     'th', 'message', 'user',      NULL,     NULL, NULL, $1),
         ('e-orphan',      'sess-deleted',         'th', 'message', 'assistant', 'claude', $2,   $3,   $1),
         ('e-invoke',      'wf:invoke:inv-1',      'th', 'message', 'assistant', 'claude', $2,   $3,   $1)`,
      [NOW, usageJson({ input: 100, output: 20, cacheRead: 900, cacheWrite: 40 }), priced],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  async function rowFor(entryId: string): Promise<Record<string, unknown> | undefined> {
    const result = await db.query("SELECT * FROM cost_entries WHERE entry_id = $1", [entryId]);
    return result.rows[0];
  }

  async function entryIds(where: string): Promise<unknown[]> {
    const result = await db.query(`SELECT entry_id FROM cost_entries ${where} ORDER BY entry_id`);
    return result.rows.map((r) => r.entry_id);
  }

  it("attributes an interactive session turn through agent_sessions", async () => {
    const row = await rowFor("e-interactive");
    expect(row?.org_id).toBe("org-a");
    expect(row?.user_id).toBe("u-alice");
    expect(row?.owner_type).toBe("user");
    expect(row?.owner_id).toBe("u-alice");
    expect(row?.workflow_id).toBeNull();
    expect(row?.workflow_run_id).toBeNull();
  });

  it("attributes an orchestrator session turn through agent_sessions", async () => {
    const row = await rowFor("e-orch");
    expect(row?.org_id).toBe("org-a");
    expect(row?.user_id).toBe("u-alice");
  });

  it("attributes a wf:{runId}:{nodeId} turn through workflow_runs and workflow_definitions", async () => {
    const row = await rowFor("e-wf");
    expect(row?.org_id).toBe("org-a");
    expect(row?.user_id).toBe("u-alice");
    expect(row?.owner_type).toBe("user");
    expect(row?.workflow_id).toBe("wf-user");
    expect(row?.workflow_run_id).toBe("run-user");
  });

  it("extracts the run id from a foreach body id (wf:{runId}:{nodeId}:{iteration})", async () => {
    const row = await rowFor("e-wf-foreach");
    expect(row?.org_id).toBe("org-a");
    expect(row?.workflow_run_id).toBe("run-user");
    expect(row?.workflow_id).toBe("wf-user");
  });

  it("resolves a team-owned run's org but leaves user_id null", async () => {
    const row = await rowFor("e-wf-team");
    expect(row?.org_id).toBe("org-a");
    expect(row?.user_id).toBeNull();
    expect(row?.owner_type).toBe("team");
    expect(row?.owner_id).toBe("t-eng");
  });

  it("exposes cache tokens and the turn total", async () => {
    const row = await rowFor("e-interactive");
    expect(Number(row?.input_tokens)).toBe(100);
    expect(Number(row?.output_tokens)).toBe(20);
    expect(Number(row?.cache_read_tokens)).toBe(900);
    expect(Number(row?.cache_write_tokens)).toBe(40);
    expect(Number(row?.total_tokens)).toBe(1060);
  });

  it("reports an unpriced turn as null cost, not zero", async () => {
    const row = await rowFor("e-unpriced");
    expect(row?.cost_total).toBeNull();
    expect(row?.priced).toBe(false);
  });

  it("reports a priced turn's total cost", async () => {
    const row = await rowFor("e-interactive");
    expect(Number(row?.cost_total)).toBeCloseTo(0.0033, 6);
    expect(row?.priced).toBe(true);
  });

  it("excludes entries with no usage", async () => {
    expect(await rowFor("e-no-usage")).toBeUndefined();
  });

  it("excludes entries whose session resolves to no org", async () => {
    expect(await rowFor("e-orphan")).toBeUndefined();
    // `wf:invoke:{invocationId}` is an action-invocation context id, not a
    // run id — it must never resolve to a workflow run.
    expect(await rowFor("e-invoke")).toBeUndefined();
  });

  it("keeps each org's turns in that org", async () => {
    expect(await entryIds("WHERE org_id = 'org-b'")).toEqual(["e-other-org"]);
  });

  it("returns exactly one row per attributable entry", async () => {
    expect(await entryIds("")).toEqual([
      "e-interactive",
      "e-orch",
      "e-other-org",
      "e-unpriced",
      "e-wf",
      "e-wf-foreach",
      "e-wf-team",
    ]);
  });
});
