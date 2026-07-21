import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauth-state.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import { revokeCredential, storeCredential, hasCredential } from '../services/credentials.js';
import * as db from '../lib/db.js';
import { getCredentialRow } from '../lib/db/credentials.js';
import { credentials as credentialsTable } from '../lib/schema/index.js';
import { SLACK_USER_SCOPES, slackUserProvider } from '@valet/plugin-slack-user/actions';
import type { SlackUserOAuthStatus } from '@valet/shared';

const SLACK_USER_PROVIDER = 'slack-user';

const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * Claim-based finalization: the unauthenticated callback exchanges the code
 * but persists NOTHING. It encrypts the exchange result into a short-lived
 * claim blob and redirects to the frontend, which redeems it via the
 * authenticated POST /api/me/slack-user/oauth/claim. The claim handler
 * requires `claim.userId === authenticated user` — that single check is the
 * CSRF defense: no matter whose browser ran the consent flow or who obtains
 * the claim URL, the credential can only ever be bound by the user the flow
 * was started for, over their own authenticated channel.
 */
const CLAIM_TTL_SECONDS = 300;

interface SlackUserClaim {
  v: 1;
  userId: string;
  accessToken: string;
  grantedScopes: string[];
  slackUserId: string;
  teamId: string;
  teamName: string;
  /** Unix seconds. */
  exp: number;
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
 * redirects the browser here with no Authorization header. The account
 * bind happens later, on the authenticated /oauth/claim call.
 */
function workerCallbackUrl(env: Env, req: Request): string {
  const url = new URL(req.url);
  const base = env.API_PUBLIC_URL
    ? env.API_PUBLIC_URL.replace(/\/+$/, '')
    : `${url.protocol}//${url.host}`;
  return `${base}/auth/slack-user/callback`;
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
 * POST /api/me/slack-user/oauth/start — returns the Slack authorize URL for
 * the browser to navigate to. The state is a 10-minute signed JWT tying the
 * flow to this user + the `slack-user` provider id (cross-provider state
 * confusion guard lives in verifyOAuthState). No cookie is involved: the
 * account binding is enforced by the authenticated /oauth/claim step, so
 * nothing here needs to survive the cross-origin fetch → top-level
 * navigation transition.
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
    OAUTH_STATE_TTL_SECONDS,
  );
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
// The callback persists nothing — it hands an encrypted claim blob back to
// the frontend, and the authenticated /oauth/claim call does the bind.

export const slackUserCallbackRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /auth/slack-user/callback?code=&state= — Slack redirects here after
 * consent. We verify state, exchange the code via oauth.v2.access, and
 * validate scopes — but persist NOTHING. The exchange result is encrypted
 * into a 5-minute claim blob and handed to the frontend via
 * /integrations?slack_user=claim&claim=…; the frontend redeems it with the
 * authenticated POST /api/me/slack-user/oauth/claim, which is where the
 * userId binding is enforced.
 */
slackUserCallbackRouter.get('/callback', async (c) => {
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
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return errorRedirect('invalid_state');

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

  // Persist nothing here — encrypt the exchange result into a claim blob
  // and let the authenticated /oauth/claim call do the bind. The blob is
  // AES-GCM ciphertext under the worker ENCRYPTION_KEY: opaque to the
  // browser (it transits the frontend URL + history), and only redeemable
  // by the user named inside it.
  const claim: SlackUserClaim = {
    v: 1,
    userId,
    accessToken,
    grantedScopes,
    slackUserId,
    teamId,
    teamName,
    exp: Math.floor(Date.now() / 1000) + CLAIM_TTL_SECONDS,
  };
  const blob = await encryptStringPBKDF2(JSON.stringify(claim), c.env.ENCRYPTION_KEY);
  return c.redirect(
    frontendIntegrationsPath(
      c.env,
      new URLSearchParams({ slack_user: 'claim', claim: blob }).toString(),
    ),
  );
});

/**
 * POST /api/me/slack-user/oauth/claim — redeem a claim blob issued by the
 * callback. This is the trust boundary of the whole flow: the blob names the
 * user the flow was started for, and it can only be redeemed by that same
 * user over their authenticated channel. Whoever else obtains the blob (URL
 * leak, delivered link, replay) cannot bind the credential to any account.
 *
 * Errors return { error, code } (the app-wide error shape) with the same
 * code vocabulary the callback uses in ?slack_user=error&reason=… so the
 * frontend maps both through one label table.
 */
slackUserOAuthRouter.post('/oauth/claim', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ claim?: string }>().catch(() => ({ claim: undefined }));
  if (!body.claim || typeof body.claim !== 'string') {
    return c.json({ error: 'Missing claim', code: 'missing_params' }, 400);
  }

