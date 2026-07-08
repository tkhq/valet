import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { revokeCredential, storeCredential, hasCredential } from '../services/credentials.js';
import { credentials as credentialsTable } from '../lib/schema/index.js';
import { SLACK_USER_SCOPES } from '@valet/plugin-slack-user/actions';

const SLACK_API = 'https://slack.com/api';
const SLACK_AUTHORIZE = 'https://slack.com/oauth/v2/authorize';
const SLACK_USER_PROVIDER = 'slack-user';

/** Default redirect path on the frontend after the OAuth callback finishes. */
function frontendIntegrationsPath(env: Env, qs: string): string {
  const base = (env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/integrations?${qs}`;
}

/**
 * The Slack OAuth redirect URI MUST be a fixed, registered URL. We use the
 * worker's own /api/me/slack-user/oauth/callback endpoint so the callback runs
 * server-side (cookies stay on the worker origin) and we can redirect to the
 * frontend with a status query string at the end.
 */
function workerCallbackUrl(env: Env, req: Request): string {
  const url = new URL(req.url);
  // Prefer the explicit public API origin when configured, otherwise fall back
  // to the request's own origin. Either way, the path is /api/me/slack-user/oauth/callback.
  const base = env.API_PUBLIC_URL
    ? env.API_PUBLIC_URL.replace(/\/+$/, '')
    : `${url.protocol}//${url.host}`;
  return `${base}/api/me/slack-user/oauth/callback`;
}

/**
 * Decrypt and inspect every stored `slack-user` credential row to look for an
 * existing link to the same `slack_user_id`. Returns the row's userId if one
 * is found (so the caller can decide whether it's a same-user reconnect or a
 * cross-user collision).
 *
 * The slack-user table is small (one row per linked user) so this linear
 * scan is acceptable; if it becomes a hot path we'd add an indexed column
 * for slack_user_id at the schema level.
 */
async function findExistingSlackUserLink(
  env: Env,
  db: import('../lib/drizzle.js').AppDb,
  slackUserId: string,
): Promise<{ userId: string } | null> {
  const rows = (await db
    .select()
    .from(credentialsTable)
    .where(eq(credentialsTable.provider, SLACK_USER_PROVIDER))) as Array<{
    ownerId: string;
    ownerType: string;
    metadata: string | null;
  }>;
  for (const row of rows) {
    if (row.ownerType !== 'user') continue;
    if (!row.metadata) continue;
    let parsed: { slack_user_id?: string } | null = null;
    try {
      parsed = JSON.parse(row.metadata) as { slack_user_id?: string };
    } catch {
      continue;
    }
    if (parsed?.slack_user_id === slackUserId) {
      return { userId: row.ownerId };
    }
  }
  return null;
}

// ─── Authenticated User Router (mounted at /api/me/slack-user) ──────────────

export const slackUserOAuthRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/me/slack-user — status for the Slack (personal) card.
 * Returns oauthAvailable (SLACK_CLIENT_ID configured) + connected (user has a
 * stored slack-user credential).
 */
slackUserOAuthRouter.get('/', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const connected = await hasCredential(c.env, 'user', user.id, SLACK_USER_PROVIDER);

  let slackUserId: string | null = null;
  let teamId: string | null = null;
  let teamName: string | null = null;
  if (connected) {
    const row = (await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.provider, SLACK_USER_PROVIDER))
      .all()) as Array<{ ownerId: string; metadata: string | null }>;
    const mine = row.find((r) => r.ownerId === user.id);
    if (mine?.metadata) {
      try {
        const parsed = JSON.parse(mine.metadata) as {
          slack_user_id?: string;
          team_id?: string;
          team_name?: string;
        };
        slackUserId = parsed.slack_user_id || null;
        teamId = parsed.team_id || null;
        teamName = parsed.team_name || null;
      } catch {
        /* ignore */
      }
    }
  }

  return c.json({
    oauthAvailable: !!c.env.SLACK_CLIENT_ID && !!c.env.SLACK_CLIENT_SECRET,
    connected,
    slackUserId,
    teamId,
    teamName,
  });
});

/**
 * POST /api/me/slack-user/oauth/start — returns the Slack OAuth URL for the
 * user to visit. The state is a 10-minute signed JWT tying the request to
 * this user + the `slack-user` provider id (cross-provider state confusion
 * guard lives in verifyOAuthState).
 */
slackUserOAuthRouter.post('/oauth/start', async (c) => {
  const user = c.get('user');
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return c.json({ error: 'Slack OAuth is not configured (SLACK_CLIENT_ID unset).' }, 400);
  }

  const state = await signOAuthState(
    c.env.ENCRYPTION_KEY,
    SLACK_USER_PROVIDER,
    { userId: user.id },
    600,
  );
  const redirectUri = workerCallbackUrl(c.env, c.req.raw);
  const params = new URLSearchParams({
    client_id: c.env.SLACK_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    scope: '',
    user_scope: SLACK_USER_SCOPES.join(','),
  });
  const authorizeUrl = `${SLACK_AUTHORIZE}?${params}`;
  return c.json({ authorizeUrl });
});

