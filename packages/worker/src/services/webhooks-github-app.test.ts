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

// The App's slug (for @-mention matching) is read from the encrypted service
// config via drizzle — not exercisable over the minimal D1 test shim, so stub it.
const { getServiceConfigMock } = vi.hoisted(() => ({ getServiceConfigMock: vi.fn() }));
vi.mock('../lib/db/service-configs.js', () => ({ getServiceConfig: getServiceConfigMock }));

// The org code-review policy (GitHubServiceMetadata) and the per-owner prefs
// (getUserById) are drizzle reads the minimal shim can't serve — stub both, the
// same way getServiceConfig is stubbed. Real findGithubAppTriggersForRepo is kept.
const { getGitHubMetadataMock, getUserByIdMock } = vi.hoisted(() => ({
  getGitHubMetadataMock: vi.fn(),
  getUserByIdMock: vi.fn(),
}));
vi.mock('./github-config.js', async (orig) => ({
  ...(await orig<typeof import('./github-config.js')>()),
  getGitHubMetadata: getGitHubMetadataMock,
}));
vi.mock('../lib/db.js', async (orig) => ({
  ...(await orig<typeof import('../lib/db.js')>()),
  getUserById: getUserByIdMock,
}));

import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, triggers } from '../lib/schema/workflows.js';
import { decideReview, dispatchGithubAppReviews, resolveCodeReviewGate } from './webhooks.js';
import type { DispatchWorkflowInput } from './workflow-dispatch.js';
import type { Env } from '../env.js';

const REPO = { name: 'valet', owner: { login: 'tkhq' } };

/**
 * A pull_request event. Defaults to the trusted shape a real same-repo branch
 * produces; `fork` and `association` model the outside contributor.
 */
function prEvent(
  action: string,
  opts: { number?: number; draft?: boolean; fork?: boolean; association?: string } = {},
) {
  return {
    action,
    repository: REPO,
    pull_request: {
      number: opts.number ?? 75,
      draft: opts.draft ?? false,
      head: { repo: { full_name: opts.fork ? 'stranger/valet' : 'tkhq/valet' } },
      author_association: opts.association ?? 'MEMBER',
    },
  };
}
function commentEvent(
  body: string,
  opts: { action?: string; onPr?: boolean; botAuthor?: boolean; association?: string } = {},
) {
  return {
    action: opts.action ?? 'created',
    repository: REPO,
    issue: { number: 75, ...(opts.onPr === false ? {} : { pull_request: { url: 'x' } }) },
    comment: {
      body,
      user: { type: opts.botAuthor ? 'Bot' : 'User' },
      author_association: opts.association ?? 'MEMBER',
    },
  };
}

const SLUG = 'valet-turnkey'; // the App's slug → bot handle @valet-turnkey / @valet-turnkey[bot]

