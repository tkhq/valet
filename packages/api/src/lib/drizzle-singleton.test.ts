import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs, stripRetiredAssistantTargets } from "./drizzle.js";

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
