import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../schema/index.js";
import { readFile, writeFile, searchFiles } from "../services/memory.js";
import { PGlite } from "@electric-sql/pglite";
import { applyEngineMigrations, pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs, normalizeLegacyWorkflowDefinitions, reportRetiredAssistantSettings, stripRetiredAssistantTargets } from "./drizzle.js";

describe("workspace singleton repair on an already migrated database", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  // Engine tables too: several repairs read them, and each test must run alone.
  beforeAll(async () => { await applyEngineMigrations(db); await applyAppMigrations(db); });
  afterAll(async () => { await db.close(); });

  it("repairs attention scheduling on an existing database and is repeatable", async () => {
    await db.query("DROP TABLE pending_channel_deliveries");
    await db.query("ALTER TABLE user_notification_preferences DROP COLUMN channel_grace_seconds");
    await applyAppMigrations(db);
    await applyAppMigrations(db);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query(`INSERT INTO pending_channel_deliveries (id, user_id, tier_id, event, deliver_after)
      VALUES ('repair-job', 'u', 'dm', '{}', 100)`);
    expect((await db.query("SELECT status, sending_at, attempts, message_refs FROM pending_channel_deliveries WHERE id = 'repair-job'")).rows)
      .toEqual([{ status: "pending", sending_at: null, attempts: 0, message_refs: null }]);
    await db.query("DROP INDEX pending_channel_deliveries_age");
    await db.query("ALTER TABLE pending_channel_deliveries DROP COLUMN created_at");
    await applyAppMigrations(db);
    await applyAppMigrations(db);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    const created = await db.query("SELECT created_at FROM pending_channel_deliveries WHERE id = 'repair-job'");
    expect(Number(created.rows[0]?.created_at)).toBeGreaterThan(0);
    await db.query("ALTER TABLE pending_channel_deliveries DROP COLUMN delivery_token, DROP COLUMN first_sending_at");
    await applyAppMigrations(db);
    const token = await db.query("SELECT delivery_token, first_sending_at FROM pending_channel_deliveries WHERE id = 'repair-job'");
    expect(token.rows[0]?.delivery_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.rows[0]?.first_sending_at).toBeNull();
    await applyAppMigrations(db);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    expect((await db.query("SELECT delivery_token FROM pending_channel_deliveries WHERE id = 'repair-job'")).rows[0]?.delivery_token).toBe(token.rows[0]?.delivery_token);
    await db.query("DELETE FROM pending_channel_deliveries WHERE id = 'repair-job'");
  });

  it("backfills active child subscriptions once without reactivating finished history", async () => {
    await db.query(`INSERT INTO child_watches (child_session_id, queue_item_id, parent_session_id, parent_thread_id, actor_user_id, org_id, settled, created_at)
      VALUES ('repair-child', 'q', 'parent', 't', 'u', 'o', true, 1), ('repair-done', 'q', 'parent', 't', 'u', 'o', true, 1)`);
    await db.query(`INSERT INTO engine_wakeups (id, session_id, thread_id, kind, status, reason, log_offset, log_tail, event_count, created_at, updated_at)
      VALUES ('wk_child_events:repair-child', 'parent', 't', 'event', 'running', 'updates', 0, '', 0, 1, 1)`);
    await db.query('ALTER TABLE child_watches DROP COLUMN delivery_active, DROP COLUMN pending_cap_incident');
    await applyAppMigrations(db);
    expect((await db.query("SELECT child_session_id, delivery_active, pending_cap_incident FROM child_watches ORDER BY child_session_id")).rows).toEqual([
      { child_session_id: "repair-child", delivery_active: true, pending_cap_incident: null },
      { child_session_id: "repair-done", delivery_active: false, pending_cap_incident: null },
    ]);
    await db.query("UPDATE child_watches SET delivery_active = false WHERE child_session_id = 'repair-child'");
    await applyAppMigrations(db);
    expect((await db.query("SELECT delivery_active FROM child_watches WHERE child_session_id = 'repair-child'")).rows).toEqual([{ delivery_active: false }]);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM engine_wakeups WHERE id = 'wk_child_events:repair-child'");
    await db.query("DELETE FROM child_watches WHERE child_session_id IN ('repair-child', 'repair-done')");
  });

  it("repairs durable child-result outcomes and their pending index on an existing database", async () => {
    await db.query("ALTER TABLE engine_queue_items DROP COLUMN child_result_delivery");
    await applyAppMigrations(db);
    await applyAppMigrations(db);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'engine_queue_items' AND column_name = 'child_result_delivery'")).rows)
      .toEqual([{ column_name: "child_result_delivery" }]);
    expect((await db.query("SELECT indexname FROM pg_indexes WHERE indexname = 'engine_queue_items_child_delivery'")).rows)
      .toEqual([{ indexname: "engine_queue_items_child_delivery" }]);
  });

  it("clears unwatched pending results without rewriting watched or resolved results on repeated repairs", async () => {
    await db.query(`INSERT INTO child_watches (child_session_id, queue_item_id, parent_session_id, parent_thread_id, actor_user_id, org_id, settled, created_at)
      VALUES ('repair-watched', 'repair-result-watched', 'p', 't', 'u', 'o', true, 1)`);
    for (const [session, state] of [["watched", "pending"], ["conversation", "pending"], ["delivered", "delivered"], ["denied", "denied"]]) {
      await db.query(`INSERT INTO engine_queue_items (id, session_id, thread_id, status, content, attempt_count, max_attempts, timeout_at, created_at, updated_at, child_result_delivery)
        VALUES ($1, $2, 't', 'settled', '{}', 1, 10, 100, 1, 1, $3)`, [`repair-result-${session}`, `repair-${session}`, state]);
    }
    try {
      await applyAppMigrations(db);
      await applyAppMigrations(db);
      expect((await db.query("SELECT id, child_result_delivery FROM engine_queue_items WHERE id LIKE 'repair-result-%' ORDER BY id")).rows).toEqual([
        { id: "repair-result-conversation", child_result_delivery: null },
        { id: "repair-result-delivered", child_result_delivery: "delivered" },
        { id: "repair-result-denied", child_result_delivery: "denied" },
        { id: "repair-result-watched", child_result_delivery: "pending" },
      ]);
    } finally {
      await db.query("DELETE FROM engine_queue_items WHERE id LIKE 'repair-result-%'");
      await db.query("DELETE FROM child_watches WHERE child_session_id = 'repair-watched'");
    }
  });

  /** dev-v2's assistants table: several rows per owner, with a default flag. */
  async function restorePreviousSchema() {
    await db.query("DROP INDEX assistants_workspace");
    await db.query("ALTER TABLE assistants ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false");
  }

  it("retains old override rows but quarantines their unscoped allow authority once", async () => {
    await db.query("ALTER TABLE action_policy_overrides DROP COLUMN legacy_unscoped");
    await db.query(`INSERT INTO action_policy_overrides(id, org_id, user_id, action_id, mode, created_at, updated_at)
      VALUES ('old-allow', 'legacy-org', 'legacy-user', 'gmail.send_email', 'allow', 1, 1),
             ('old-deny', 'legacy-org', 'legacy-user', 'github.create_issue', 'deny', 1, 1)`);
    await applyAppMigrations(db);
    await db.query(`INSERT INTO action_policy_overrides(id, org_id, user_id, action_id, mode, created_at, updated_at)
      VALUES ('new-allow', 'legacy-org', 'legacy-user', 'slack.send_message', 'allow', 2, 2)`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT id, mode, legacy_unscoped FROM action_policy_overrides ORDER BY id")).rows).toEqual([
      { id: "new-allow", mode: "allow", legacy_unscoped: false },
      { id: "old-allow", mode: "allow", legacy_unscoped: true },
      { id: "old-deny", mode: "deny", legacy_unscoped: true },
    ]);
    await db.query("DELETE FROM action_policy_overrides");
  });

  it("moves each share stored as a team credential row into its own share row", async () => {
    await db.query("DROP TABLE credential_shares");
    await db.query(`INSERT INTO credentials(owner_type, owner_id, service, type, metadata, created_at, updated_at)
      VALUES ('team', 'team-s', 'linear', 'api_key', '{"delegatedFrom":"bea","sourceType":"api_key"}', 5, 5),
             ('team', 'team-s', 'github', 'oauth2', NULL, 6, 6)`);
    await applyAppMigrations(db);
    const shares = (await db.query("SELECT team_id, service, user_id, created_at FROM credential_shares")).rows as
      Array<{ team_id: string; service: string; user_id: string; created_at: string }>;
    expect(shares.map((r) => [r.team_id, r.service, r.user_id, Number(r.created_at)])).toEqual([["team-s", "linear", "bea", 5]]);
    const rows = (await db.query("SELECT service FROM credentials WHERE owner_id = 'team-s'")).rows as Array<{ service: string }>;
    // The team's own connection stays where it was.
    expect(rows.map((r) => r.service)).toEqual(["github"]);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM credential_shares");
    await db.query("DELETE FROM credentials WHERE owner_id = 'team-s'");
  });

  it("adds lasting account consent without approving existing shares", async () => {
    await db.query("ALTER TABLE credential_shares DROP COLUMN IF EXISTS borrow_consent_at");
    await db.query("INSERT INTO credential_shares(team_id, service, user_id, created_at) VALUES ('old-consent', 'linear', 'member', 1)");
    await applyAppMigrations(db);
    expect((await db.query("SELECT borrow_consent_at FROM credential_shares WHERE team_id = 'old-consent'")).rows).toEqual([{ borrow_consent_at: null }]);
    await db.query("UPDATE credential_shares SET borrow_consent_at = 42 WHERE team_id = 'old-consent'");
    await applyAppMigrations(db);
    expect((await db.query("SELECT borrow_consent_at::text FROM credential_shares WHERE team_id = 'old-consent'")).rows).toEqual([{ borrow_consent_at: "42" }]);
    await db.query("DELETE FROM credential_shares WHERE team_id = 'old-consent'");
  });

  it("assigns stable distinct generations to shares on upgrade", async () => {
    await db.query("ALTER TABLE credential_shares DROP COLUMN generation");
    await db.query(`INSERT INTO credential_shares(team_id, service, user_id, created_at)
      VALUES ('generation-a', 'linear', 'member', 1), ('generation-b', 'linear', 'member', 1)`);
    await applyAppMigrations(db);
    const first = await db.query("SELECT generation FROM credential_shares ORDER BY team_id");
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]).not.toEqual(first.rows[1]);
    expect(first.rows[0]).toMatchObject({ generation: expect.any(String) });
    await applyAppMigrations(db);
    expect((await db.query("SELECT generation FROM credential_shares ORDER BY team_id")).rows).toEqual(first.rows);
    await db.query("DELETE FROM credential_shares");
  });

  it("preserves legacy memory while adding independent execution namespaces", async () => {
    await db.query("ALTER TABLE memory_files DROP CONSTRAINT memory_files_pkey");
    await db.query("ALTER TABLE memory_files DROP COLUMN namespace");
    await db.query("ALTER TABLE memory_files ADD PRIMARY KEY(owner_type, owner_id, path)");
    await db.query("INSERT INTO memory_files(owner_type, owner_id, path, content, created_at, updated_at) VALUES ('team', 'memory-upgrade', 'note.md', 'Legacy', 1, 1)");
    await applyAppMigrations(db);
    await db.query("INSERT INTO memory_files(owner_type, owner_id, namespace, path, content, created_at, updated_at) VALUES ('team', 'memory-upgrade', 'private', 'note.md', 'Private', 2, 2)");
    await applyAppMigrations(db);
    expect((await db.query("SELECT namespace, content FROM memory_files WHERE owner_id = 'memory-upgrade' ORDER BY namespace")).rows).toEqual([
      { namespace: "", content: "Legacy" }, { namespace: "private", content: "Private" },
    ]);
    const app = drizzle(pglite, { schema });
    const scope = { owner: { type: "team", id: "memory-upgrade" }, actorUserId: "member" } as const;
    expect(await readFile(app, scope, "note.md")).toMatchObject({ rendered: expect.stringContaining("Legacy") });
    expect(await searchFiles(app, scope, { query: "Legacy" })).toMatchObject([{ path: "note.md" }]);
    await writeFile(app, scope, { path: "note.md", content: "Updated on next run" });
    await applyAppMigrations(db);
    expect(await readFile(app, scope, "note.md")).toMatchObject({ rendered: expect.stringContaining("Updated on next run") });
    await db.query("DELETE FROM memory_files WHERE owner_id = 'memory-upgrade'");
  });

  it("recovers a quarantined corpus once and refuses to overwrite a shared-path collision", async () => {
    await db.query(`INSERT INTO memory_files(owner_type, owner_id, namespace, path, content, created_at, updated_at)
      VALUES ('team', 'recover', 'legacy', 'note.md', 'Original', 1, 1),
             ('team', 'recover', '', 'note.md', 'Newer', 2, 2)`);
    await expect(applyAppMigrations(db)).rejects.toThrow("conflicting legacy/shared paths");
    expect((await db.query("SELECT content FROM memory_files WHERE owner_id = 'recover' ORDER BY content")).rows)
      .toEqual([{ content: "Newer" }, { content: "Original" }]);
    await db.query("UPDATE memory_files SET path = 'newer.md' WHERE owner_id = 'recover' AND namespace = ''");
    await applyAppMigrations(db);
    await applyAppMigrations(db);
    expect((await db.query("SELECT namespace, path, content FROM memory_files WHERE owner_id = 'recover' ORDER BY path")).rows)
      .toEqual([{ namespace: "", path: "newer.md", content: "Newer" }, { namespace: "", path: "note.md", content: "Original" }]);
    await db.query("DELETE FROM memory_files WHERE owner_id = 'recover'");
  });

  it("adds source replay state to an existing waiter without changing its delivered keys", async () => {
    await db.query("ALTER TABLE engine_wakeups DROP COLUMN event_source_seen");
    await db.query(`INSERT INTO engine_wakeups(id, session_id, thread_id, kind, status, reason, created_at, updated_at, event_seen)
      VALUES ('legacy-waiter', 'session', 'thread', 'event', 'running', 'CI', 1, 1, '["completion"]')`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT event_seen, event_source_seen FROM engine_wakeups WHERE id = 'legacy-waiter'")).rows)
      .toEqual([{ event_seen: '["completion"]', event_source_seen: null }]);
    await db.query("DELETE FROM engine_wakeups WHERE id = 'legacy-waiter'");
  });

  it("repairs a missing legacy behavior column before the boot report", async () => {
    await db.query("ALTER TABLE assistants DROP COLUMN behavior");
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await expect(reportRetiredAssistantSettings(db)).resolves.toBeNull();
  });

  it("names each workspace that keeps an integration allow-list", async () => {
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, created_at, behavior)
      VALUES ('limited', 'org-r', 'team', 'team-limited', 'limited-session', 1, '{"integrations":["github"]}'),
             ('plain', 'org-r', 'user', 'user-plain', 'plain-session', 1, NULL)`);
    const message = await reportRetiredAssistantSettings(db);
    expect(message).toContain("team:team-limited");
    expect(message).not.toContain("user:user-plain");
    await db.query("DELETE FROM assistants WHERE id IN ('limited', 'plain')");
  });

  it("keeps the oldest team on a shared home channel before it enforces one team per channel", async () => {
    await db.query("DROP INDEX teams_org_slack_home");
    await db.query(`INSERT INTO teams(id, org_id, name, created_at, slack_home_channel_id)
      VALUES ('home-old', 'org', 'Old', 1, 'C0SHARED'), ('home-new', 'org', 'New', 2, 'C0SHARED'), ('home-other-org', 'org-2', 'Elsewhere', 3, 'C0SHARED')`);
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    const homes = await db.query("SELECT id, slack_home_channel_id FROM teams WHERE id LIKE 'home-%' ORDER BY id");
    expect(homes.rows).toEqual([
      { id: "home-new", slack_home_channel_id: null },
      { id: "home-old", slack_home_channel_id: "C0SHARED" },
      { id: "home-other-org", slack_home_channel_id: "C0SHARED" },
    ]);
    await expect(db.query("UPDATE teams SET slack_home_channel_id = 'C0SHARED' WHERE id = 'home-new'")).rejects.toThrow(/unique/i);
  });

  it("repairs the previous columns with one executable statement and reserves retired owners", async () => {
    await restorePreviousSchema();
    await db.query("ALTER TABLE teams DROP COLUMN slack_home_channel_id");
    await db.query("ALTER TABLE user_notification_preferences DROP COLUMN team_dm");
    await db.query("ALTER TABLE artifacts DROP COLUMN source_thread_id");
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('live', 'org', 'user', 'live-owner', 'live-session', true, 1, NULL),
             ('retired', 'org', 'team', 'retired-owner', 'retired-session', false, 1, 2)`);
    const missing = (await missingSchemaRepairs(db)).map(repair => repair.describe);
    expect(missing).toContain("workspace assistant singleton cutover");
    expect(missing).toContain("artifacts.source_thread_id column");

    // The migration tracker is already populated, so this exercises the same
    // repair query path used at restart, including prepared-statement limits.
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    const added = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND
      ((table_name = 'teams' AND column_name = 'slack_home_channel_id') OR
       (table_name = 'user_notification_preferences' AND column_name = 'team_dm') OR
       (table_name = 'artifacts' AND column_name = 'source_thread_id')) ORDER BY table_name`);
    expect(added.rows).toEqual([
      { table_name: "artifacts", column_name: "source_thread_id" },
      { table_name: "teams", column_name: "slack_home_channel_id" },
      { table_name: "user_notification_preferences", column_name: "team_dm" },
    ]);
    await expect(db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, created_at)
      VALUES ('replacement', 'org', 'team', 'retired-owner', 'replacement-session', 3)`)).rejects.toThrow(/unique/i);
    const preserved = await db.query("SELECT id, session_id, archived_at FROM assistants WHERE org_id = 'org' ORDER BY id");
    expect(preserved.rows).toEqual([
      { id: "live", session_id: "live-session", archived_at: null },
      { id: "retired", session_id: "retired-session", archived_at: 2 },
    ]);
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM assistants WHERE org_id = 'org'");
  });

  it("preserves explicit assistant deletion during the singleton cutover", async () => {
    await restorePreviousSchema();
    await db.query(`INSERT INTO teams(id, org_id, name, created_at) VALUES ('live-team', 'org', 'Live team', 1)`);
    // dev-v2 deleted a team assistant by archiving it and marking its session deleted.
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('deleted-profile', 'org', 'team', 'live-team', 'deleted-profile-session', false, 1, 2)`);
    await db.query(`INSERT INTO agent_sessions(id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ('deleted-profile-session', 'u', 'org', '/', 'deleted', 'team', 'live-team', 1, 1)`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT archived_at FROM assistants WHERE id = 'deleted-profile'")).rows).toEqual([{ archived_at: 2 }]);
    expect((await db.query("SELECT status FROM agent_sessions WHERE id = 'deleted-profile-session'")).rows).toEqual([{ status: "deleted" }]);
    await db.query("DELETE FROM agent_sessions WHERE id = 'deleted-profile-session'");
    await db.query("DELETE FROM assistants WHERE org_id = 'org'");
    await db.query("DELETE FROM teams WHERE id = 'live-team'");
  });

  it("preserves linked workflows and transcripts through duplicate retirement and a second boot", async () => {
    await restorePreviousSchema();
    // These table names and predicates are fixed test data, never request input.
    const preservedTables = ["engine_sessions", "engine_threads", "engine_entries", "workflow_runs", "workflow_schedules"];
    const allTables = [...preservedTables, "assistants", "agent_sessions", "workflow_definitions", "workflow_versions", "event_subscriptions"];
    async function snapshot() {
      const rows: Record<string, unknown[]> = {};
      for (const table of allTables) {
        rows[table] = (await db.query(`SELECT * FROM ${table} WHERE id LIKE 'preserve-%' ORDER BY id`)).rows;
      }
      rows.workflow_checkpoints = (await db.query("SELECT * FROM workflow_checkpoints WHERE run_id LIKE 'preserve-%' ORDER BY run_id, node_id, iteration")).rows;
      return rows;
    }
    try {
      for (const ownerType of ["user", "team"] as const) {
        const owner = `preserve-${ownerType}`;
        for (const variant of ["main", "extra"] as const) {
          const id = `${owner}-${variant}`;
          await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at)
            VALUES ($1, 'preserve-org', $2, $3, $4, $5, $6)`, [id, ownerType, owner, `${id}-session`, variant === "main", variant === "main" ? 1 : 2]);
          await db.query(`INSERT INTO agent_sessions(id, user_id, org_id, workspace, owner_type, owner_id, created_at, updated_at)
            VALUES ($1, 'preserve-user', 'preserve-org', '/workspace', $2, $3, 1, 1)`, [`${id}-session`, ownerType, owner]);
          await db.query(`INSERT INTO engine_sessions(id, user_id, org_id, workspace, owner_type, owner_id, purpose, status, metadata, created_at, updated_at)
            VALUES ($1, 'preserve-user', 'preserve-org', '/workspace', $2, $3, 'orchestrator', 'active', '{"legacy":true}', 1, 1)`, [`${id}-session`, ownerType, owner]);
          await db.query(`INSERT INTO engine_threads(id, session_id, key, status, queue_mode, active_leaf_entry_id, created_at, updated_at)
            VALUES ($1, $2, 'main', 'idle', 'followup', $3, 1, 1)`, [`${id}-thread`, `${id}-session`, `${id}-answer`]);
          await db.query(`INSERT INTO engine_entries(id, session_id, thread_id, entry_type, role, content, author, attachments, created_at)
            VALUES ($1, $2, $3, 'message', 'user', 'Review the attached agreement', '{"id":"preserve-user","name":"Owner"}',
              '[{"id":"attachment-1","name":"agreement.docx","url":"blob:agreement"}]', 1)`, [`${id}-question`, `${id}-session`, `${id}-thread`]);
          await db.query(`INSERT INTO engine_entries(id, session_id, thread_id, parent_id, entry_type, role, content, parts, usage, created_at)
            VALUES ($1, $2, $3, $4, 'message', 'assistant', 'Reviewed agreement.',
              '[{"type":"text","text":"Reviewed agreement."},{"type":"tool-result","toolCallId":"read-1","result":{"clauses":3}}]',
              '{"input":42,"output":17}', 1)`, [`${id}-answer`, `${id}-session`, `${id}-thread`, `${id}-question`]);
        }
        const definition = { version: "dag/v1", assistantId: `${owner}-extra`,
          nodes: [{ id: "review", type: "orchestrator", prompt: "Review {{params.document}}" }], edges: [] };
        await db.query(`INSERT INTO workflow_definitions(id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
          VALUES ($1, 'preserve-org', $2, $3, 'Agreement review', $4, 1, 2)`, [`${owner}-workflow`, ownerType, owner, JSON.stringify(definition)]);
        for (const version of [1, 2]) {
          await db.query(`INSERT INTO workflow_versions(id, workflow_id, version, name, definition, created_at)
            VALUES ($1, $2, $3, 'Agreement review', $4, 1)`, [`${owner}-version-${version}`, `${owner}-workflow`, version, JSON.stringify(definition)]);
        }
        for (const outcome of ["success", "failure"]) {
          const runId = `${owner}-run-${outcome}`;
          await db.query(`INSERT INTO workflow_runs(id, workflow_id, definition_version_id, definition, params, status, outcome, owner_type, owner_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, '{"document":"agreement.docx"}', 'settled', $5, $6, $7, 3, 4)`,
          [runId, `${owner}-workflow`, `${owner}-version-1`, JSON.stringify(definition), outcome, ownerType, owner]);
          await db.query(`INSERT INTO workflow_checkpoints(run_id, node_id, attempt, status, result, effects, error, created_at)
            VALUES ($1, 'review', 1, $2, '{"clauses":3}', $3, $4, 4)`,
          [runId, outcome === "success" ? "completed" : "failed", JSON.stringify({ sessionId: `${owner}-extra-session`, threadId: `${owner}-extra-thread` }), outcome === "failure" ? "Provider unavailable" : null]);
        }
        await db.query(`INSERT INTO workflow_schedules(id, org_id, owner_type, owner_id, name, cron, next_fire_at, workflow_id, input, created_by, created_at, updated_at)
          VALUES ($1, 'preserve-org', $2, $3, 'Daily review', '0 9 * * *', 1000, $4, '{"document":"agreement.docx"}', 'preserve-user', 1, 2)`,
        [`${owner}-schedule`, ownerType, owner, `${owner}-workflow`]);
        for (const kind of ["workflow", "orchestrator"] as const) {
          const target = kind === "workflow" ? { kind, workflowId: `${owner}-workflow` }
            : { kind, orchestrator: ownerType, assistantId: `${owner}-extra`, follow: true };
          await db.query(`INSERT INTO event_subscriptions(id, org_id, owner_type, owner_id, name, event_keys, filters, target, created_by, created_at, updated_at)
            VALUES ($1, 'preserve-org', $2, $3, 'Review on push', '["github.push"]', '[{"path":"ref","op":"eq","value":"main"}]', $4, 'preserve-user', 1, 2)`,
          [`${owner}-subscription-${kind}`, ownerType, owner, JSON.stringify(target)]);
        }
      }
      const before = await snapshot();
      await applyAppMigrations(db);
      const after = await snapshot();
      for (const table of [...preservedTables, "workflow_checkpoints"]) {
        expect(after[table], table).toEqual(before[table]);
      }
      for (const table of ["workflow_definitions", "workflow_versions"]) {
        // Every other field, including IDs, version numbers and timestamps, survives.
        expect(after[table]).toEqual(before[table]?.map((row) => {
          const original = row as { definition: Record<string, unknown> };
          const { assistantId: _retired, ...definition } = original.definition;
          return { ...original, definition };
        }));
      }
      expect(after.assistants).toEqual(before.assistants?.map((row) => {
        const original = row as { id: string; owner_id: string };
        return original.id.endsWith("-extra")
          ? { ...original, owner_id: `${original.owner_id}:retired:${original.id}`, archived_at: expect.any(Number) }
          : original;
      }));
      expect(after.agent_sessions).toEqual(before.agent_sessions?.map((row) => {
        const original = row as { id: string };
        return original.id.endsWith("-extra-session")
          ? { ...original, status: "deleted", updated_at: expect.any(Number) }
          : original;
      }));
      expect(after.event_subscriptions).toEqual(before.event_subscriptions?.map((row) => {
        const original = row as { target: Record<string, unknown> };
        if (!("assistantId" in original.target)) return original;
        const { assistantId: _retired, ...target } = original.target;
        return { ...original, target, updated_at: expect.any(Number) };
      }));
      await applyAppMigrations(db);
      expect(await snapshot()).toEqual(after);
      expect(await missingSchemaRepairs(db)).toEqual([]);
    } finally {
      await db.query("DELETE FROM workflow_checkpoints WHERE run_id LIKE 'preserve-%'");
      for (const table of [...allTables].reverse()) await db.query(`DELETE FROM ${table} WHERE id LIKE 'preserve-%'`);
    }
  });

  it("drops assistantId from stored workflows", async () => {
    const legacy = JSON.stringify({ version: "dag/v1", assistantId: "asst_old",
      nodes: [{ id: "o", type: "orchestrator", prompt: "hi" }], edges: [] });
    const current = JSON.stringify({ version: "dag/v1", nodes: [{ id: "t", type: "orchestrator", prompt: "hi" }], edges: [] });
    await db.query(`INSERT INTO workflow_definitions(id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('wf-legacy', 'wf-org', 'user', 'u', 'legacy', $1, 1, 1), ('wf-current', 'wf-org', 'user', 'u', 'current', $2, 1, 1)`, [legacy, current]);
    await db.query(`INSERT INTO workflow_versions(id, workflow_id, version, name, definition, created_at) VALUES ('wv-legacy', 'wf-legacy', 1, 'legacy', $1, 1)`, [legacy]);
    await db.query(`INSERT INTO workflow_runs(id, workflow_id, definition_version_id, definition, params, created_at, updated_at)
      VALUES ('run-legacy', 'wf-legacy', 'wv-legacy', $1, '{}', 1, 1)`, [legacy]);
    await db.query(`INSERT INTO workflow_templates(id, org_id, owner_type, owner_id, template_id, upstream_path, template, created_at, updated_at)
      VALUES ('tpl-legacy', 'wf-org', 'user', 'u', 't', 'p', $1, 1, 1)`, [JSON.stringify({ id: "t", name: "T", definition: JSON.parse(legacy) })]);
    // A settled run never executes again, so its snapshot is left as it was.
    await db.query(`INSERT INTO workflow_runs(id, workflow_id, definition_version_id, definition, params, status, created_at, updated_at)
      VALUES ('run-settled-legacy', 'wf-legacy', 'wv-legacy', $1, '{}', 'settled', 1, 1)`, [legacy]);
    await normalizeLegacyWorkflowDefinitions(db);
    await normalizeLegacyWorkflowDefinitions(db);
    expect((await db.query("SELECT definition FROM workflow_runs WHERE id = 'run-settled-legacy'")).rows[0]).toEqual({ definition: JSON.parse(legacy) });
    const expected = { version: "dag/v1", nodes: [{ id: "o", type: "orchestrator", prompt: "hi" }], edges: [] };
    for (const [table, id] of [["workflow_definitions", "wf-legacy"], ["workflow_versions", "wv-legacy"], ["workflow_runs", "run-legacy"]]) {
      expect((await db.query(`SELECT definition FROM ${table} WHERE id = $1`, [id])).rows[0]).toEqual({ definition: expected });
    }
    expect((await db.query("SELECT definition FROM workflow_definitions WHERE id = 'wf-current'")).rows[0]).toEqual({ definition: JSON.parse(current) });
    expect((await db.query("SELECT template FROM workflow_templates WHERE id = 'tpl-legacy'")).rows[0]).toEqual({ template: { id: "t", name: "T", definition: expected } });
    for (const table of ["workflow_runs", "workflow_versions", "workflow_templates", "workflow_definitions"]) {
      await db.query(`DELETE FROM ${table} WHERE id LIKE '%legacy' OR id = 'wf-current'`);
    }
  });

  it("keeps team DM copies on for members present at upgrade", async () => {
    await db.query("ALTER TABLE user_notification_preferences DROP COLUMN team_dm");
    await db.query(`INSERT INTO team_members(team_id, user_id, role) VALUES ('dm-team', 'dm-member', 'member'), ('dm-team-2', 'dm-member', 'admin')`);
    await db.query(`INSERT INTO user_notification_preferences(user_id, kind, web) VALUES ('dm-member', 'question', false)`);
    await applyAppMigrations(db);
    const rows = await db.query(`SELECT kind, web, team_dm FROM user_notification_preferences WHERE user_id = 'dm-member' ORDER BY kind`);
    expect(rows.rows).toEqual([
      { kind: "approval", web: true, team_dm: true },
      { kind: "escalation", web: true, team_dm: true },
      { kind: "notification", web: true, team_dm: true },
      { kind: "question", web: false, team_dm: true },
      { kind: "review", web: true, team_dm: true },
    ]);
    // A member who joins after the upgrade keeps the new opt-in default.
    await db.query(`INSERT INTO team_members(team_id, user_id, role) VALUES ('dm-team', 'late-member', 'member')`);
    await applyAppMigrations(db);
    expect((await db.query(`SELECT 1 FROM user_notification_preferences WHERE user_id = 'late-member'`)).rows).toHaveLength(0);
    await db.query(`DELETE FROM user_notification_preferences WHERE user_id IN ('dm-member', 'late-member')`);
    await db.query(`DELETE FROM team_members WHERE user_id IN ('dm-member', 'late-member')`);
  });

  it("strips retired assistant selections from stored subscription targets", async () => {
    await db.query(`INSERT INTO event_subscriptions(id, org_id, owner_type, owner_id, name, event_keys, filters, target, enabled, created_by, created_at, updated_at)
      VALUES ('legacy-rule', 'strip-org', 'user', 'u', 'legacy', '["github.push"]', '[]',
        '{"kind":"orchestrator","orchestrator":"user","assistantId":"asst_retired","follow":true}', true, 'u', 1, 1),
        ('clean-rule', 'strip-org', 'user', 'u', 'clean', '["github.push"]', '[]', '{"kind":"workflow","workflowId":"w1"}', true, 'u', 1, 1)`);
    await stripRetiredAssistantTargets(db);
    await stripRetiredAssistantTargets(db);
    const rows = await db.query("SELECT id, target, updated_at FROM event_subscriptions WHERE org_id = 'strip-org' ORDER BY id");
    expect(rows.rows).toEqual([
      { id: "clean-rule", target: { kind: "workflow", workflowId: "w1" }, updated_at: 1 },
      // The repair removes only `assistantId`. No backfill renames the stored
      // `orchestrator` names; reads accept both (presence hub spec, Part H step 5).
      { id: "legacy-rule", target: { kind: "orchestrator", orchestrator: "user", follow: true }, updated_at: expect.anything() },
    ]);
    await db.query("DELETE FROM event_subscriptions WHERE org_id = 'strip-org'");
  });

  it("keeps one row per owner without restoring archived profiles", async () => {
    await restorePreviousSchema();
    await db.query(`INSERT INTO "user"(id, name, email, email_verified, created_at, updated_at)
      VALUES ('dup-owner', 'Owner', 'dup-owner@example.test', false, now(), now()),
             ('lone-owner', 'Lone', 'lone-owner@example.test', false, now(), now())
      ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('archived-old', 'dup-org', 'user', 'dup-owner', 'old-session', false, 1, 2),
             ('live-default', 'dup-org', 'user', 'dup-owner', 'default-session', true, 2, NULL),
             ('live-extra', 'dup-org', 'user', 'dup-owner', 'extra-session', false, 3, NULL),
             ('lone-archived', 'dup-org', 'user', 'lone-owner', 'lone-session', false, 1, 5),
             ('gone-team', 'dup-org', 'team', 'deleted-team', 'gone-session', true, 1, 7)`);
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    const rows = await db.query(`SELECT id, owner_id, archived_at IS NULL AS live, session_id
      FROM assistants WHERE org_id = 'dup-org' ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: "archived-old", owner_id: "dup-owner:retired:archived-old", live: false, session_id: "old-session" },
      { id: "gone-team", owner_id: "deleted-team", live: false, session_id: "gone-session" },
      { id: "live-default", owner_id: "dup-owner", live: true, session_id: "default-session" },
      { id: "live-extra", owner_id: "dup-owner:retired:live-extra", live: false, session_id: "extra-session" },
      { id: "lone-archived", owner_id: "lone-owner", live: false, session_id: "lone-session" },
    ]);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM assistants WHERE org_id = 'dup-org'");
    await db.query(`DELETE FROM "user" WHERE id IN ('dup-owner', 'lone-owner')`);
  });
});