  let claim: SlackUserClaim;
  try {
    // decryptStringPBKDF2 throws on tampered/garbage ciphertext (AES-GCM
    // auth tag), so a parse failure here means the blob is not ours.
    claim = JSON.parse(await decryptStringPBKDF2(body.claim, c.env.ENCRYPTION_KEY)) as SlackUserClaim;
  } catch {
    return c.json({ error: 'Invalid claim', code: 'invalid_claim' }, 400);
  }
  if (claim.v !== 1 || typeof claim.userId !== 'string' || typeof claim.accessToken !== 'string') {
    return c.json({ error: 'Invalid claim', code: 'invalid_claim' }, 400);
  }
  if (typeof claim.exp !== 'number' || claim.exp < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'Claim expired', code: 'claim_expired' }, 400);
  }
  if (claim.userId !== user.id) {
    // The account-linking CSRF defense: a blob minted for another user's
    // flow is worthless in this session, no matter how it got here.
    return c.json({ error: 'Claim was issued for a different user', code: 'user_mismatch' }, 403);
  }

  const grantedScopes = Array.isArray(claim.grantedScopes) ? claim.grantedScopes : [];
  const slackUserId = claim.slackUserId || '';

  // Cross-user collision check: same Slack user already linked to a different
  // Valet user. Reconnect by the same user → upsert + refresh.
  const appDb = c.get('db');
  if (slackUserId) {
    const existing = await findExistingSlackUserLink(c.env, appDb, slackUserId);
    if (existing && existing.userId !== user.id) {
      return c.json({ error: 'Slack user already linked to another account', code: 'already_linked' }, 409);
    }
  }

  await storeCredential(
    c.env,
    'user',
    user.id,
    SLACK_USER_PROVIDER,
    { access_token: claim.accessToken },
    {
      credentialType: 'oauth2',
      scopes: grantedScopes.join(' '),
      metadata: {
        slack_user_id: slackUserId,
        team_id: claim.teamId || '',
        team_name: claim.teamName || '',
      },
    },
  );

  // Register the integration row. storeCredential only persists the token,
  // but the orchestrator enumerates its tool surface from the integrations
  // table (getUserIntegrations) — without a row here the slack_user.*
  // actions never appear in list_tools. Uses the atomic upsert
  // (`onConflictDoUpdate` on userId+service+scope) so concurrent claims
  // can't race into duplicate rows or a pending→active gap.
  //
  // If ensureIntegration fails (transient D1 error), roll back both the
  // credential and any pre-existing integration row so the tool surface
  // doesn't diverge from the credential state — listTools filters by
  // `status = active` alone, so a stale active row with no credential
  // would keep slack_user.* tools exposed and every call would fail.
  try {
    await db.ensureIntegration(appDb, user.id, SLACK_USER_PROVIDER, 'user', {
      entities: grantedScopes,
    });
  } catch (err) {
    console.error(`[slack-user] ensureIntegration failed for user=${user.id}:`, err);
    try {
      await revokeCredential(c.env, 'user', user.id, SLACK_USER_PROVIDER);
    } catch (revokeErr) {
      console.error(`[slack-user] rollback revokeCredential failed for user=${user.id}:`, revokeErr);
    }
    try {
      const existing = (await db.getUserIntegrations(appDb, user.id)).find(
        (i) => i.service === SLACK_USER_PROVIDER,
      );
      if (existing) await db.deleteIntegration(appDb, existing.id);
    } catch (delErr) {
      console.error(`[slack-user] rollback deleteIntegration failed for user=${user.id}:`, delErr);
    }
    return c.json({ error: 'Failed to register integration', code: 'integration_write_failed' }, 500);
  }

  return c.json({ linked: true, teamName: claim.teamName || null });
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
