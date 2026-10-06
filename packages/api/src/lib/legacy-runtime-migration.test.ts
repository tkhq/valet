import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, buildAppDb } from "./drizzle.js";
import { isLegacyAssistantConversation, isLegacyAssistantRuntime, legacyWorkflowRunRuntime, legacyWorkflowRuntime } from "../services/legacy-runtime.js";
import { loadAssistantBySessionId, retireAssistant } from "../assistants/service.js";
import { assistantMemoryNamespace } from "../services/memory-scope.js";

describe("one-time legacy runtime continuity upgrade", () => {
  const raw = new PGlite();
  const pg = pgDbFromPglite(raw);
  const db = buildAppDb(raw);
  beforeAll(async () => { await applyAppMigrations(pg); });
  afterAll(async () => { await pg.close(); });

  it("captures existing roots, conversations and definitions once across two restarts", async () => {
    await pg.query("DELETE FROM __valet_app_migrations WHERE filename = 'legacy-runtime-continuity-v1'");
    await pg.query("DROP TABLE legacy_assistant_conversations, legacy_assistant_runtimes, legacy_workflow_runtimes");
    await pg.query(`INSERT INTO assistants (id, org_id, owner_type, owner_id, session_id, created_at)
      VALUES ('old', 'org', 'team', 'team', 'old-root', 1)`);
    await pg.query(`INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
      VALUES ('old-root', 'team', 'team', 'user', 'org', '/existing/files', 'assistant', 'active', 1, 1)`);
    await pg.query(`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
      VALUES ('old-thread', 'old-root', 'slack:old:1', 'active', 'followup', 1, 1)`);
    await pg.query(`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('old-workflow', 'org', 'team', 'team', 'Old workflow', '{"version":"dag/v1","nodes":[],"edges":[]}', 1, 1)`);
    await applyAppMigrations(pg);
    expect(await isLegacyAssistantRuntime(db, 'old-root', 'org')).toBe(true);
    expect(await isLegacyAssistantRuntime(db, 'old-root', 'other-org')).toBe(false);
    expect(await isLegacyAssistantConversation(db, 'old-root', 'slack:old:1', 'org')).toBe(true);
    expect(await assistantMemoryNamespace(db, 'old-root', 'team', 'org')).toBe('');
    expect(await assistantMemoryNamespace(db, 'old-root', 'other-team', 'org')).toBe('old-root');
    expect(await legacyWorkflowRuntime(db, 'old-workflow', 'org')).toBe('old-root');
    await pg.query(`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
      VALUES ('new-thread', 'old-root', 'slack:new:1', 'active', 'followup', 2, 2)`);
    await pg.query(`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('new-workflow', 'org', 'team', 'team', 'New workflow', '{"version":"dag/v1","nodes":[],"edges":[]}', 2, 2)`);
    await applyAppMigrations(pg);
    await applyAppMigrations(pg);
    expect(await isLegacyAssistantConversation(db, 'old-root', 'slack:new:1', 'org')).toBe(false);
    expect(await legacyWorkflowRuntime(db, 'new-workflow', 'org')).toBeUndefined();
    expect((await pg.query("SELECT workspace FROM engine_sessions WHERE id = 'old-root'")).rows).toEqual([{ workspace: '/existing/files' }]);
    await pg.query("UPDATE assistants SET archived_at = 3 WHERE id = 'old'");
    expect(await isLegacyAssistantRuntime(db, 'old-root', 'org')).toBe(false);
  });
  it("retains active duplicate identities and their selected workflow runtime without reviving archived profiles", async () => {
    await pg.query("DELETE FROM __valet_app_migrations WHERE filename = 'legacy-runtime-continuity-v1'");
    await pg.query("DROP INDEX assistants_workspace");
    await pg.query("ALTER TABLE assistants ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false");
    await pg.query(`INSERT INTO teams(id, org_id, name, created_at) VALUES ('duplicates', 'org', 'Duplicates', 1)`);
    await pg.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, created_at, is_default, archived_at)
      VALUES ('canonical', 'org', 'team', 'duplicates', 'canonical-root', 5, true, NULL),
        ('extra', 'org', 'team', 'duplicates', 'extra-root', 9, false, NULL),
        ('archived', 'org', 'team', 'duplicates', 'archived-root', 8, false, 9)`);
    await pg.query(`INSERT INTO engine_sessions(id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
      SELECT session_id, owner_type, owner_id, 'user', org_id, '/original/' || id, 'assistant', 'active', 1, 1
      FROM assistants WHERE owner_id = 'duplicates'`);
    await pg.query(`INSERT INTO agent_sessions(id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ('extra-root', 'user', 'org', '/original/extra', 'active', 'team', 'duplicates', 1, 1)`);
    await pg.query(`INSERT INTO workflow_definitions(id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('selected-extra', 'org', 'team', 'duplicates', 'Selected extra',
        '{"version":"dag/v1","nodes":[],"edges":[],"assistantId":"extra"}', 1, 1)`);
    await pg.query(`INSERT INTO workflow_definitions(id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('selected-default', 'org', 'team', 'duplicates', 'Selected default',
        '{"version":"dag/v1","nodes":[],"edges":[]}', 1, 1)`);
    await pg.query(`INSERT INTO workflow_runs(id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
      VALUES ('old-version-run', 'selected-default', 'old-v1',
        '{"version":"dag/v1","nodes":[],"edges":[],"assistantId":"extra"}', '{}', 'team', 'duplicates', 1, 1)`);
    await applyAppMigrations(pg);
    await applyAppMigrations(pg);
    expect(await legacyWorkflowRunRuntime(db, 'old-version-run', 'org')).toBe('extra-root');
    expect(await legacyWorkflowRuntime(db, 'selected-default', 'org')).toBe('canonical-root');
    expect(await isLegacyAssistantRuntime(db, 'extra-root', 'org')).toBe(true);
    expect(await isLegacyAssistantRuntime(db, 'archived-root', 'org')).toBe(false);
    expect(await loadAssistantBySessionId(db, 'extra-root')).toMatchObject({ ownerId: 'duplicates', archivedAt: null });
    expect(await legacyWorkflowRuntime(db, 'selected-extra', 'org')).toBe('extra-root');
    expect(await assistantMemoryNamespace(db, 'extra-root', 'duplicates', 'org')).toBe('');
    expect((await pg.query("SELECT status FROM agent_sessions WHERE id = 'extra-root'")).rows).toEqual([{ status: 'active' }]);
    await retireAssistant(db, 'extra');
    expect(await isLegacyAssistantRuntime(db, 'extra-root', 'org')).toBe(false);
    expect(await legacyWorkflowRuntime(db, 'selected-extra', 'org')).toBeUndefined();
  });

});
