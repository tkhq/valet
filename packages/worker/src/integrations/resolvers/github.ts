import { eq } from 'drizzle-orm';
import { getCredential } from '../../services/credentials.js';
import { getDb } from '../../lib/drizzle.js';
import type { AppDb } from '../../lib/drizzle.js';
import { getServiceMetadata } from '../../lib/db/service-configs.js';
import {
  getGithubInstallationByLogin,
  listGithubInstallationsByAccountType,
} from '../../lib/db/github-installations.js';
import { loadGitHubApp, getOrMintInstallationToken } from '../../services/github-app.js';
import { users } from '../../lib/schema/users.js';
import type { Env } from '../../env.js';
import type { CredentialResolver } from '../registry.js';
import type { CredentialResult } from '../../services/credentials.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';
import type { GithubInstallation } from '../../lib/schema/github-installations.js';

/**
 * GitHub credential resolver — unified App model.
 *
 * Resolution chain:
 * 1. User has a linked GitHub account (stored oauth2 credential)? → return user token
 * 2. Anonymous access allowed (metadata flag)? → if NO, fail with "not connected"
 * 3. If repo `owner` is specified → strict match against `github_installations` by account_login.
 *    No match → FAIL (do NOT fall through to "any installation")
 * 4. If no repo owner specified → use any active org installation (prefer Organization over User)
 * 5. No installation → fail
 *
 * Steps 3-4 mint an installation bot token via getOrMintInstallationToken (D1-cached)
 * and attach user attribution (name + email from the users table).
 */
export const githubCredentialResolver: CredentialResolver = async (
  service,
  env,
  userId,
  context,
) => {
  const { forceRefresh, params, credentialMode } = context;
  const db = getDb(env.DB);
  const owner = params?.owner as string | undefined;

  // The user's own linked OAuth token.
  const tryUser = () => getCredential(env, 'user', userId, service, { forceRefresh });

  // An org GitHub-App installation (bot) token. Gated by the anonymous-access
  // flag; owner-strict when a repo owner is supplied, else any active install
  // (Organization preferred). Returns a not_found error result when no usable
  // installation exists so callers can fall back.
  const tryApp = async (): Promise<CredentialResult> => {
    const meta = await getServiceMetadata<GitHubServiceMetadata>(db, 'github').catch(() => null);
    if (!meta?.allowAnonymousGitHubAccess) {
      return {
        ok: false as const,
        error: {
          service,
          reason: 'not_found' as const,
          // For the default (user-first) path this reads as the user's real
          // problem: they haven't linked their account. mode='app' rewrites it.
          message: 'GitHub not connected. Connect your GitHub account in Settings > Integrations.',
        },
      };
    }
    if (owner) {
      const installation = await getGithubInstallationByLogin(db, owner);
      if (!installation) {
        return {
          ok: false as const,
          error: { service, reason: 'not_found' as const, message: `No GitHub installation available for owner ${owner}` },
        };
      }
      return mintBotCredential(env, db, userId, installation);
    }
    const orgInstalls = await listGithubInstallationsByAccountType(db, 'Organization');
    if (orgInstalls.length > 0) return mintBotCredential(env, db, userId, orgInstalls[0]);
    const userInstalls = await listGithubInstallationsByAccountType(db, 'User');
    if (userInstalls.length > 0) return mintBotCredential(env, db, userId, userInstalls[0]);
    return {
      ok: false as const,
      error: { service, reason: 'not_found' as const, message: 'No GitHub installation available' },
    };
  };

  // credentialMode='app' → prefer the bot, fall back to the owner's own token
  // (so the option degrades gracefully where no App is installed). Default →
  // the owner's token, falling back to the org install (the pre-existing chain).
  if (credentialMode === 'app') {
    const appResult = await tryApp();
    if (appResult.ok) return appResult;
    const userResult = await tryUser();
    if (userResult.ok) return userResult;
    return {
      ok: false as const,
      error: {
        service,
        reason: 'not_found' as const,
        message: 'No GitHub App installation available and no personal GitHub credential to fall back to.',
      },
    };
  }

  const userResult = await tryUser();
  if (userResult.ok) return userResult;
  return tryApp();
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mintBotCredential(
  env: Env,
  db: AppDb,
  userId: string,
  installation: GithubInstallation,
) {
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false as const,
      error: {
        service: 'github',
        reason: 'not_found' as const,
        message: 'GitHub App is not configured. Ask an admin to set up the GitHub App in Settings.',
      },
    };
  }

  const { token, expiresAt } = await getOrMintInstallationToken(
    app,
    db,
    env.ENCRYPTION_KEY,
    {
      id: installation.id,
      githubInstallationId: installation.githubInstallationId,
      cachedTokenEncrypted: installation.cachedTokenEncrypted,
      cachedTokenExpiresAt: installation.cachedTokenExpiresAt,
    },
  );

  // Fetch user record for attribution
  const user = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  const attribution = user
    ? { name: user.name || user.email, email: user.email }
    : undefined;

  return {
    ok: true as const,
    credential: {
      accessToken: token,
      expiresAt: new Date(expiresAt),
      credentialType: 'app_install' as const,
      refreshed: false,
      attribution,
    },
  };
}
