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

const { sweepStaleExecutions } = await import('./stale-execution-sweep.js');

const HOUR = 3_600_000;

/**
 * Env whose Workflows binding reports `statuses[id]`. An id that is absent
 * gets a genuine Cloudflare-shaped not-found error (code 1001), which is
 * the only error the sweep is allowed to act on.
 */
function makeEnv(statuses: Record<string, string | undefined>): Env {
  return {
    DB: {} as Env['DB'],
    WORKFLOW_INTERPRETER: {
      async get(id: string) {
        if (!(id in statuses)) throw Object.assign(new Error('instance not found'), { code: 1001 });
        return { async status() { return { status: statuses[id] }; } };
      },
    },
  } as unknown as Env;
}

/** Env whose binding fails the way a degraded platform does, not a missing instance. */
function makeFlakyEnv(error: Error): Env {
  return {
    DB: {} as Env['DB'],
    WORKFLOW_INTERPRETER: { async get() { throw error; } },
  } as unknown as Env;
}

function seed(id: string, status: string, ageMs = 2 * HOUR): void {
  db.insert(workflowExecutions).values({
    id,
    workflowId: 'wf-1',
    userId: 'user-1',
    status,
    triggerType: 'manual',
    startedAt: new Date(Date.now() - ageMs).toISOString(),
  }).run();
}

function statusOf(id: string): string | undefined {
  return db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).get()?.status;
}

beforeEach(() => {
  db = createTestDb().db as unknown as AppDb;
  db.insert(users).values([{ id: 'user-1', email: 'user@example.com' }]).run();
  db.insert(workflows).values([{ id: 'wf-1', userId: 'user-1', name: 'W', version: '1', data: '{}' }]).run();
});

