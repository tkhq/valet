import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';

let db: AppDb;

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...original,
    getDb: (binding: Env['DB']) => (binding ? db : original.getDb(binding)),
  };
});

const { finalizeAbandonedExecution } = await import('./execution-status.js');

const env = { DB: {} as Env['DB'] } as Env;

function seed(status: string, id = 'exec-1'): void {
  db.insert(workflowExecutions).values({
    id,
    workflowId: 'wf-1',
    userId: 'user-1',
    status,
    triggerType: 'manual',
    startedAt: new Date().toISOString(),
  }).run();
}

function read(id = 'exec-1') {
  return db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).get();
}

beforeEach(() => {
  db = createTestDb().db as unknown as AppDb;
  db.insert(users).values([{ id: 'user-1', email: 'user@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf-1', userId: 'user-1', name: 'W', version: '1', data: '{}' }]).run();
});

describe('finalizeAbandonedExecution', () => {
  // The whole point of this helper: a row in ANY status that consumes a
  // concurrency slot must be reclaimable. The runtime's own terminal write
  // only transitions from 'running', which is what let rows stranded in
  // waiting_* hold a slot forever.
  it.each(['pending', 'running', 'waiting_approval', 'waiting_time'])(
    'finalizes a row stuck in %s',
    async (status) => {
      seed(status);
      const landed = await finalizeAbandonedExecution(env, 'exec-1', { status: 'failed', error: 'instance died' });
      expect(landed).toBe(true);
      const row = read();
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe('instance died');
      expect(row?.completedAt).toBeTruthy();
    },
  );

  // A user who just cancelled must not have their intent overwritten by a
  // late reaper, and the cancel pipeline owns finishing those rows.
  it.each(['cancelling', 'cancelled'])('leaves %s alone', async (status) => {
    seed(status);
    const landed = await finalizeAbandonedExecution(env, 'exec-1', { status: 'failed', error: 'instance died' });
    expect(landed).toBe(false);
    expect(read()?.status).toBe(status);
  });

  // Idempotency: a row that already reached a terminal state keeps its
  // original outcome and error rather than being rewritten as failed.
  it.each(['completed', 'failed'])('does not rewrite an already-terminal %s row', async (status) => {
    seed(status);
    const landed = await finalizeAbandonedExecution(env, 'exec-1', { status: 'failed', error: 'instance died' });
    expect(landed).toBe(false);
    expect(read()?.status).toBe(status);
    expect(read()?.error).toBeNull();
  });

  it('does not touch other executions', async () => {
    seed('running', 'exec-1');
    seed('running', 'exec-2');
    await finalizeAbandonedExecution(env, 'exec-1', { status: 'failed', error: 'instance died' });
    expect(read('exec-2')?.status).toBe('running');
  });

  it('reports false for an execution that does not exist', async () => {
    expect(await finalizeAbandonedExecution(env, 'nope', { status: 'failed', error: 'instance died' })).toBe(false);
  });
});
