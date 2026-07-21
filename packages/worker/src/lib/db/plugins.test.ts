import { describe, it, expect } from 'vitest';
import { upsertPlugin, upsertPluginArtifact } from './plugins.js';
import { createTestDb } from '../../test-utils/db.js';

const basePlugin = {
  id: 'builtin:workflows',
  orgId: 'default',
  name: 'workflows',
  version: '1.0.0',
  description: 'Workflow tools',
  source: 'builtin',
  capabilities: ['a', 'b'],
  actionType: 'tool',
  authRequired: false,
};

function pluginUpdatedAt(sqlite: import('better-sqlite3').Database, name: string): string {
  return (
    sqlite.prepare('SELECT updated_at FROM org_plugins WHERE org_id = ? AND name = ?').get('default', name) as {
      updated_at: string;
    }
  ).updated_at;
}

describe('upsertPlugin — skip when unchanged', () => {
  it('skips the write when the stored plugin already matches', async () => {
    const { db, sqlite } = createTestDb();
    await upsertPlugin(db, basePlugin);
    sqlite
      .prepare("UPDATE org_plugins SET updated_at = '2020-01-01 00:00:00' WHERE org_id = 'default' AND name = 'workflows'")
      .run();

    await upsertPlugin(db, { ...basePlugin });

    // No UPDATE ran, so the sentinel survives.
    expect(pluginUpdatedAt(sqlite, 'workflows')).toBe('2020-01-01 00:00:00');
  });

  it.each([
    { field: 'version', patch: { version: '2.0.0' } },
    { field: 'description', patch: { description: 'a different description' } },
    { field: 'icon', patch: { icon: 'a-new-icon' } },
    { field: 'actionType', patch: { actionType: 'agent' } },
    { field: 'source', patch: { source: 'plugin' } },
    { field: 'capabilities', patch: { capabilities: ['a', 'b', 'c'] } },
    { field: 'authRequired', patch: { authRequired: true } },
  ])('writes when $field changes', async ({ patch }) => {
    const { db, sqlite } = createTestDb();
    await upsertPlugin(db, basePlugin);
    sqlite
      .prepare("UPDATE org_plugins SET updated_at = '2020-01-01 00:00:00' WHERE org_id = 'default' AND name = 'workflows'")
      .run();

    await upsertPlugin(db, { ...basePlugin, ...patch });

    expect(pluginUpdatedAt(sqlite, 'workflows')).not.toBe('2020-01-01 00:00:00');
  });
});

describe('upsertPluginArtifact — skip when unchanged', () => {
  const artifact = {
    id: 'art-1',
    pluginId: 'builtin:workflows',
    type: 'tool',
    filename: 'run.md',
    content: 'body',
    sortOrder: 0,
  };

  it('does not write when content and sortOrder already match', async () => {
    const { db, sqlite } = createTestDb();
    await upsertPlugin(db, basePlugin); // FK parent
    await upsertPluginArtifact(db, artifact);

    const prepared: string[] = [];
    const origPrepare = sqlite.prepare.bind(sqlite);
    (sqlite as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      prepared.push(s);
      return origPrepare(s);
    };

    await upsertPluginArtifact(db, { ...artifact });

    // The unchanged path issues only the existence read — no INSERT/upsert.
    expect(prepared.some((s) => /insert into\s+"?org_plugin_artifacts"?/i.test(s))).toBe(false);
  });

  it('writes when content changes', async () => {
    const { db, sqlite } = createTestDb();
    await upsertPlugin(db, basePlugin); // FK parent
    await upsertPluginArtifact(db, artifact);

    await upsertPluginArtifact(db, { ...artifact, content: 'new body' });

    const row = sqlite
      .prepare('SELECT content FROM org_plugin_artifacts WHERE plugin_id = ? AND type = ? AND filename = ?')
      .get(artifact.pluginId, artifact.type, artifact.filename) as { content: string };
    expect(row.content).toBe('new body');
  });

  it('writes when sortOrder changes', async () => {
    const { db, sqlite } = createTestDb();
    await upsertPlugin(db, basePlugin);
    await upsertPluginArtifact(db, artifact);

    await upsertPluginArtifact(db, { ...artifact, sortOrder: 5 });

    const row = sqlite
      .prepare('SELECT sort_order FROM org_plugin_artifacts WHERE plugin_id = ? AND type = ? AND filename = ?')
      .get(artifact.pluginId, artifact.type, artifact.filename) as { sort_order: number };
    expect(row.sort_order).toBe(5);
  });
});