describe('decideReview — Greptile-style review policy', () => {
  it('reviews on a non-draft pull_request opened / reopened / ready_for_review', () => {
    for (const action of ['opened', 'reopened', 'ready_for_review']) {
      expect(decideReview('pull_request', prEvent(action), SLUG)).toMatchObject({
        owner: 'tkhq', repo: 'valet', pullNumber: 75, reason: 'initial',
      });
    }
  });

  it('does NOT review a draft PR', () => {
    expect(decideReview('pull_request', prEvent('opened', { draft: true }), SLUG)).toBeNull();
  });

  it('does NOT re-review on a push (synchronize)', () => {
    expect(decideReview('pull_request', prEvent('synchronize'), SLUG)).toBeNull();
  });

  it('re-reviews when a comment @-mentions the App bot handle (slug or [bot] login)', () => {
    expect(decideReview('issue_comment', commentEvent('hey @valet-turnkey please re-review'), SLUG)).toMatchObject({
      pullNumber: 75, reason: 'mention',
    });
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey[bot] take another look'), SLUG)?.reason).toBe('mention');
    // Case-insensitive.
    expect(decideReview('issue_comment', commentEvent('@Valet-Turnkey re-review'), SLUG)?.reason).toBe('mention');
  });

  it('does NOT match the generic @valet (a real, unrelated GitHub user)', () => {
    expect(decideReview('issue_comment', commentEvent('hey @valet re-review'), SLUG)).toBeNull();
    // ...nor a longer handle that merely starts with the slug.
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey-staging look'), SLUG)).toBeNull();
  });

  it('never matches a mention when no bot slug is configured', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey re-review'), null)).toBeNull();
  });

  it('ignores comments without a bot mention', () => {
    expect(decideReview('issue_comment', commentEvent('looks good to me'), SLUG)).toBeNull();
  });

  it('ignores a mention on a plain issue (not a PR)', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey', { onPr: false }), SLUG)).toBeNull();
  });

  it('ignores a bot-authored comment (loop guard)', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey', { botAuthor: true }), SLUG)).toBeNull();
  });

  it('ignores edited/deleted comment actions', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey', { action: 'edited' }), SLUG)).toBeNull();
  });

  // ── author trust ────────────────────────────────────────────────────────

  it('reviews a fork PR when its author belongs to the repo', () => {
    expect(decideReview('pull_request', prEvent('opened', { fork: true, association: 'COLLABORATOR' }), SLUG))
      .toMatchObject({ pullNumber: 75, reason: 'initial' });
  });

  it('does NOT review a fork PR from an unaffiliated author', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'MANNEQUIN']) {
      expect(decideReview('pull_request', prEvent('opened', { fork: true, association }), SLUG)).toBeNull();
    }
  });

  it('reviews a same-repo branch regardless of the author association', () => {
    expect(decideReview('pull_request', prEvent('opened', { association: 'NONE' }), SLUG))
      .toMatchObject({ reason: 'initial' });
  });

  it('does NOT re-review on an @mention from someone outside the repo', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey re-review', { association: 'NONE' }), SLUG)).toBeNull();
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey re-review', { association: 'CONTRIBUTOR' }), SLUG)).toBeNull();
  });

  it('re-reviews on an @mention from an owner', () => {
    expect(decideReview('issue_comment', commentEvent('@valet-turnkey re-review', { association: 'OWNER' }), SLUG)?.reason)
      .toBe('mention');
  });
});