/**
 * GET /api/me/slack-user/oauth/callback?code=&state= — Slack redirects here
 * after consent. We verify state, exchange the code via oauth.v2.access,
 * persist the user's xoxp token + metadata, then redirect to
 * /integrations?slack_user=linked (or =error / =error&reason=already_linked).
 *
 * NOTE: this route is exempt from the /api/* bearer-auth middleware (see
 * middleware/auth.ts). Slack redirects the browser here with no Authorization
 * header, and Valet has no auth cookie to fall back on. Identity is instead
 * carried by the HMAC-signed `state` param and verified below — that signature
 * (minted with ENCRYPTION_KEY, short expiry) is the proof this callback trusts.
 */
slackUserOAuthRouter.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  const errorRedirect = (reason?: string) => {
    const qs = new URLSearchParams({ slack_user: 'error' });
    if (reason) qs.set('reason', reason);
    return c.redirect(frontendIntegrationsPath(c.env, qs.toString()));
  };

  if (!code || !state) {
    return errorRedirect('missing_params');
  }
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return errorRedirect('not_configured');
  }

  const payload = await verifyOAuthState(c.env.ENCRYPTION_KEY, SLACK_USER_PROVIDER, state);
  if (!payload) return errorRedirect('invalid_state');
  // The signed state carries the initiating user's id — it is the identity
  // proof for this callback (the request itself is unauthenticated).
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return errorRedirect('invalid_state');

  // Exchange the code for an xoxp token (authed_user.access_token).
  let tokenResult: {
    ok: boolean;
    error?: string;
    authed_user?: { id?: string; access_token?: string; scope?: string };
    team?: { id?: string; name?: string };
  };
  try {
    const redirectUri = workerCallbackUrl(c.env, c.req.raw);
    const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.env.SLACK_CLIENT_ID,
        client_secret: c.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) return errorRedirect('oauth_http_error');
    tokenResult = (await res.json()) as typeof tokenResult;
  } catch {
    return errorRedirect('oauth_fetch_error');
  }

  if (!tokenResult.ok || !tokenResult.authed_user?.access_token) {
    return errorRedirect(tokenResult.error || 'oauth_failed');
  }
  const accessToken = tokenResult.authed_user.access_token;
  const slackUserId = tokenResult.authed_user.id || '';
  const teamId = tokenResult.team?.id || '';
  const teamName = tokenResult.team?.name || '';
  const grantedScopes = (tokenResult.authed_user.scope || '').split(',').filter(Boolean);

  // Validate that Slack returned the scopes we requested. If the workspace
  // admin restricted any of them, surface a structured error and don't store
  // a partial credential.
  const requested = new Set(SLACK_USER_SCOPES);
  const granted = new Set(grantedScopes);
  const missing: string[] = [];
  for (const s of requested) if (!granted.has(s)) missing.push(s);
  if (missing.length > 0) {
    console.warn(
      `[slack-user] OAuth returned missing scopes for user=${userId}: ${missing.join(',')}`,
    );
    return errorRedirect('missing_scopes');
  }

  // Cross-user collision check: same Slack user already linked to a different
  // Valet user. Reconnect by the same user → upsert + refresh.
  if (slackUserId) {
    const existing = await findExistingSlackUserLink(c.env, c.get('db'), slackUserId);
    if (existing && existing.userId !== userId) {
      return errorRedirect('already_linked');
    }
  }

  await storeCredential(
    c.env,
    'user',
    userId,
    SLACK_USER_PROVIDER,
    { access_token: accessToken },
    {
      credentialType: 'oauth2',
      scopes: grantedScopes.join(' '),
      metadata: {
        slack_user_id: slackUserId,
        team_id: teamId,
        team_name: teamName,
      },
    },
  );

  return c.redirect(frontendIntegrationsPath(c.env, new URLSearchParams({ slack_user: 'linked' }).toString()));
});

/**
 * DELETE /api/me/slack-user/oauth — disconnect (revoke the stored credential).
 * We do NOT attempt to revoke the token at Slack — Slack provides an Account
 * Connections panel for that and the user can revoke server-side at any time.
 * Removing the stored token here means subsequent slack_user.* calls return
 * a "Connect Slack (personal)" error.
 */
slackUserOAuthRouter.delete('/oauth', async (c) => {
  const user = c.get('user');
  await revokeCredential(c.env, 'user', user.id, SLACK_USER_PROVIDER);
  return c.json({ success: true });
});

/**
 * Exported for ad-hoc unit testing — surfaces the same collision check used
 * inside the callback handler.
 */
export const __testing = { findExistingSlackUserLink };
