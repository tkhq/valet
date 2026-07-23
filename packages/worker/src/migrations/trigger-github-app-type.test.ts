import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

function applyMigrationsUpTo(sqlite: Database.Database, exclusive: string) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f < exclusive)
    .sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
}

const MIGRATION = '0029_trigger_github_app_type.sql';

/**
 * 0029 rebuilds `triggers` to widen its type CHECK. The rebuild drops the table,
 * and three children reference it — so the migration has to hold onto their rows
 * across the swap. These tests populate all of them first: without the
 * snapshot/restore the DROP silently nulls execution history and empties the
 * rate + schedule-tick tables.
 */
describe('0029_trigger_github_app_type', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrationsUpTo(sqlite, MIGRATION);

    sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('user_1', 'u1@example.com');
      INSERT INTO workflows (id, user_id, name, data)
        VALUES ('wf_1', 'user_1', 'wf', '{"version":"dag/v1"}');

      -- One trigger of every pre-0029 type.
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config, variable_mapping, last_run_at, webhook_token)
        VALUES ('trg_hook', 'user_1', 'wf_1', 'hook', 1, 'webhook',
                '{"type":"webhook","path":"inbound"}', '{"pr":"$.number"}', '2026-07-01T00:00:00Z', 'tok_hook');
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config)
        VALUES ('trg_cron', 'user_1', 'wf_1', 'cron', 1, 'schedule', '{"type":"schedule","cron":"0 * * * *"}');
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config)
        VALUES ('trg_manual', 'user_1', 'wf_1', 'manual', 0, 'manual', '{"type":"manual"}');

      -- Children that the DROP's referential actions would take with it.
      INSERT INTO workflow_executions (id, workflow_id, user_id, trigger_id, status, trigger_type, started_at)
        VALUES ('exec_1', 'wf_1', 'user_1', 'trg_hook', 'completed', 'webhook', '2026-07-01T00:00:00Z');
      INSERT INTO trigger_webhook_rate (trigger_id, window_start_ts, count)
        VALUES ('trg_hook', 1751328000, 7);
      INSERT INTO workflow_schedule_ticks (id, trigger_id, tick_bucket)
        VALUES ('tick_1', 'trg_cron', '2026-07-01T00:00');
    `);
  });

  function applyMigration() {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, MIGRATION), 'utf-8'));
  }

  it('keeps every existing trigger row through the rebuild', () => {
    applyMigration();

    const rows = sqlite.prepare('SELECT id, type, config, variable_mapping, webhook_token, enabled FROM triggers ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'trg_cron', type: 'schedule', config: '{"type":"schedule","cron":"0 * * * *"}', variable_mapping: null, webhook_token: null, enabled: 1 },
      { id: 'trg_hook', type: 'webhook', config: '{"type":"webhook","path":"inbound"}', variable_mapping: '{"pr":"$.number"}', webhook_token: 'tok_hook', enabled: 1 },
      { id: 'trg_manual', type: 'manual', config: '{"type":"manual"}', variable_mapping: null, webhook_token: null, enabled: 0 },
    ]);
  });

  it('keeps every child reference to a trigger', () => {
    applyMigration();

    expect(sqlite.prepare('SELECT trigger_id FROM workflow_executions WHERE id = ?').get('exec_1'))
      .toEqual({ trigger_id: 'trg_hook' });
    expect(sqlite.prepare('SELECT trigger_id, window_start_ts, count FROM trigger_webhook_rate').all())
      .toEqual([{ trigger_id: 'trg_hook', window_start_ts: 1751328000, count: 7 }]);
    expect(sqlite.prepare('SELECT id, trigger_id, tick_bucket FROM workflow_schedule_ticks').all())
      .toEqual([{ id: 'tick_1', trigger_id: 'trg_cron', tick_bucket: '2026-07-01T00:00' }]);
  });

  it('accepts a github-app trigger afterwards and still rejects an unknown type', () => {
    applyMigration();

    sqlite.prepare(`
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config)
      VALUES ('trg_app', 'user_1', 'wf_1', 'app', 1, 'github-app', '{"type":"github-app","owner":"tkhq","repo":"valet"}')
    `).run();
    expect(sqlite.prepare('SELECT type FROM triggers WHERE id = ?').get('trg_app')).toEqual({ type: 'github-app' });

    expect(() => sqlite.prepare(`
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config)
      VALUES ('trg_bad', 'user_1', 'wf_1', 'bad', 1, 'carrier-pigeon', '{}')
    `).run()).toThrow(/CHECK constraint failed/);
  });

  it('leaves the rebuilt table with the same indexes and enforced constraints', () => {
    applyMigration();

    const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'triggers' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(indexes).toEqual([
      'idx_triggers_enabled',
      'idx_triggers_type',
      'idx_triggers_user',
      'idx_triggers_user_name',
      'idx_triggers_webhook_path_unique',
      'idx_triggers_webhook_token',
      'idx_triggers_workflow',
    ]);

    // The per-user name uniqueness (COLLATE NOCASE) survived the swap.
    expect(() => sqlite.prepare(`
      INSERT INTO triggers (id, user_id, workflow_id, name, enabled, type, config)
      VALUES ('trg_dup', 'user_1', 'wf_1', 'HOOK', 1, 'manual', '{"type":"manual"}')
    `).run()).toThrow(/UNIQUE constraint failed/);
  });

  it('leaves no scratch tables behind', () => {
    applyMigration();

    const scratch = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_m0029%'").all();
    expect(scratch).toEqual([]);
  });
});
