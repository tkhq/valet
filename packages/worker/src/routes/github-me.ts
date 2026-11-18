import { Hono } from 'hono';
import { Octokit } from 'octokit';
import type { Env, Variables } from '../env.js';
import { storeCredential } from '../services/credentials.js';
import { reconcileUserInstallations } from '../services/github-installations.js';
import { openGitHubLinkClaim } from '../services/github-link-claim.js';
import { signJWT } from '../lib/jwt.js';
import { getGitHubConfig, getGitHubMetadata } from '../services/github-config.js';
import { loadGitHubApp } from '../services/github-app.js';
import { deleteCredential } from '../lib/db/credentials.js';
import { listGithubInstallationsByUser } from '../lib/db/github-installations.js';
import * as db from '../lib/db.js';

// ─── Authenticated Router (mounted at /api/me/github) ──────────────────────

export const githubMeRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — Get user's GitHub status
 */
githubMeRouter.get('/', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  // Check if the GitHub App is configured and load metadata
  const ghConfig = await getGitHubConfig(c.env, appDb);
  const metadata = ghConfig ? await getGitHubMetadata(appDb) : null;

  // Get user's GitHub identity link
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const githubLink = identityLinks.find((l) => l.provider === 'github');

  // Get user record for GitHub info
  const userRecord = await db.getUserById(appDb, user.id);

  // Get user's GitHub App installations
  const userInstallations = await listGithubInstallationsByUser(appDb, user.id);

  return c.json({
    configured: !!ghConfig,
    appSlug: ghConfig?.appSlug ?? null,
    settings: {
      allowPersonalInstallations: metadata?.allowPersonalInstallations ?? true,
      allowAnonymousGitHubAccess: metadata?.allowAnonymousGitHubAccess ?? true,
    },
    personal: {
      linked: !!githubLink,
      githubUsername: userRecord?.githubUsername ?? githubLink?.externalName ?? null,
      githubId: userRecord?.githubId ?? githubLink?.externalId ?? null,
      email: userRecord?.email ?? null,
      avatarUrl: userRecord?.avatarUrl ?? null,
    },
    installations: userInstallations,
  });
});

/**
 * POST /link — Initiate GitHub OAuth linking via App OAuth
 */
githubMeRouter.post('/link', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  const app = await loadGitHubApp(c.env, appDb);
  if (!app) return c.json({ error: 'GitHub App not configured' }, 400);

  // Create signed JWT state token (10 min expiry)
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, purpose: 'github-link', sid: crypto.randomUUID(), iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  const workerOrigin = c.env.API_PUBLIC_URL || new URL(c.req.url).origin;
  const { url } = app.oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${workerOrigin}/auth/github/callback`,
  });

  return c.json({ redirectUrl: url });
});

/**
 * POST /link/claim — Finish linking with the claim the OAuth callback issued.
 * The claim names the user who started the flow; only that user can redeem it.
 */
githubMeRouter.post('/link/claim', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  const body = await c.req.json<{ claim?: unknown }>().catch(() => ({ claim: undefined }));
  if (typeof body.claim !== 'string' || !body.claim) {
    return c.json({ error: 'Missing claim', code: 'missing_params' }, 400);
  }
  const opened = await openGitHubLinkClaim(body.claim, c.env.ENCRYPTION_KEY, user.id);
  if (!opened.ok) {
    return c.json({ error: 'Cannot complete GitHub linking', code: opened.code }, opened.status);
  }
  const { claim } = opened;

  // Remove any existing link for this GitHub account, then any other GitHub
  // link this user holds (re-link).
  await db.deleteIdentityLinkByExternalId(appDb, 'github', claim.githubId);
  const existingLinks = await db.getUserIdentityLinks(appDb, user.id);
  const existingGithubLink = existingLinks.find((l) => l.provider === 'github');
  if (existingGithubLink) {
    await db.deleteIdentityLink(appDb, existingGithubLink.id, user.id);
  }

  await db.createIdentityLink(appDb, {
    id: crypto.randomUUID(),
    userId: user.id,
    provider: 'github',
    externalId: claim.githubId,
    externalName: claim.login,
  });

  const credentialData: Record<string, string> = { access_token: claim.accessToken };
  if (claim.refreshToken) credentialData.refresh_token = claim.refreshToken;
  await storeCredential(c.env, 'user', user.id, 'github', credentialData, {
    credentialType: 'oauth2',
    expiresAt: claim.expiresAt ?? undefined,
  });

  // Provision the integration so GitHub tools are discoverable.
  await db.ensureIntegration(appDb, user.id, 'github');

  try {
    await db.updateUserGitHub(appDb, user.id, {
      githubId: claim.githubId,
      githubUsername: claim.login,
      name: claim.name ?? undefined,
      avatarUrl: claim.avatarUrl ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE constraint failed') || message.includes('idx_users_github_id')) {
      return c.json({ error: 'GitHub account already linked', code: 'account_already_linked' }, 409);
    }
    throw err;
  }

  try {
    await reconcileUserInstallations(new Octokit({ auth: claim.accessToken }), appDb, user.id, claim.githubId);
  } catch (err) {
    console.warn('[github-me] Installation reconciliation failed:', err);
  }

  return c.json({ linked: true, githubUsername: claim.login });
});

/**
 * DELETE /link — Unlink GitHub identity
 */
githubMeRouter.delete('/link', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  // Delete identity link
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const githubLink = identityLinks.find((l) => l.provider === 'github');
  if (githubLink) {
    await db.deleteIdentityLink(appDb, githubLink.id, user.id);
  }

  // Delete the GitHub OAuth credential
  await deleteCredential(appDb, 'user', user.id, 'github', 'oauth2');

  // Clear githubId and githubUsername on user record
  await db.updateUserGitHub(appDb, user.id, {
    githubId: null,
    githubUsername: null,
  });

  return c.json({ success: true });
});
