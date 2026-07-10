import { describe, expect, it, vi } from 'vitest';
import { canonicalizeRawQuery, handleGenericWebhook, handlePullRequestWebhook } from './webhooks.js';
import type { Env } from '../env.js';
import { createTestDb } from '../test-utils/db.js';
import { makeD1Adapter } from '../test-utils/d1.js';
import { users } from '../lib/schema/users.js';
import { sessions, sessionGitState } from '../lib/schema/sessions.js';

describe('canonicalizeRawQuery — webhook idempotency hash input', () => {
  // GET webhooks without a delivery header use this canonicalization to
  // distinguish otherwise-equivalent requests. Each property below
  // corresponds to a class of false-positive idempotency collision the
  // hash must not produce.

  it('orders pairs lexicographically (?b=2&a=1 ≡ ?a=1&b=2)', () => {
    expect(canonicalizeRawQuery('a=1&b=2')).toBe('a=1&b=2');
    expect(canonicalizeRawQuery('b=2&a=1')).toBe('a=1&b=2');
  });

  it('preserves duplicate keys — ?tag=a&tag=b is NOT the same as ?tag=b', () => {
    const both = canonicalizeRawQuery('tag=a&tag=b');
    const oneB = canonicalizeRawQuery('tag=b');
    expect(both).not.toBe(oneB);
    expect(both).toBe('tag=a&tag=b');
    expect(oneB).toBe('tag=b');
  });

  it('keeps url-encoded values distinct from their decoded form', () => {
    // ?a=1%26b%3D2 carries one value "1&b=2"; ?a=1&b=2 carries two
    // pairs. A Record-based canonicalization would conflate them.
    const encoded = canonicalizeRawQuery('a=1%26b%3D2');
    const decoded = canonicalizeRawQuery('a=1&b=2');
    expect(encoded).not.toBe(decoded);
    expect(encoded).toBe('a=1%26b%3D2');
    expect(decoded).toBe('a=1&b=2');
  });

  it('returns empty string for empty input (no GET ?... segment)', () => {
    expect(canonicalizeRawQuery('')).toBe('');
  });

  it('strips empty pairs from accidental && / leading-& artifacts', () => {
    expect(canonicalizeRawQuery('&a=1&&b=2&')).toBe('a=1&b=2');
  });
});

describe('handleGenericWebhook — tokenized triggers refuse the path-based route', () => {
  // The token model (X-Valet-Trigger-Token against /api/triggers/:id/webhook)
  // is the only supported entry once a trigger has a token minted. If the
  // path-based /webhooks/:path route accepted requests for those triggers,
  // an operator who configured "token-protected webhook" with no legacy
  // config.secret would still serve unauthenticated callers — that's an
  // auth bypass and contradicts migration 0020's stated security model.

  function makeMockEnv(triggerRow: Record<string, unknown> | null): Env {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: vi.fn().mockResolvedValue(triggerRow),
        }),
      }),
    } as unknown as Env['DB'];
    return { DB: db } as unknown as Env;
  }

  it('returns 404 (not 200) when the trigger has webhook_token set, regardless of body or method', async () => {
    const env = makeMockEnv({
      id: 'tr-1',
      workflow_id: 'wf-1',
      workflow_name: 'hooks',
      user_id: 'user-1',
      version: '1',
      data: '{}',
      // Token-protected trigger with NO legacy secret — historically
      // the path-based handler would have dispatched without auth.
      config: JSON.stringify({ type: 'webhook', path: 'incoming/test', method: 'POST' }),
      webhook_token: 'present-but-not-asked-for',
      variable_mapping: null,
    });

    const result = await handleGenericWebhook(
      env,
      'incoming/test',
      'POST',
      JSON.stringify({ event: 'tampered' }),
      { 'content-type': 'application/json' },
      {},
      '',
    );

    expect(result?.statusCode).toBe(404);
  });

  it('returns 401 (not 200) when a non-tokenized trigger has a config.secret but the header is missing', async () => {
    // Sanity-check the legacy-path auth still applies for rows without a
    // webhook_token but with a config.secret set. The tokenized-refuse
    // branch must NOT pre-empt the secret check.
    const env = makeMockEnv({
      id: 'tr-legacy',
      workflow_id: 'wf-legacy',
      workflow_name: 'hooks',
      user_id: 'user-1',
      version: '1',
      data: '{}',
      config: JSON.stringify({
        type: 'webhook',
        path: 'legacy/test',
        method: 'POST',
        secret: 's3cret',
      }),
      webhook_token: null,
      variable_mapping: null,
    });

    const result = await handleGenericWebhook(
      env,
      'legacy/test',
      'POST',
      '{}',
      { 'content-type': 'application/json' },
      {},
      '',
    );

    expect(result?.statusCode).toBe(401);
  });

  it('returns 404 for a missing path (no trigger row at all)', async () => {
    const env = makeMockEnv(null);
    const result = await handleGenericWebhook(
      env,
      'does/not/exist',
      'POST',
      '{}',
      {},
      {},
      '',
    );
    expect(result?.statusCode).toBe(404);
  });
});