// Minimal D1 shim over better-sqlite3. findGithubAppTriggersForRepo uses
// prepare().bind().all() (returns { results }); the per-trigger rate limiter
// uses .run() and .first().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asD1(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = sqlite.prepare(sql);
          return {
            all: async () => ({ results: stmt.all(...args) }),
            run: async () => stmt.run(...args),
            first: async () => stmt.get(...args) ?? null,
          };
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
    getGitHubMetadataMock.mockReset();
    getUserByIdMock.mockReset();
    // Default: org code review enabled+overridable, owner allows full review.
    getGitHubMetadataMock.mockResolvedValue({});
    getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: true, codeReviewMentionOnly: false });
    // App config resolves the bot slug for @-mention matching.
    getServiceConfigMock.mockResolvedValue({ config: { appSlug: 'valet-turnkey' }, metadata: {}, configuredBy: null, updatedAt: '' });
    const t = createTestDb();
    db = t.db;
    env = { DB: asD1(t.sqlite), ENCRYPTION_KEY: 'test-encryption-key' } as unknown as Env;
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

  it('dispatches an @<bot> re-review from an issue_comment, PR number from issue.number', async () => {
    await dispatchGithubAppReviews(env, 'issue_comment', commentEvent('@valet-turnkey re-review please'), 'd-mention');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    expect(arg.trigger.data).toEqual({ owner: 'tkhq', repo: 'valet', pullNumber: 75 });
    expect(arg.trigger.metadata).toMatchObject({ reason: 'mention' });
  });

  it('does NOT dispatch on a generic @valet mention (unrelated GitHub user)', async () => {
    await dispatchGithubAppReviews(env, 'issue_comment', commentEvent('@valet re-review please'), 'd-generic');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch for a different repo', async () => {
    const other = { action: 'opened', repository: { name: 'repo', owner: { login: 'other' } }, pull_request: { number: 1, draft: false } };
    await dispatchGithubAppReviews(env, 'pull_request', other, 'd2');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch for an unaffiliated fork PR', async () => {
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened', { fork: true, association: 'NONE' }), 'd-fork');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('stops dispatching once the per-trigger rate limit is exhausted', async () => {
    db.update(triggers).set({
      config: JSON.stringify({ type: 'github-app', owner: 'tkhq', repo: 'valet', events: ['pull_request'], rateLimit: 2 }),
    }).run();

    for (let i = 0; i < 4; i++) {
      await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened', { number: 100 + i }), `d-rate-${i}`);
    }
    // An App delivery costs an LLM run, so it answers to the same ceiling the
    // manual webhook path enforces.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT dispatch a disabled trigger', async () => {
    db.update(triggers).set({ enabled: false }).run();
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd4');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // ── org + owner settings gates ──────────────────────────────────────────

  it('org master switch OFF short-circuits before any trigger read', async () => {
    getGitHubMetadataMock.mockResolvedValue({ codeReviewEnabled: false });
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd-orgoff');
    expect(dispatchMock).not.toHaveBeenCalled();
    // Absolute OFF: we never even look up the owner's prefs.
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });

  it('owner opt-out (org overridable) suppresses review on their repos', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: false, codeReviewMentionOnly: false });
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd-optout');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('org ENFORCED ignores the owner opt-out (and skips the owner read)', async () => {
    getGitHubMetadataMock.mockResolvedValue({ codeReviewEnabled: true, codeReviewEnforced: true });
    getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: false, codeReviewMentionOnly: false });
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd-enforced');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });

  it('owner mention-only skips the initial review but still honors an @mention', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: true, codeReviewMentionOnly: true });
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd-initial');
    expect(dispatchMock).not.toHaveBeenCalled();
    await dispatchGithubAppReviews(env, 'issue_comment', commentEvent('@valet-turnkey re-review'), 'd-ment');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    expect(arg.trigger.metadata).toMatchObject({ reason: 'mention' });
  });

  it('org-wide mention-only skips the initial review for everyone', async () => {
    getGitHubMetadataMock.mockResolvedValue({ codeReviewEnabled: true, codeReviewMentionOnly: true });
    await dispatchGithubAppReviews(env, 'pull_request', prEvent('opened'), 'd-orgquiet');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('resolveCodeReviewGate — org-ceiling + user-may-only-loosen', () => {
  const OFF = { enabled: false, enforced: false, mentionOnly: false };
  const ON = { enabled: true, enforced: false, mentionOnly: false };
  const ON_ENFORCED = { enabled: true, enforced: true, mentionOnly: false };
  const ON_QUIET = { enabled: true, enforced: false, mentionOnly: true };
  const ON_QUIET_ENFORCED = { enabled: true, enforced: true, mentionOnly: true };

  const ownerOn = { enabled: true, mentionOnly: false };
  const ownerQuiet = { enabled: true, mentionOnly: true };
  const ownerOff = { enabled: false, mentionOnly: false };

  it('org OFF is absolute — no owner value turns it on', () => {
    for (const owner of [null, ownerOn, ownerQuiet, ownerOff]) {
      expect(resolveCodeReviewGate(OFF, owner, 'initial')).toBe(false);
      expect(resolveCodeReviewGate(OFF, owner, 'mention')).toBe(false);
    }
  });

  it('org ON overridable: owner may loosen (opt out / go quiet), never past org', () => {
    expect(resolveCodeReviewGate(ON, null, 'initial')).toBe(true);       // default full review
    expect(resolveCodeReviewGate(ON, ownerOn, 'initial')).toBe(true);
    expect(resolveCodeReviewGate(ON, ownerOff, 'initial')).toBe(false);  // owner opted out
    expect(resolveCodeReviewGate(ON, ownerQuiet, 'initial')).toBe(false); // owner quiet → skip initial
    expect(resolveCodeReviewGate(ON, ownerQuiet, 'mention')).toBe(true);  // ...but honor @mention
  });

  it('org ENFORCED ignores every owner knob', () => {
    for (const owner of [ownerOn, ownerQuiet, ownerOff]) {
      expect(resolveCodeReviewGate(ON_ENFORCED, owner, 'initial')).toBe(true);
      expect(resolveCodeReviewGate(ON_ENFORCED, owner, 'mention')).toBe(true);
    }
  });

  it('org quiet (overridable): owner cannot loosen back to a full initial review', () => {
    expect(resolveCodeReviewGate(ON_QUIET, ownerOn, 'initial')).toBe(false); // user false can't override org quiet
    expect(resolveCodeReviewGate(ON_QUIET, ownerOn, 'mention')).toBe(true);
    expect(resolveCodeReviewGate(ON_QUIET, ownerOff, 'initial')).toBe(false); // owner opt-out still wins downward
    expect(resolveCodeReviewGate(ON_QUIET, ownerOff, 'mention')).toBe(false);
  });

  it('org quiet + enforced: org value is final, mention only', () => {
    expect(resolveCodeReviewGate(ON_QUIET_ENFORCED, ownerOn, 'initial')).toBe(false);
    expect(resolveCodeReviewGate(ON_QUIET_ENFORCED, ownerOn, 'mention')).toBe(true);
  });
});
