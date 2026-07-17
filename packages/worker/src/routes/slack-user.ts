import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, sql } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { base64UrlEncode } from '../lib/hmac-jwt.js';
import { revokeCredential, storeCredential, hasCredential } from '../services/credentials.js';
import * as db from '../lib/db.js';
import { getCredentialRow } from '../lib/db/credentials.js';
import { credentials as credentialsTable } from '../lib/schema/index.js';
import { SLACK_USER_SCOPES, slackUserProvider } from '@valet/plugin-slack-user/actions';
import type { SlackUserOAuthStatus } from '@valet/shared';

const SLACK_USER_PROVIDER = 'slack-user';

/**
 * Browser-bound nonce for the OAuth handshake. On /auth/slack-user/start we
 * mint a random nonce, embed its SHA-256 hash in the signed state, and set
 * the raw nonce as an HttpOnly first-party cookie. On the
 * callback we require the cookie and that its hash matches the hash carried
 * in state — this binds the flow to the browser that started it and blocks
 * the account-linking CSRF where an attacker mints a state for their own
 * userId and gets a victim to complete Slack consent.
 *
 * SameSite=Lax is required (Slack redirects via a top-level GET; Strict
 * would drop the cookie). Path is scoped tightly so this cookie is never
 * sent to any other route.
 */
const OAUTH_NONCE_COOKIE = 'slack_user_oauth_n';
// Cookie is set by GET /auth/slack-user/start and consumed by
// GET /auth/slack-user/callback. Both are top-level navigations on the
// worker origin, so the cookie is always first-party — a Set-Cookie on a
// cross-origin fetch response (the previous design, set from
// POST /api/me/slack-user/oauth/start) is silently dropped by browsers
// when the frontend runs on a different origin than the worker.
const OAUTH_NONCE_COOKIE_PATH = '/auth/slack-user';
const OAUTH_NONCE_TTL_SECONDS = 600;

// Short-lived token bridging the authenticated /oauth/start call to the
// unauthenticated top-level /auth/slack-user/start navigation. Distinct
// `sub` so a begin token can never be replayed as an OAuth state.
const SLACK_USER_BEGIN_PROVIDER = 'slack-user-begin';
const BEGIN_TOKEN_TTL_SECONDS = 60;

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256B64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(buf));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Default redirect path on the frontend after the OAuth callback finishes. */
function frontendIntegrationsPath(env: Env, qs: string): string {
  const base = (env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/integrations?${qs}`;
}

/**
 * The Slack OAuth redirect URI MUST be a fixed, registered URL. We use
 * /auth/slack-user/callback (mounted at app root, outside /api/*) so the
 * callback route runs without the shared bearer-auth middleware — Slack
 * redirects the browser here with no Authorization header. Identity is
 * carried by the signed state + browser-bound nonce cookie (see below).
 */
function workerBaseUrl(env: Env, req: Request): string {
  const url = new URL(req.url);
  return env.API_PUBLIC_URL
    ? env.API_PUBLIC_URL.replace(/\/+$/, '')
    : `${url.protocol}//${url.host}`;
}

function workerCallbackUrl(env: Env, req: Request): string {
  return `${workerBaseUrl(env, req)}/auth/slack-user/callback`;
}

/**
 * Look up an existing `slack-user` credential linked to `slackUserId`.
 * Returns the row's userId if one is found (so the caller can decide
 * whether it's a same-user reconnect or a cross-user collision).
 *
 * The filter runs at the SQLite layer via `json_extract(metadata,
 * '$.slack_user_id')` — the row's encrypted `access_token` is never
 * touched (that lives in the `encrypted_data` blob, not `metadata`). If
 * this ever becomes hot we'd promote `slack_user_id` to a real indexed
 * column at the schema level.
 */
async function findExistingSlackUserLink(
  _env: Env,
  appDb: import('../lib/drizzle.js').AppDb,
  slackUserId: string,
): Promise<{ userId: string } | null> {
  const row = await appDb
    .select({ ownerId: credentialsTable.ownerId })
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.provider, SLACK_USER_PROVIDER),
        eq(credentialsTable.ownerType, 'user'),
        sql`json_extract(${credentialsTable.metadata}, '$.slack_user_id') = ${slackUserId}`,
      ),
    )
    .get();
  return row ? { userId: row.ownerId } : null;
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
  // Read the connected user's own credential row via the indexed lookup
  // helper — no full-table scan across every user's slack-user rows.
  if (connected) {
    const mine = await getCredentialRow(db, 'user', user.id, SLACK_USER_PROVIDER);
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

  const body: SlackUserOAuthStatus = {
    oauthAvailable: !!c.env.SLACK_CLIENT_ID && !!c.env.SLACK_CLIENT_SECRET,
    connected,
    slackUserId,
    teamId,
    teamName,
  };
  return c.json(body);
});

