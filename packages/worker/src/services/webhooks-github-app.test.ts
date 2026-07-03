import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the dispatch sink so we assert intent without spinning up the interpreter.
const { dispatchMock } = vi.hoisted(() => ({
  // Typed with two params so `.mock.calls[0][1]` (the dispatch input) is a
  // valid tuple index under the CI typecheck.
  dispatchMock: vi.fn(
    async (_env: unknown, _input: unknown) => ({ executionId: 'exec-1', status: 'pending' as const }),
  ),
}));
vi.mock('./workflow-dispatch.js', () => ({ dispatchWorkflowExecution: dispatchMock }));

import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, triggers } from '../lib/schema/workflows.js';
import { decideReview, dispatchGithubAppReviews } from './webhooks.js';
import type { DispatchWorkflowInput } from './workflow-dispatch.js';
import type { Env } from '../env.js';

const REPO = { name: 'valet', owner: { login: 'tkhq' } };

function prEvent(action: string, opts: { number?: number; draft?: boolean } = {}) {
  return { action, repository: REPO, pull_request: { number: opts.number ?? 75, draft: opts.draft ?? false } };
}
function commentEvent(body: string, opts: { action?: string; onPr?: boolean; botAuthor?: boolean } = {}) {
  return {
    action: opts.action ?? 'created',
    repository: REPO,
    issue: { number: 75, ...(opts.onPr === false ? {} : { pull_request: { url: 'x' } }) },
    comment: { body, user: { type: opts.botAuthor ? 'Bot' : 'User' } },
  };
}

describe('decideReview — Greptile-style review policy', () => {
  it('reviews on a non-draft pull_request opened / reopened / ready_for_review', () => {
    for (const action of ['opened', 'reopened', 'ready_for_review']) {
      expect(decideReview('pull_request', prEvent(action))).toMatchObject({
        owner: 'tkhq', repo: 'valet', pullNumber: 75, reason: 'initial',
      });
    }
  });

  it('does NOT review a draft PR', () => {
    expect(decideReview('pull_request', prEvent('opened', { draft: true }))).toBeNull();
  });

  it('does NOT re-review on a push (synchronize)', () => {
    expect(decideReview('pull_request', prEvent('synchronize'))).toBeNull();
  });

  it('re-reviews when a PR comment @-mentions Valet', () => {
    expect(decideReview('issue_comment', commentEvent('hey @Valet please re-review'))).toMatchObject({
      pullNumber: 75, reason: 'mention',
    });
    // Case-insensitive.
    expect(decideReview('issue_comment', commentEvent('@valet take another look'))?.reason).toBe('mention');
  });

  it('ignores comments without an @Valet mention', () => {
    expect(decideReview('issue_comment', commentEvent('looks good to me'))).toBeNull();
  });

  it('ignores @Valet on a plain issue (not a PR)', () => {
    expect(decideReview('issue_comment', commentEvent('@valet', { onPr: false }))).toBeNull();
  });

  it('ignores a bot-authored comment (loop guard)', () => {
    expect(decideReview('issue_comment', commentEvent('@valet', { botAuthor: true }))).toBeNull();
  });

  it('ignores edited/deleted comment actions', () => {
    expect(decideReview('issue_comment', commentEvent('@valet', { action: 'edited' }))).toBeNull();
  });
});

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
      config: JSON.stringify({ type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request', 'issue_comment'] }),
    }).run();
  });

  it('dispatches on the initial review with clean trigger.data and a delivery-scoped key', async () => {
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened', { number: 75 }), 'delivery-abc');

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    expect(arg.workflowId).toBe('wf1');
    expect(arg.user).toEqual({ id: 'u1' });
    // No `action` — the template gate passes via isEmpty; policy already decided.
    expect(arg.trigger.data).toEqual({ owner: 'tkhq', repo: 'valet', pullNumber: 75 });
    expect(arg.trigger.metadata).toMatchObject({ source: 'github-app', deliveryId: 'delivery-abc', reason: 'initial' });
    expect(arg.idempotencyKey).toBe('github-app:trig1:delivery-abc');
  });

  it('does NOT dispatch for a draft PR or a push', async () => {
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened', { draft: true }), 'd-draft');
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('synchronize'), 'd-sync');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dispatches an @Valet re-review from an issue_comment, PR number from issue.number', async () => {
    await dispatchGithubAppReviews(env, 'issue_comment', commentEvent('@valet re-review please'), 'd-mention');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    expect(arg.trigger.data).toEqual({ owner: 'tkhq', repo: 'valet', pullNumber: 75 });
    expect(arg.trigger.metadata).toMatchObject({ reason: 'mention' });
  });

  it('does NOT dispatch for a different repo', async () => {
    const other = { action: 'opened', repository: { name: 'repo', owner: { login: 'other' } }, pull_request: { number: 1, draft: false } };
    await dispatchGithubAppReviews(env, 'pull_request', other, 'd2');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch a disabled trigger', async () => {
    db.update(triggers).set({ enabled: false }).run();
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd4');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
