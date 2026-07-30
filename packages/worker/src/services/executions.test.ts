import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import type { AppDb } from '../lib/drizzle.js';
import { resolveUserExecutionCap } from '../lib/db/executions.js';
import { checkWorkflowConcurrency } from './executions.js';
import {
  PER_USER_EXECUTION_CONCURRENCY_CAP,
  GLOBAL_EXECUTION_CONCURRENCY_CAP,
} from '../lib/db/constants.js';

let db: AppDb;

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb });
  db.insert(users).values({ id: 'u1', email: 'u1@example.com' }).run();
  db.insert(workflows).values({
    id: 'wf1', userId: 'u1', name: 'W', version: '1', data: '{}',
  }).run();
});

function seedActive(userId: string, count: number, offset = 0) {
  for (let i = 0; i < count; i++) {
    db.insert(workflowExecutions).values({
      id: `${userId}-${offset + i}`,
      workflowId: 'wf1',
      userId,
      status: 'running',
      triggerType: 'manual',
      startedAt: 't',
    }).run();
  }
}

describe('resolveUserExecutionCap', () => {
  it('returns the platform default when the override is NULL', async () => {
    expect(await resolveUserExecutionCap(db, 'u1')).toBe(PER_USER_EXECUTION_CONCURRENCY_CAP);
  });

  it('returns the per-user override when set', async () => {
    db.update(users).set({ maxWorkflowExecutions: 75 }).where(eq(users.id, 'u1')).run();
    expect(await resolveUserExecutionCap(db, 'u1')).toBe(75);
  });

  it('treats a non-positive override as unset rather than as a block', async () => {
    // A stray 0 must not wedge the user out of running anything.
    db.update(users).set({ maxWorkflowExecutions: 0 }).where(eq(users.id, 'u1')).run();
    expect(await resolveUserExecutionCap(db, 'u1')).toBe(PER_USER_EXECUTION_CONCURRENCY_CAP);
    db.update(users).set({ maxWorkflowExecutions: -5 }).where(eq(users.id, 'u1')).run();
    expect(await resolveUserExecutionCap(db, 'u1')).toBe(PER_USER_EXECUTION_CONCURRENCY_CAP);
  });

  it('falls back to the default for an unknown user rather than throwing', async () => {
    expect(await resolveUserExecutionCap(db, 'nobody')).toBe(PER_USER_EXECUTION_CONCURRENCY_CAP);
  });
});

describe('checkWorkflowConcurrency', () => {
  it('allows when the user is below the default cap', async () => {
    seedActive('u1', PER_USER_EXECUTION_CONCURRENCY_CAP - 1);
    const result = await checkWorkflowConcurrency(db, 'u1');
    expect(result.allowed).toBe(true);
    expect(result.activeUser).toBe(PER_USER_EXECUTION_CONCURRENCY_CAP - 1);
  });

  it('rejects at the default per-user cap', async () => {
    seedActive('u1', PER_USER_EXECUTION_CONCURRENCY_CAP);
    const result = await checkWorkflowConcurrency(db, 'u1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`per_user_limit_exceeded:${PER_USER_EXECUTION_CONCURRENCY_CAP}`);
  });

  it('applies the per-user override from the users row', async () => {
    db.update(users).set({ maxWorkflowExecutions: PER_USER_EXECUTION_CONCURRENCY_CAP + 10 })
      .where(eq(users.id, 'u1')).run();
    seedActive('u1', PER_USER_EXECUTION_CONCURRENCY_CAP);
    expect((await checkWorkflowConcurrency(db, 'u1')).allowed).toBe(true);
  });

  it('honours an explicit perUser limit over the stored override', async () => {
    // The cron dispatcher resolves the cap once per tick and passes it in; the
    // supplied value must win so the memoized read is authoritative.
    db.update(users).set({ maxWorkflowExecutions: 500 }).where(eq(users.id, 'u1')).run();
    seedActive('u1', 3);
    const result = await checkWorkflowConcurrency(db, 'u1', { perUser: 3 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('per_user_limit_exceeded:3');
  });

  it('rejects on the global cap even when the user is under their own ceiling', async () => {
    db.insert(users).values({ id: 'u2', email: 'u2@example.com' }).run();
    seedActive('u2', GLOBAL_EXECUTION_CONCURRENCY_CAP);
    const result = await checkWorkflowConcurrency(db, 'u1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`global_limit_exceeded:${GLOBAL_EXECUTION_CONCURRENCY_CAP}`);
    expect(result.activeUser).toBe(0);
  });

  it('does not let a per-user override bypass the global cap', async () => {
    db.update(users).set({ maxWorkflowExecutions: 10_000 }).where(eq(users.id, 'u1')).run();
    seedActive('u1', GLOBAL_EXECUTION_CONCURRENCY_CAP);
    const result = await checkWorkflowConcurrency(db, 'u1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`global_limit_exceeded:${GLOBAL_EXECUTION_CONCURRENCY_CAP}`);
  });
});
