import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the dispatch sink so we assert intent without spinning up the interpreter.
const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(async () => ({ executionId: 'exec-1', status: 'pending' as const })),
}));
vi.mock('./workflow-dispatch.js', () => ({ dispatchWorkflowExecution: dispatchMock }));

import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, triggers } from '../lib/schema/workflows.js';
import { dispatchGithubAppReviews } from './webhooks.js';
import type { Env } from '../env.js';

const MAPPING = JSON.stringify({
  action: '$.action',
  owner: '$.repository.owner.login',
  repo: '$.repository.name',
  pullNumber: '$.pull_request.number',
});

function prPayload(action: string, owner: string, repo: string, number: number) {
  return { action, repository: { name: repo, owner: { login: owner } }, pull_request: { number } };
}

// Minimal D1 shim over better-sqlite3 — findGithubAppTriggersForRepo uses the
// D1 prepare().bind().all() shape (returns { results }).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asD1(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return { all: async () => ({ results: sqlite.prepare(sql).all(...args) }) };
        },
      };
    },
  };
}

describe('dispatchGithubAppReviews', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let env: Env;

  beforeEach(() => {
    dispatchMock.mockClear();
    const t = createTestDb();
    db = t.db;
    env = { DB: asD1(t.sqlite) } as unknown as Env;
    db.insert(users).values({ id: 'u1', email: 'u@e.io' }).run();
    db.insert(workflows).values({ id: 'wf1', userId: 'u1', name: 'review', version: '0', data: '{}' }).run();
    db.insert(triggers).values({
      id: 'trig1', userId: 'u1', workflowId: 'wf1', name: 'GitHub App: tkhq/valet',
      enabled: true, type: 'github-app',
      config: JSON.stringify({ type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request'] }),
      variableMapping: MAPPING,
    }).run();
  });

  it('dispatches the matching workflow with mapped trigger.data and a delivery-scoped idempotency key', async () => {
    await dispatchGithubAppReviews(env, 'pull_request', prPayload('opened', 'tkhq', 'valet', 75), 'delivery-abc');

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1];
    expect(arg.workflowId).toBe('wf1');
    expect(arg.user).toEqual({ id: 'u1' });
    expect(arg.trigger.data).toEqual({ action: 'opened', owner: 'tkhq', repo: 'valet', pullNumber: 75 });
    expect(arg.trigger.metadata).toMatchObject({ source: 'github-app', deliveryId: 'delivery-abc' });
    expect(arg.idempotencyKey).toBe('github-app:trig1:delivery-abc');
  });

  it('does NOT dispatch for a different repo', async () => {
    await dispatchGithubAppReviews(env, 'pull_request', prPayload('opened', 'other', 'repo', 1), 'd2');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch for an event the trigger is not subscribed to', async () => {
    await dispatchGithubAppReviews(env, 'push', prPayload('opened', 'tkhq', 'valet', 1), 'd3');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch a disabled trigger', async () => {
    db.update(triggers).set({ enabled: false }).run();
    await dispatchGithubAppReviews(env, 'pull_request', prPayload('opened', 'tkhq', 'valet', 1), 'd4');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
