import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { credentials as credentialsTable, users } from '../lib/schema/index.js';
import { encryptStringPBKDF2 } from '../lib/crypto.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { slackUserOAuthRouter, slackUserCallbackRouter } from './slack-user.js';
import { SLACK_USER_SCOPES } from '@valet/plugin-slack-user/actions';
import { getUserIntegrations } from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';

const holder = vi.hoisted(() => ({
  db: null as AppDb | null,
}));

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...actual,
    getDb: vi.fn(() => holder.db),
  };
});

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const ENCRYPTION_KEY = 'test-encryption-key-slack-user';

// Mirror the OAUTH_NONCE_COOKIE constant + hashing in slack-user.ts. Kept
// inline so the test doesn't need to import an internal helper.
const OAUTH_NONCE_COOKIE = 'slack_user_oauth_n';
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256B64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(new Uint8Array(buf));
}
function randomNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b64url(b);
}
/**
 * Build a valid (state, cookie) pair that mimics /oauth/start's browser
 * binding — the callback tests must supply both, otherwise the CSRF guard
 * rejects them with reason=user_mismatch.
 */
async function boundState(userId: string): Promise<{ state: string; cookieHeader: string }> {
  const nonce = randomNonce();
  const nonceHash = await sha256B64Url(nonce);
  const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId, nonceHash });
  return { state, cookieHeader: `${OAUTH_NONCE_COOKIE}=${nonce}` };
}

function buildApp(db: AppDb, userId: string = USER_ID) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: `${userId}@example.com`, role: 'member' });
    c.set('db', db);
    c.set('requestId', 'req-slack-user-test');
    await next();
  });
  app.route('/', slackUserOAuthRouter);
  return app;
}

/**
 * Callback lives on its own router mounted outside /api/* (no auth). Tests
 * hit /auth/slack-user/callback like production does — the callback handler
 * looks up `db` from context but does NOT require a `user`.
 */
function buildCallbackApp(db: AppDb) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('requestId', 'req-slack-user-test');
    await next();
  });
  app.route('/auth/slack-user', slackUserCallbackRouter);
  return app;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    // These tests exercise the router via c.get('db') (the Drizzle AppDb),
    // not the raw D1 binding — a minimal placeholder is fine here.
    DB: {} as Env['DB'],
    ENCRYPTION_KEY,
    FRONTEND_URL: 'https://app.example.com',
    SLACK_CLIENT_ID: 'CLIENT_ID',
    SLACK_CLIENT_SECRET: 'CLIENT_SECRET',
    ...overrides,
  } as Env;
}