/**
 * POST /api/me/slack-user/oauth/start — returns a worker URL for the browser
 * to navigate to (NOT the Slack authorize URL directly).
 *
 * The nonce cookie that binds the OAuth flow to this browser must be set in
 * a first-party context: this endpoint is called via cross-origin fetch from
 * the frontend, and browsers drop Set-Cookie on cross-site fetch responses.
 * So we hand back /auth/slack-user/start?token=… — a top-level navigation on
 * the worker origin — and THAT route sets the cookie and 302s to Slack.
 * The begin token is a 60s signed JWT carrying the authenticated userId.
 */
slackUserOAuthRouter.post('/oauth/start', async (c) => {
  const user = c.get('user');
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return c.json({ error: 'Slack OAuth is not configured (SLACK_CLIENT_ID unset).' }, 400);
  }

  const beginToken = await signOAuthState(
    c.env.ENCRYPTION_KEY,
    SLACK_USER_BEGIN_PROVIDER,
    { userId: user.id },
    BEGIN_TOKEN_TTL_SECONDS,
  );
  const authorizeUrl = `${workerBaseUrl(c.env, c.req.raw)}/auth/slack-user/start?token=${encodeURIComponent(beginToken)}`;
  return c.json({ authorizeUrl });
});

// ─── Public Callback Router (mounted at /auth/slack-user) ───────────────────
//
// Mounted OUTSIDE /api/* so it does not go through the bearer-auth middleware
// — Slack redirects the browser here with no Authorization header. Sibling
// pattern of /auth/github and /github (GitHub App setup callback). Keeping
// this separate from /api/me/slack-user avoids accumulating per-path
// exemptions inside the shared auth middleware (regression shape of the
// prior webhook-401 incident).
//
// Identity is carried by the HMAC-signed `state` param + the browser-bound
// nonce cookie set at /auth/slack-user/start.

export const slackUserCallbackRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /auth/slack-user/start?token= — top-level navigation target returned by
 * POST /api/me/slack-user/oauth/start. Verifies the short-lived begin token,
 * mints the browser-bound nonce, sets it as a first-party HttpOnly cookie
 * (possible here because this is a top-level navigation on the worker origin,
 * unlike the cross-origin fetch to /oauth/start), signs the real OAuth state,
 * and 302s to Slack's consent screen.
 */
slackUserCallbackRouter.get('/start', async (c) => {
  const token = c.req.query('token');

  const errorRedirect = (reason: string) => {
    const qs = new URLSearchParams({ slack_user: 'error', reason });
    return c.redirect(frontendIntegrationsPath(c.env, qs.toString()));
  };

  if (!token) return errorRedirect('missing_params');
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return errorRedirect('not_configured');
  }

  const payload = await verifyOAuthState(c.env.ENCRYPTION_KEY, SLACK_USER_BEGIN_PROVIDER, token);
  const userId = typeof payload?.userId === 'string' ? payload.userId : '';
  if (!userId) return errorRedirect('invalid_state');

  // Mint a browser-bound nonce: raw value goes in an HttpOnly cookie, its
  // SHA-256 hash goes into the signed state. On callback both must match —
  // that is what ties this OAuth flow to the initiator's browser and blocks
  // the account-linking CSRF (see OAUTH_NONCE_COOKIE docs above).
  const nonce = randomNonce();
  const nonceHash = await sha256B64Url(nonce);
  const state = await signOAuthState(
    c.env.ENCRYPTION_KEY,
    SLACK_USER_PROVIDER,
    { userId, nonceHash },
    OAUTH_NONCE_TTL_SECONDS,
  );
  setCookie(c, OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: OAUTH_NONCE_COOKIE_PATH,
    maxAge: OAUTH_NONCE_TTL_SECONDS,
  });

  const redirectUri = workerCallbackUrl(c.env, c.req.raw);
  // Delegate URL construction to the provider so `plugin-slack-user` owns
  // the shape of the authorize URL (scope split, user_scope bundling) —
  // this route stays a thin transport wrapper. getOAuthUrl is declared
  // non-optional on IntegrationProvider (see @valet/sdk).
  const authorizeUrl = slackUserProvider.getOAuthUrl!(
    { clientId: c.env.SLACK_CLIENT_ID, clientSecret: c.env.SLACK_CLIENT_SECRET },
    redirectUri,
    state,
  );
  return c.redirect(authorizeUrl);
});

/**
 * GET /auth/slack-user/callback?code=&state= — Slack redirects here after
 * consent. We verify state + cookie nonce, exchange the code via
 * oauth.v2.access, persist the user's xoxp token + metadata, then redirect
 * to /integrations?slack_user=linked (or =error / =error&reason=…).
 */
slackUserCallbackRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const nonceCookie = getCookie(c, OAUTH_NONCE_COOKIE);

  // Always clear the handshake cookie on the way out — it is single-use.
  const errorRedirect = (reason?: string) => {
    deleteCookie(c, OAUTH_NONCE_COOKIE, { path: OAUTH_NONCE_COOKIE_PATH });
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
  // The signed state carries the initiating user's id, but the signature
  // alone is not enough — an attacker could mint a state for their own id
  // and have a victim complete Slack consent, storing the victim's token
  // under the attacker's account. The nonce cookie set by /oauth/start
  // binds this callback to the initiator's browser: if the cookie is
  // missing or its hash doesn't match the hash in state, the request did
  // not originate from the browser that started this flow.
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return errorRedirect('invalid_state');
  const expectedHash = typeof payload.nonceHash === 'string' ? payload.nonceHash : '';
  if (!expectedHash || !nonceCookie) return errorRedirect('user_mismatch');
  const cookieHash = await sha256B64Url(nonceCookie);
  if (!timingSafeEqual(cookieHash, expectedHash)) return errorRedirect('user_mismatch');

  // Exchange the code via the provider — plugin-slack-user owns the
  // `oauth.v2.access` shape (JSON parsing, xoxp extraction, team_id +
  // slack_user_id capture). Keeping it there lets the plugin evolve without
  // touching the worker route.
  const redirectUri = workerCallbackUrl(c.env, c.req.raw);
  let exchanged: {
    access_token?: string;
    scope?: string;
    slack_user_id?: string;
    team_id?: string;
    team_name?: string;
  };
  try {
    exchanged = (await slackUserProvider.exchangeOAuthCode!(
      { clientId: c.env.SLACK_CLIENT_ID, clientSecret: c.env.SLACK_CLIENT_SECRET },
      code,
      redirectUri,
    )) as typeof exchanged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort reason extraction: exchangeOAuthCode throws
    // `oauth.v2.access failed: <slack error>` on API-level failures and
    // `oauth.v2.access HTTP <code>` on transport failures — pass those
    // through as the reason so the client mirrors the previous UX.
    const match = /oauth\.v2\.access failed: (\S+)/.exec(msg);
    return errorRedirect(match?.[1] || (msg.includes('HTTP') ? 'oauth_http_error' : 'oauth_fetch_error'));
  }
  if (!exchanged.access_token) return errorRedirect('oauth_failed');

  const accessToken = exchanged.access_token;
  const slackUserId = exchanged.slack_user_id || '';
  const teamId = exchanged.team_id || '';
  const teamName = exchanged.team_name || '';
  const grantedScopes = (exchanged.scope || '').split(',').filter(Boolean);

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

  // Register the integration row. storeCredential only persists the token,
  // but the orchestrator enumerates its tool surface from the integrations
  // table (getUserIntegrations) — without a row here the slack_user.*
  // actions never appear in list_tools. Uses the atomic upsert
  // (`onConflictDoUpdate` on userId+service+scope) so concurrent callbacks
  // can't race into duplicate rows or a pending→active gap.
  //
  // If ensureIntegration fails (transient D1 error), roll back both the
  // credential and any pre-existing integration row so the tool surface
  // doesn't diverge from the credential state — listTools filters by
  // `status = active` alone, so a stale active row with no credential
  // would keep slack_user.* tools exposed and every call would fail.
  const appDb = c.get('db');
  try {
    await db.ensureIntegration(appDb, userId, SLACK_USER_PROVIDER, 'user', {
      entities: grantedScopes,
    });
  } catch (err) {
    console.error(`[slack-user] ensureIntegration failed for user=${userId}:`, err);
    try {
      await revokeCredential(c.env, 'user', userId, SLACK_USER_PROVIDER);
    } catch (revokeErr) {
      console.error(`[slack-user] rollback revokeCredential failed for user=${userId}:`, revokeErr);
    }
    try {
      const existing = (await db.getUserIntegrations(appDb, userId)).find(
        (i) => i.service === SLACK_USER_PROVIDER,
      );
      if (existing) await db.deleteIntegration(appDb, existing.id);
    } catch (delErr) {
      console.error(`[slack-user] rollback deleteIntegration failed for user=${userId}:`, delErr);
    }
    return errorRedirect('integration_write_failed');
  }

  deleteCookie(c, OAUTH_NONCE_COOKIE, { path: OAUTH_NONCE_COOKIE_PATH });
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
  // Also remove the integration row so the slack_user.* tools drop out of the
  // orchestrator's tool surface (they were added on connect).
  const appDb = c.get('db');
  const existing = (await db.getUserIntegrations(appDb, user.id)).find(
    (i) => i.service === SLACK_USER_PROVIDER,
  );
  if (existing) await db.deleteIntegration(appDb, existing.id);
  return c.json({ success: true });
});

/**
 * Exported for ad-hoc unit testing — surfaces the same collision check used
 * inside the callback handler.
 */
export const __testing = { findExistingSlackUserLink };
