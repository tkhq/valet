import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs, normalizeLegacyWorkflowDefinitions, stripRetiredAssistantTargets } from "./drizzle.js";

describe("workspace singleton repair on an already migrated database", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  beforeAll(async () => { await applyAppMigrations(db); });
  afterAll(async () => { await db.close(); });

  async function restorePreviousSchema() {
    await db.query("DROP INDEX assistants_workspace");
    await db.query("ALTER TABLE assistants ALTER COLUMN is_default SET DEFAULT false");
  }

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
    const retained = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND
      ((table_name = 'assistants' AND column_name IN ('is_default', 'name', 'avatar_url', 'personality', 'behavior', 'model', 'reasoning')) OR
       (table_name IN ('followed_threads', 'workflow_schedules') AND column_name = 'assistant_id'))`);
    expect(retained.rows).toHaveLength(9);
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
    const indexes = await db.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('assistants_workspace', 'assistants_default_owner')");
    expect(indexes.rows).toHaveLength(2);
    const singleton = indexes.rows.find(row => row.indexname === "assistants_workspace");
    expect(singleton?.indexdef).toContain("UNIQUE INDEX");
    expect(singleton?.indexdef).not.toContain("WHERE");
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

  it("reactivates the session of a deleted assistant the cutover restores", async () => {
    await restorePreviousSchema();
    await db.query(`INSERT INTO teams(id, org_id, name, created_at) VALUES ('live-team', 'org', 'Live team', 1)`);
    // dev-v2 deleted a team assistant by archiving it and marking its session deleted.
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('deleted-profile', 'org', 'team', 'live-team', 'deleted-profile-session', false, 1, 2)`);
    await db.query(`INSERT INTO agent_sessions(id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ('deleted-profile-session', 'u', 'org', '/', 'deleted', 'team', 'live-team', 1, 1)`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT archived_at FROM assistants WHERE id = 'deleted-profile'")).rows).toEqual([{ archived_at: null }]);
    expect((await db.query("SELECT status FROM agent_sessions WHERE id = 'deleted-profile-session'")).rows).toEqual([{ status: "active" }]);
    await db.query("DELETE FROM agent_sessions WHERE id = 'deleted-profile-session'");
    await db.query("DELETE FROM assistants WHERE org_id = 'org'");
    await db.query("DELETE FROM teams WHERE id = 'live-team'");
  });

  it("marks the session of a retired extra assistant deleted", async () => {
    await restorePreviousSchema();
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('main', 'org', 'user', 'two-assistants', 'main-session', true, 1, NULL),
             ('extra', 'org', 'user', 'two-assistants', 'extra-session', false, 2, NULL)`);
    await db.query(`INSERT INTO agent_sessions(id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ('main-session', 'two-assistants', 'org', '/', 'active', 'user', 'two-assistants', 1, 1),
             ('extra-session', 'two-assistants', 'org', '/', 'active', 'user', 'two-assistants', 2, 2)`);
    await applyAppMigrations(db);
    const statuses = await db.query("SELECT id, status FROM agent_sessions WHERE id IN ('main-session', 'extra-session') ORDER BY id");
    expect(statuses.rows).toEqual([{ id: "extra-session", status: "deleted" }, { id: "main-session", status: "active" }]);
    await db.query("DELETE FROM agent_sessions WHERE id IN ('main-session', 'extra-session')");
    await db.query("DELETE FROM assistants WHERE org_id = 'org'");
  });

  it("restores the legacy default flag an older pod cleared on a live assistant", async () => {
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('flag-cleared', 'org', 'team', 'flag-team', 'flag-session', false, 1, NULL)`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT is_default FROM assistants WHERE id = 'flag-cleared'")).rows).toEqual([{ is_default: true }]);
    await db.query("DELETE FROM assistants WHERE id = 'flag-cleared'");
  });

  it("rewrites stored workflows that use thread steps or assistantId", async () => {
    const legacy = JSON.stringify({ version: "dag/v1", assistantId: "asst_old",
      nodes: [{ id: "o", type: "thread", prompt: "hi" }], edges: [] });
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
      { id: "legacy-rule", target: { kind: "orchestrator", orchestrator: "user", follow: true }, updated_at: expect.anything() },
    ]);
    await db.query("DELETE FROM event_subscriptions WHERE org_id = 'strip-org'");
  });

  it("keeps one row per owner and restores retired rows of owners that still exist", async () => {
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
    const rows = await db.query(`SELECT id, owner_id, archived_at IS NULL AS live, is_default, session_id
      FROM assistants WHERE org_id = 'dup-org' ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: "archived-old", owner_id: "dup-owner:retired:archived-old", live: false, is_default: false, session_id: "old-session" },
      { id: "gone-team", owner_id: "deleted-team", live: false, is_default: true, session_id: "gone-session" },
      { id: "live-default", owner_id: "dup-owner", live: true, is_default: true, session_id: "default-session" },
      { id: "live-extra", owner_id: "dup-owner:retired:live-extra", live: false, is_default: false, session_id: "extra-session" },
      { id: "lone-archived", owner_id: "lone-owner", live: true, is_default: true, session_id: "lone-session" },
    ]);
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM assistants WHERE org_id = 'dup-org'");
    await db.query(`DELETE FROM "user" WHERE id IN ('dup-owner', 'lone-owner')`);
  });
});