describe('POST /oauth/start', () => {
  let db: AppDb;

  beforeEach(() => {
    const { db: newDb } = createTestDb();
    db = newDb as AppDb;
    holder.db = db;
  });

  it('returns 400 when SLACK_CLIENT_ID is not configured', async () => {
    const app = buildApp(db);
    const env = makeEnv({ SLACK_CLIENT_ID: undefined, SLACK_CLIENT_SECRET: undefined });
    const res = await app.request(
      'https://api.example.com/oauth/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/SLACK_CLIENT_ID unset/);
  });

  it('returns an authorizeUrl pointing at slack.com/oauth/v2/authorize with the full user_scope bundle', async () => {
    const app = buildApp(db);
    const res = await app.request(
      'https://api.example.com/oauth/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string };
    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('CLIENT_ID');
    expect(url.searchParams.get('scope')).toBe('');
    const userScopes = url.searchParams.get('user_scope') ?? '';
    expect(userScopes).toContain('search:read');
    expect(userScopes).toContain('chat:write');
    expect(userScopes).toContain('users.profile:write');
    expect(userScopes).not.toContain('chat:write.customize'); // bot-only excluded
    expect(userScopes).not.toContain('admin.'); // admin scopes excluded
    expect(userScopes).not.toContain('search:read.enterprise');

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    const verified = await verifyOAuthState(ENCRYPTION_KEY, 'slack-user', state!);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(USER_ID);
    // The signed state must carry a hash of the browser-bound nonce so the
    // callback can prove this flow originated in the same browser.
    expect(typeof verified!.nonceHash).toBe('string');
    expect((verified!.nonceHash as string).length).toBeGreaterThan(0);

    // /oauth/start must set the handshake cookie: HttpOnly, SameSite=Lax,
    // and scoped to /auth/slack-user (the path the callback lives on, which
    // is outside /api/*). The cookie's SHA-256 hash must equal the
    // nonceHash embedded in the state.
    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain('slack_user_oauth_n=');
    expect(setCookieHeader!.toLowerCase()).toContain('httponly');
    expect(setCookieHeader!.toLowerCase()).toContain('samesite=lax');
    expect(setCookieHeader).toContain('Path=/auth/slack-user');

    const match = setCookieHeader!.match(/slack_user_oauth_n=([^;]+)/);
    expect(match).toBeTruthy();
    const cookieValue = match![1];
    expect(await sha256B64Url(cookieValue)).toBe(verified!.nonceHash);
  });
});

// Stub Slack's oauth.v2.access endpoint for callback tests.
function mockOauthV2Access(response: Record<string, unknown>, status: number = 200) {
  const original = global.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('slack.com/api/oauth.v2.access')) {
      return new Response(JSON.stringify(response), { status });
    }
    if (original) return original(input as RequestInfo);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  // Vitest's Mock generic can't fully match global.fetch's overloaded signature —
  // a bridge cast is fine here; the mock's behavior is what's exercised.
  global.fetch = spy as unknown as typeof global.fetch;
  return () => {
    global.fetch = original;
  };
}

describe('GET /oauth/callback', () => {
  let db: AppDb;
  let env: Env;

  beforeEach(() => {
    const { db: newDb } = createTestDb();
    db = newDb as AppDb;
    holder.db = db;
    // integrations.userId is a FK to users — seed both test users.
    db.insert(users).values({ id: USER_ID, email: `${USER_ID}@example.com` }).run();
    db.insert(users).values({ id: OTHER_USER_ID, email: `${OTHER_USER_ID}@example.com` }).run();
    env = makeEnv();
  });

  it('redirects to /integrations?slack_user=linked on success and stores the xoxp token + metadata', async () => {
    const { state, cookieHeader } = await boundState(USER_ID);
    // Use the live bundle so the granted-scope mock never drifts from the source.
    const fullScopes = SLACK_USER_SCOPES;
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-real', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test Workspace' },
    });

    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://app.example.com/integrations?slack_user=linked',
      );

      const row = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'))
        .get();
      expect(row).toBeTruthy();
      expect((row as { ownerId: string }).ownerId).toBe(USER_ID);
      expect((row as { credentialType: string }).credentialType).toBe('oauth2');
      const metadata = JSON.parse((row as { metadata: string }).metadata) as {
        slack_user_id: string;
        team_id: string;
        team_name: string;
      };
      expect(metadata.slack_user_id).toBe('U123');
      expect(metadata.team_id).toBe('T1');
      expect(metadata.team_name).toBe('Test Workspace');

      // The integration row must exist so the slack_user.* tools surface in
      // the orchestrator's list_tools. Storing only the credential is not enough.
      const integrationRows = await getUserIntegrations(db, USER_ID);
      const slackUser = integrationRows.find((i) => i.service === 'slack-user');
      expect(slackUser).toBeTruthy();
      expect(slackUser!.status).toBe('active');
    } finally {
      restore();
    }
  });

  // Note: the previous "resolves user from state when unauthenticated" test
  // is subsumed by every other callback test here — `buildCallbackApp` never
  // sets `user` in context, so if identity weren't coming from the signed
  // state the redirects wouldn't be =linked.

  it('redirects with error=invalid_state when state is malformed', async () => {
    const app = buildCallbackApp(db);
    const res = await app.request(
      'https://api.example.com/auth/slack-user/callback?code=abc&state=not-a-jwt',
      { method: 'GET', redirect: 'manual' },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('slack_user=error');
    expect(res.headers.get('location')).toContain('reason=invalid_state');
  });

  it('redirects with error when oauth.v2.access fails', async () => {
    const { state, cookieHeader } = await boundState(USER_ID);
    const restore = mockOauthV2Access({ ok: false, error: 'invalid_code' });
    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=invalid_code');
    } finally {
      restore();
    }
  });

  it('redirects with reason=already_linked when the same Slack user is already linked to a different Valet user', async () => {
    // Seed: user-2 already has slack-user credential pointing at slack U123.
    const existingEncrypted = await encryptStringPBKDF2(
      JSON.stringify({ access_token: 'xoxp-old' }),
      ENCRYPTION_KEY,
    );
    await db.insert(credentialsTable).values({
      id: crypto.randomUUID(),
      ownerType: 'user',
      ownerId: OTHER_USER_ID,
      provider: 'slack-user',
      credentialType: 'oauth2',
      encryptedData: existingEncrypted,
      metadata: JSON.stringify({ slack_user_id: 'U123', team_id: 'T1' }),
    });

    const { state, cookieHeader } = await boundState(USER_ID);
    // Use the live bundle so the granted-scope mock never drifts from the source.
    const fullScopes = SLACK_USER_SCOPES;
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-new', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test' },
    });

    try {
      // Note: user-1 is trying to link the same Slack user as user-2.
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=already_linked');

      // The original user's credential must remain untouched
      const row = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.ownerId, OTHER_USER_ID))
        .get();
      expect(row).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('upserts (treats as reconnect) when the same user re-links the same Slack identity', async () => {
    // Seed: user-1 already has slack-user credential pointing at slack U123.
    const existingEncrypted = await encryptStringPBKDF2(
      JSON.stringify({ access_token: 'xoxp-old' }),
      ENCRYPTION_KEY,
    );
    await db.insert(credentialsTable).values({
      id: crypto.randomUUID(),
      ownerType: 'user',
      ownerId: USER_ID,
      provider: 'slack-user',
      credentialType: 'oauth2',
      encryptedData: existingEncrypted,
      metadata: JSON.stringify({ slack_user_id: 'U123', team_id: 'T1' }),
    });

    const { state, cookieHeader } = await boundState(USER_ID);
    // Use the live bundle so the granted-scope mock never drifts from the source.
    const fullScopes = SLACK_USER_SCOPES;
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-new', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test' },
    });

    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://app.example.com/integrations?slack_user=linked',
      );

      // Still exactly one row for slack-user
      const rows = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'));
      expect(rows).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('redirects with reason=missing_scopes when the granted scope set is incomplete', async () => {
    const { state, cookieHeader } = await boundState(USER_ID);
    // Note: explicitly missing chat:write and users.profile:write
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: {
        id: 'U123',
        access_token: 'xoxp-real',
        scope: 'search:read,channels:read,users:read',
      },
      team: { id: 'T1', name: 'Test' },
    });

    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=missing_scopes');

      // No credential should be stored on missing scopes
      const rows = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'));
      expect(rows).toHaveLength(0);
    } finally {
      restore();
    }
  });

  // ─── Account-linking CSRF guard ──────────────────────────────────────────
  //
  // These cover the exact attack the earlier revision was vulnerable to: the
  // callback used to trust the signed state alone as identity, so an
  // attacker could mint a state for their own userId (via /oauth/start),
  // send the resulting Slack consent link to a victim, and have the
  // victim's xoxp token stored under the attacker's account. Now the state
  // carries a hash of a browser-bound cookie nonce; without the matching
  // cookie the callback must refuse to store anything.

  it('CSRF: rejects the callback when the browser has no handshake cookie', async () => {
    // Attacker minted this state via /oauth/start (so it contains a valid
    // nonceHash), but the victim's browser has no matching cookie.
    const { state } = await boundState(USER_ID);
    // Slack must never even be contacted if the guard is doing its job.
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-victim', scope: SLACK_USER_SCOPES.join(',') },
      team: { id: 'T1', name: 'Test' },
    });
    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=user_mismatch');

      // Nothing should have been stored under the attacker's id (or anyone's).
      const rows = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'));
      expect(rows).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('CSRF: rejects the callback when the cookie is present but does not match the state hash', async () => {
    // Attacker's state (their nonce hash), victim's browser cookie (a
    // different random nonce). The hash comparison must fail.
    const { state } = await boundState(USER_ID);
    const wrongCookie = `${OAUTH_NONCE_COOKIE}=${randomNonce()}`;
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-victim', scope: SLACK_USER_SCOPES.join(',') },
      team: { id: 'T1', name: 'Test' },
    });
    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: wrongCookie } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('reason=user_mismatch');

      const rows = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'));
      expect(rows).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('CSRF: clears the handshake cookie after a successful callback (single-use)', async () => {
    const { state, cookieHeader } = await boundState(USER_ID);
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-real', scope: SLACK_USER_SCOPES.join(',') },
      team: { id: 'T1', name: 'Test' },
    });
    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual', headers: { cookie: cookieHeader } },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://app.example.com/integrations?slack_user=linked',
      );
      // Cookie is cleared: Max-Age=0 (or an expired Expires) on Path=/auth/slack-user.
      const setCookieHeader = res.headers.get('set-cookie') ?? '';
      expect(setCookieHeader).toContain('slack_user_oauth_n=');
      expect(setCookieHeader).toContain('Path=/auth/slack-user');
      expect(setCookieHeader).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    } finally {
      restore();
    }
  });
});