describe('handlePullRequestWebhook — session.outcome { pr_merged } out-of-band write', () => {
  // A GitHub merge is the ultimate indicator that an authoring session shipped
  // value. The handler records it as a session.outcome{pr_merged} written
  // straight to analytics_events (the session may be gone), and must never do
  // so for source_pr matches, nor for non-merge actions.

  const REPO = 'octo/valet';
  const PR = 42;

  function makeEnv() {
    const { db: appDb, sqlite } = createTestDb();
    // env.SESSIONS is only used for the best-effort DO notification; a stub
    // that resolves is enough to keep handlePullRequestWebhook happy.
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(null)) };
    const env = {
      DB: makeD1Adapter(sqlite),
      SESSIONS: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue(stub),
      },
    } as unknown as Env;
    return { env, appDb, sqlite, stub };
  }

  async function seedSession(
    appDb: ReturnType<typeof createTestDb>['db'],
    opts: { sessionId: string; git: Record<string, unknown> },
  ) {
    appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).onConflictDoNothing().run();
    appDb.insert(sessions).values({
      id: opts.sessionId,
      userId: 'user-1',
      workspace: '/tmp/pr-webhook',
      status: 'terminated',
    }).run();
    appDb.insert(sessionGitState).values({
      id: `sgs-${opts.sessionId}`,
      sessionId: opts.sessionId,
      sourceRepoFullName: REPO,
      ...opts.git,
    }).run();
  }

  function mergedPayload() {
    return {
      action: 'closed',
      pull_request: {
        number: PR,
        title: 'Ship it',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        merged: true,
        merged_at: '2026-07-09T10:00:00Z',
        head: { ref: 'feature/x' },
        state: 'closed',
      },
      repository: { full_name: REPO },
    };
  }

  function outcomeRows(sqlite: ReturnType<typeof createTestDb>['sqlite']) {
    return sqlite
      .prepare("SELECT id, session_id, user_id, properties FROM analytics_events WHERE event_type = 'session.outcome'")
      .all() as Array<{ id: string; session_id: string; user_id: string | null; properties: string | null }>;
  }

  it('inserts exactly one session.outcome{pr_merged} for a merged PR authored by the session', async () => {
    const { env, appDb, sqlite } = makeEnv();
    await seedSession(appDb, { sessionId: 'sess-author', git: { prNumber: PR } });

    await handlePullRequestWebhook(env, mergedPayload());

    const rows = outcomeRows(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-author');
    expect(rows[0].user_id).toBe('user-1');
    expect(JSON.parse(rows[0].properties ?? '{}')).toEqual({ reason: 'pr_merged', repo: REPO, prNumber: PR });
  });

  it('is idempotent across GitHub redeliveries (deterministic id, INSERT OR IGNORE)', async () => {
    const { env, appDb, sqlite } = makeEnv();
    await seedSession(appDb, { sessionId: 'sess-author', git: { prNumber: PR } });

    await handlePullRequestWebhook(env, mergedPayload());
    await handlePullRequestWebhook(env, mergedPayload());

    expect(outcomeRows(sqlite)).toHaveLength(1);
  });

  it('does NOT write pr_merged for a session merely spawned FROM the PR (source_pr match)', async () => {
    const { env, appDb, sqlite } = makeEnv();
    // Matches via source_pr_number (spawned from), NOT pr_number (authored),
    // and a different head branch so no branch-based authorship link is made.
    await seedSession(appDb, {
      sessionId: 'sess-source',
      git: { sourcePrNumber: PR, branch: 'unrelated-branch' },
    });

    await handlePullRequestWebhook(env, mergedPayload());

    expect(outcomeRows(sqlite)).toHaveLength(0);
  });

  it('does NOT write pr_merged for a non-merged action (opened / closed-unmerged)', async () => {
    const { env, appDb, sqlite } = makeEnv();
    await seedSession(appDb, { sessionId: 'sess-author', git: { prNumber: PR } });

    // opened → open
    await handlePullRequestWebhook(env, {
      action: 'opened',
      pull_request: {
        number: PR,
        title: 'Ship it',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        merged: false,
        head: { ref: 'feature/x' },
        state: 'open',
      },
      repository: { full_name: REPO },
    });
    // closed without merge → closed
    await handlePullRequestWebhook(env, {
      action: 'closed',
      pull_request: {
        number: PR,
        title: 'Ship it',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        merged: false,
        merged_at: null,
        head: { ref: 'feature/x' },
        state: 'closed',
      },
      repository: { full_name: REPO },
    });

    expect(outcomeRows(sqlite)).toHaveLength(0);
  });
});
