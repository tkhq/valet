import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { credentials as credentialsTable, users } from '../lib/schema/index.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { slackUserOAuthRouter, slackUserCallbackRouter } from './slack-user.js';
import { SLACK_USER_SCOPES } from '@valet/plugin-slack-user/actions';
import { getUserIntegrations, saveOrgSlackInstall } from '../lib/db.js';
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

/** Signed OAuth state as minted by POST /oauth/start. */
async function stateFor(userId: string): Promise<string> {
  return signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId });
}

interface TestClaim {
  v: number;
  userId: string;
  accessToken: string;
  grantedScopes: string[];
  slackUserId: string;
  teamId: string;
  teamName: string;
  exp: number;
}

/** Encrypted claim blob as issued by the OAuth callback. */
async function makeClaim(overrides: Partial<TestClaim> = {}): Promise<string> {
  const claim: TestClaim = {
    v: 1,
    userId: USER_ID,
    accessToken: 'xoxp-real',
    grantedScopes: [...SLACK_USER_SCOPES],
    slackUserId: 'U123',
    teamId: 'T1',
    teamName: 'Test Workspace',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
  return encryptStringPBKDF2(JSON.stringify(claim), ENCRYPTION_KEY);
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

  it('returns a slack.com authorize URL with the full user_scope bundle and a state bound to the user', async () => {
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

    // No cookie in this design: the account binding happens at the
    // authenticated /oauth/claim step, not via a browser-bound nonce.
    expect(res.headers.get('set-cookie')).toBeNull();

    // No org install seeded → no team pin; Slack falls back to its own
    // workspace picker.
    expect(url.searchParams.get('team')).toBeNull();
  });

  it('pins the authorize URL to the org install workspace via the team param', async () => {
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@example.com`,
      name: 'User One',
    });
    await saveOrgSlackInstall(db, ENCRYPTION_KEY, {
      teamId: 'T-ORG',
      teamName: 'Org Workspace',
      botUserId: 'B1',
      botToken: 'xoxb-test',
      installedBy: USER_ID,
    });

    const app = buildApp(db);
    const res = await app.request(
      'https://api.example.com/oauth/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string };
    const url = new URL(body.authorizeUrl);
    expect(url.searchParams.get('team')).toBe('T-ORG');
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
    env = makeEnv();
  });

  it('redirects to /integrations?slack_user=claim with an encrypted claim blob and persists NOTHING', async () => {
    const state = await stateFor(USER_ID);
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
        { method: 'GET', redirect: 'manual' },
        env,
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe('https://app.example.com/integrations');
      expect(loc.searchParams.get('slack_user')).toBe('claim');

      const blob = loc.searchParams.get('claim');
      expect(blob).toBeTruthy();
      const claim = JSON.parse(await decryptStringPBKDF2(blob!, ENCRYPTION_KEY)) as TestClaim;
      expect(claim.v).toBe(1);
      expect(claim.userId).toBe(USER_ID);
      expect(claim.accessToken).toBe('xoxp-real');
      expect(claim.slackUserId).toBe('U123');
      expect(claim.teamId).toBe('T1');
      expect(claim.teamName).toBe('Test Workspace');
      expect(claim.grantedScopes).toEqual([...fullScopes]);
      expect(claim.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // The callback is not a trust boundary — nothing may be persisted
      // until the authenticated claim call.
      const rows = await db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.provider, 'slack-user'));
      expect(rows).toHaveLength(0);
    } finally {
      restore();
    }
  });

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
    const state = await stateFor(USER_ID);
    const restore = mockOauthV2Access({ ok: false, error: 'invalid_code' });
    try {
      const app = buildCallbackApp(db);
      const res = await app.request(
        `https://api.example.com/auth/slack-user/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=invalid_code');
    } finally {
      restore();
    }
  });

  it('redirects with reason=missing_scopes when the granted scope set is incomplete', async () => {
    const state = await stateFor(USER_ID);
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
        { method: 'GET', redirect: 'manual' },
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('slack_user=error');
      expect(res.headers.get('location')).toContain('reason=missing_scopes');
      // No claim blob is issued on missing scopes.
      expect(res.headers.get('location')).not.toContain('claim=');
    } finally {
      restore();
    }
  });
});

describe('POST /oauth/claim', () => {
  let db: AppDb;

  beforeEach(() => {
    const { db: newDb } = createTestDb();
    db = newDb as AppDb;
    holder.db = db;
    // integrations.userId is a FK to users — seed both test users.
    db.insert(users).values({ id: USER_ID, email: `${USER_ID}@example.com` }).run();
    db.insert(users).values({ id: OTHER_USER_ID, email: `${OTHER_USER_ID}@example.com` }).run();
  });

  async function postClaim(app: ReturnType<typeof buildApp>, claim: string) {
    return app.request(
      'https://api.example.com/oauth/claim',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim }),
      },
      makeEnv(),
    );
  }

  it('stores the xoxp token + metadata and registers the integration row', async () => {
    const app = buildApp(db);
    const res = await postClaim(app, await makeClaim());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linked: boolean; teamName: string | null };
    expect(body.linked).toBe(true);
    expect(body.teamName).toBe('Test Workspace');

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
  });

  it('CSRF: rejects a claim issued for a different user with 403 user_mismatch and stores nothing', async () => {
    // The blob names OTHER_USER_ID (the flow initiator); the authenticated
    // session is USER_ID. This is the delivered-link attack: no matter whose
    // browser completed Slack consent, the bind must fail here.
    const app = buildApp(db); // authenticated as USER_ID
    const res = await postClaim(app, await makeClaim({ userId: OTHER_USER_ID }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('user_mismatch');

    const rows = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.provider, 'slack-user'));
    expect(rows).toHaveLength(0);
  });

  it('rejects an expired claim with 400 claim_expired', async () => {
    const app = buildApp(db);
    const res = await postClaim(app, await makeClaim({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('claim_expired');
  });

  it('rejects a garbage blob with 400 invalid_claim', async () => {
    const app = buildApp(db);
    const res = await postClaim(app, 'not-a-real-blob');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_claim');
  });

  it('rejects with 409 already_linked when the same Slack user is linked to a different Valet user', async () => {
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

    const app = buildApp(db); // user-1 tries to link the same Slack user
    const res = await postClaim(app, await makeClaim());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('already_linked');

    // The original user's credential must remain untouched
    const row = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.ownerId, OTHER_USER_ID))
      .get();
    expect(row).toBeTruthy();
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

    const app = buildApp(db);
    const res = await postClaim(app, await makeClaim({ accessToken: 'xoxp-new' }));
    expect(res.status).toBe(200);

    // Still exactly one row for slack-user
    const rows = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.provider, 'slack-user'));
    expect(rows).toHaveLength(1);
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