describe('DELETE /oauth', () => {
  let db: AppDb;

  beforeEach(async () => {
    const { db: newDb } = createTestDb();
    db = newDb as AppDb;
    holder.db = db;

    const encrypted = await encryptStringPBKDF2(
      JSON.stringify({ access_token: 'xoxp-old' }),
      ENCRYPTION_KEY,
    );
    await db.insert(credentialsTable).values({
      id: crypto.randomUUID(),
      ownerType: 'user',
      ownerId: USER_ID,
      provider: 'slack-user',
      credentialType: 'oauth2',
      encryptedData: encrypted,
      metadata: JSON.stringify({ slack_user_id: 'U1' }),
    });
  });

  it('removes the slack-user credential row for the current user', async () => {
    const app = buildApp(db);
    const res = await app.request(
      'https://api.example.com/oauth',
      { method: 'DELETE' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const rows = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.provider, 'slack-user'));
    expect(rows).toHaveLength(0);
  });
});

describe('GET / (status)', () => {
  it('reports oauthAvailable=false when SLACK_CLIENT_ID is unset', async () => {
    const { db: newDb } = createTestDb();
    holder.db = newDb as AppDb;
    const app = buildApp(newDb as AppDb);
    const env = makeEnv({ SLACK_CLIENT_ID: undefined, SLACK_CLIENT_SECRET: undefined });
    const res = await app.request('https://api.example.com/', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauthAvailable: boolean; connected: boolean };
    expect(body.oauthAvailable).toBe(false);
    expect(body.connected).toBe(false);
  });
});