describe('sweepStaleExecutions', () => {
  // The instance is authoritative, and the row must record what actually
  // happened — not a blanket failure.
  it.each([
    ['errored', 'failed'],
    ['terminated', 'cancelled'],
    ['complete', 'completed'],
  ])('reclaims a row whose instance is %s as %s', async (instanceStatus, rowStatus) => {
    seed('exec-1', 'running');
    const result = await sweepStaleExecutions(makeEnv({ 'exec-1': instanceStatus }));
    expect(result.reclaimed).toBe(1);
    expect(statusOf('exec-1')).toBe(rowStatus);
  });

  // An instance that ran to completion did succeed. Recording it as failed
  // would tear down its sessions with reason workflow_failed and invite a
  // re-run of a non-idempotent workflow that already did its work.
  it('does not attach a failure reason to a completed run', async () => {
    seed('exec-1', 'waiting_approval');
    await sweepStaleExecutions(makeEnv({ 'exec-1': 'complete' }));
    const row = db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'exec-1')).get();
    expect(row?.status).toBe('completed');
    expect(row?.error).toBeNull();
  });

  it('reclaims a row whose instance no longer exists', async () => {
    seed('exec-1', 'running');
    const result = await sweepStaleExecutions(makeEnv({}));
    expect(result.reclaimed).toBe(1);
    expect(statusOf('exec-1')).toBe('failed');
  });

  // The declared InstanceStatus.error is {name, message}, but it crosses a
  // platform boundary — a lost diagnostic is the failure mode this sweep
  // exists to stop repeating.
  it.each([
    [{ name: 'Error', message: 'step exhausted retries' }, 'step exhausted retries'],
    ['a bare string failure', 'a bare string failure'],
    [{ unexpected: 'shape' }, undefined],
    [null, undefined],
  ])('carries the instance error detail through for %s', async (instanceError, expected) => {
    seed('exec-1', 'running');
    const env = {
      DB: {} as Env['DB'],
      WORKFLOW_INTERPRETER: {
        async get() {
          return { async status() { return { status: 'errored', error: instanceError }; } };
        },
      },
    } as unknown as Env;
    await sweepStaleExecutions(env);
    const row = db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'exec-1')).get();
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('errored');
    if (expected) expect(row?.error).toContain(expected);
  });

  it('records why the row was reclaimed', async () => {
    seed('exec-1', 'running');
    await sweepStaleExecutions(makeEnv({ 'exec-1': 'errored' }));
    const row = db.select().from(workflowExecutions).where(eq(workflowExecutions.id, 'exec-1')).get();
    expect(row?.error).toContain('errored');
    expect(row?.completedAt).toBeTruthy();
  });

  // A live run must survive the sweep no matter how old it is. This is the
  // property that makes an age-based scan safe: age only bounds the query,
  // the instance decides.
  it.each(['running', 'waiting', 'queued', 'paused', 'unknown'])(
    'leaves a row whose instance is %s',
    async (instanceStatus) => {
      seed('exec-1', 'running', 100 * HOUR);
      const result = await sweepStaleExecutions(makeEnv({ 'exec-1': instanceStatus }));
      expect(result.reclaimed).toBe(0);
      expect(statusOf('exec-1')).toBe('running');
    },
  );

  it('reclaims rows parked in waiting_approval and waiting_time', async () => {
    seed('exec-a', 'waiting_approval');
    seed('exec-b', 'waiting_time');
    const result = await sweepStaleExecutions(makeEnv({ 'exec-a': 'errored', 'exec-b': 'terminated' }));
    expect(result.reclaimed).toBe(2);
    expect(statusOf('exec-a')).toBe('failed');
    expect(statusOf('exec-b')).toBe('cancelled');
  });

  // The insert-then-create window in createExecution: the row exists before
  // the instance does. Sweeping it would kill a healthy run at birth.
  it('ignores rows younger than the staleness cutoff', async () => {
    seed('exec-young', 'pending', 30_000);
    const result = await sweepStaleExecutions(makeEnv({}));
    expect(result.reclaimed).toBe(0);
    expect(statusOf('exec-young')).toBe('pending');
  });

  it.each(['cancelling', 'cancelled', 'completed', 'failed'])(
    'ignores rows already in %s',
    async (rowStatus) => {
      seed('exec-1', rowStatus);
      const result = await sweepStaleExecutions(makeEnv({}));
      expect(result.reclaimed).toBe(0);
      expect(statusOf('exec-1')).toBe(rowStatus);
    },
  );

  // ── Failing closed on an indeterminate instance state ──────────────────
  // The sweep's verdict authorises an unrecoverable write: once the row
  // reads terminal, a still-live instance's own terminal write no-ops
  // against the CAS, its sandboxes get torn down, and cancel refuses the
  // row. So anything short of proof that the instance is dead must leave
  // the row alone. The alternative — reading every error as "gone" — turns
  // one degraded minute into every in-flight run on the platform.

  it.each([
    new Error('Network connection lost'),
    new Error('Too many requests'),
    Object.assign(new Error('internal error'), { code: 10000 }),
    new Error(''),
    // Message text is not evidence. "not found" shows up in generic fetch
    // failures and D1 errors about a missing row; treating it as proof the
    // instance is gone would hand a live run to the destructive path.
    new Error('resource not found'),
    new Error('socket does not exist'),
    new Error('404: not found'),
  ])('leaves the row alone when the probe fails with %s', async (err) => {
    seed('exec-1', 'running');
    const result = await sweepStaleExecutions(makeFlakyEnv(err));
    expect(result.reclaimed).toBe(0);
    expect(statusOf('exec-1')).toBe('running');
  });

  it('reclaims nothing at all when the Workflows binding is degraded', async () => {
    for (let i = 0; i < 5; i++) seed(`exec-${i}`, 'running');
    const result = await sweepStaleExecutions(makeFlakyEnv(new Error('service unavailable')));
    expect(result.examined).toBe(5);
    expect(result.reclaimed).toBe(0);
    for (let i = 0; i < 5; i++) expect(statusOf(`exec-${i}`)).toBe('running');
  });

  it('leaves the row alone when status() throws', async () => {
    seed('exec-1', 'running');
    const env = {
      DB: {} as Env['DB'],
      WORKFLOW_INTERPRETER: {
        async get() {
          return { async status() { throw new Error('status unavailable'); } };
        },
      },
    } as unknown as Env;
    const result = await sweepStaleExecutions(env);
    expect(result.reclaimed).toBe(0);
    expect(statusOf('exec-1')).toBe('running');
  });

  it('keeps sweeping the remaining rows after one probe fails', async () => {
    seed('exec-bad', 'running');
    seed('exec-good', 'running');
    const env = {
      DB: {} as Env['DB'],
      WORKFLOW_INTERPRETER: {
        async get(id: string) {
          if (id === 'exec-bad') throw new Error('transient boom');
          return { async status() { return { status: 'errored' }; } };
        },
      },
    } as unknown as Env;
    const result = await sweepStaleExecutions(env);
    expect(result.examined).toBe(2);
    expect(result.reclaimed).toBe(1);
    expect(statusOf('exec-bad')).toBe('running');
    expect(statusOf('exec-good')).toBe('failed');
  });

  it('respects the row limit', async () => {
    for (let i = 0; i < 5; i++) seed(`exec-${i}`, 'running');
    const result = await sweepStaleExecutions(makeEnv({}), { limit: 2 });
    expect(result.reclaimed).toBe(2);
  });

  // A backlog bigger than one tick's limit must drain oldest-first rather
  // than re-examining an arbitrary slice, or later rows never get reached.
  it('takes the oldest rows first when the backlog exceeds the limit', async () => {
    seed('exec-newest', 'running', 2 * HOUR);
    seed('exec-oldest', 'running', 90 * HOUR);
    seed('exec-middle', 'running', 40 * HOUR);
    const result = await sweepStaleExecutions(makeEnv({}), { limit: 2 });
    expect(result.reclaimed).toBe(2);
    expect(statusOf('exec-oldest')).toBe('failed');
    expect(statusOf('exec-middle')).toBe('failed');
    expect(statusOf('exec-newest')).toBe('running');
  });

  it('does nothing when there are no stale rows', async () => {
    const result = await sweepStaleExecutions(makeEnv({}));
    expect(result.reclaimed).toBe(0);
  });
});
