import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { credentials as credentialsTable } from '../lib/schema/index.js';
import { encryptStringPBKDF2 } from '../lib/crypto.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { slackUserOAuthRouter } from './slack-user.js';
import { SLACK_USER_SCOPES } from '@valet/plugin-slack-user/actions';
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

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: vi.fn() } as unknown as Env['DB'],
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
    db = newDb as unknown as AppDb;
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
    db = newDb as unknown as AppDb;
    holder.db = db;
    env = makeEnv();
  });

  it('redirects to /integrations?slack_user=linked on success and stores the xoxp token + metadata', async () => {
    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
    const fullScopes = [
      'search:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read',
      'users.profile:read', 'team:read', 'chat:write', 'users.profile:write',
      'reactions:write', 'reactions:read', 'dnd:write', 'dnd:read', 'files:read',
      'files:write', 'pins:read', 'pins:write', 'bookmarks:read', 'bookmarks:write',
      'stars:read', 'stars:write', 'reminders:read', 'reminders:write',
      'usergroups:read', 'usergroups:write', 'emoji:read',
    ];
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-real', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test Workspace' },
    });

    try {
      const app = buildApp(db);
      const res = await app.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
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
    } finally {
      restore();
    }
  });

  it('resolves the user from the signed state even when the request is unauthenticated', async () => {
    // Slack redirects the browser here with no Authorization header, so no
    // `user` is set in context. Identity must come from the signed state alone.
    const appNoAuth = new Hono<{ Bindings: Env; Variables: Variables }>();
    appNoAuth.onError(errorHandler);
    appNoAuth.use('*', async (c, next) => {
      c.set('db', db);
      c.set('requestId', 'req-slack-user-test');
      await next();
    });
    appNoAuth.route('/', slackUserOAuthRouter);

    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-real', scope: SLACK_USER_SCOPES.join(',') },
      team: { id: 'T1', name: 'Test Workspace' },
    });
    try {
      const res = await appNoAuth.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
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
      expect((row as { ownerId: string }).ownerId).toBe(USER_ID);
    } finally {
      restore();
    }
  });

  it('redirects with error=invalid_state when state is malformed', async () => {
    const app = buildApp(db);
    const res = await app.request(
      'https://api.example.com/oauth/callback?code=abc&state=not-a-jwt',
      { method: 'GET', redirect: 'manual' },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('slack_user=error');
    expect(res.headers.get('location')).toContain('reason=invalid_state');
  });

  it('redirects with error when oauth.v2.access fails', async () => {
    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
    const restore = mockOauthV2Access({ ok: false, error: 'invalid_code' });
    try {
      const app = buildApp(db);
      const res = await app.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
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

    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
    const fullScopes = [
      'search:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read',
      'users.profile:read', 'team:read', 'chat:write', 'users.profile:write',
      'reactions:write', 'reactions:read', 'dnd:write', 'dnd:read', 'files:read',
      'files:write', 'pins:read', 'pins:write', 'bookmarks:read', 'bookmarks:write',
      'stars:read', 'stars:write', 'reminders:read', 'reminders:write',
      'usergroups:read', 'usergroups:write', 'emoji:read',
    ];
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-new', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test' },
    });

    try {
      // Note: user-1 is trying to link the same Slack user as user-2.
      const app = buildApp(db, USER_ID);
      const res = await app.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
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

    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
    const fullScopes = [
      'search:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read',
      'users.profile:read', 'team:read', 'chat:write', 'users.profile:write',
      'reactions:write', 'reactions:read', 'dnd:write', 'dnd:read', 'files:read',
      'files:write', 'pins:read', 'pins:write', 'bookmarks:read', 'bookmarks:write',
      'stars:read', 'stars:write', 'reminders:read', 'reminders:write',
      'usergroups:read', 'usergroups:write', 'emoji:read',
    ];
    const restore = mockOauthV2Access({
      ok: true,
      authed_user: { id: 'U123', access_token: 'xoxp-new', scope: fullScopes.join(',') },
      team: { id: 'T1', name: 'Test' },
    });

    try {
      const app = buildApp(db, USER_ID);
      const res = await app.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
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
    const state = await signOAuthState(ENCRYPTION_KEY, 'slack-user', { userId: USER_ID });
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
      const app = buildApp(db);
      const res = await app.request(
        `https://api.example.com/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        { method: 'GET', redirect: 'manual' },
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
});

describe('DELETE /oauth', () => {
  let db: AppDb;

  beforeEach(async () => {
    const { db: newDb } = createTestDb();
    db = newDb as unknown as AppDb;
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
    holder.db = newDb as unknown as AppDb;
    const app = buildApp(newDb as unknown as AppDb);
    const env = makeEnv({ SLACK_CLIENT_ID: undefined, SLACK_CLIENT_SECRET: undefined });
    const res = await app.request('https://api.example.com/', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauthAvailable: boolean; connected: boolean };
    expect(body.oauthAvailable).toBe(false);
    expect(body.connected).toBe(false);
  });
});
