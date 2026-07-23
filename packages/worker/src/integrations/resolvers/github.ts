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
import { assertExecutionCanUseAppForRepo } from '../../services/github-repo-authority.js';
import { users } from '../../lib/schema/users.js';
import type { Env } from '../../env.js';
import type { CredentialResolver } from '../registry.js';
import type { CredentialResult } from '../../services/credentials.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';
import type { GithubInstallation } from '../../lib/schema/github-installations.js';

/**
 * GitHub credential resolver — unified App model.
 *
 * credentialMode='app' → App-installation (bot) token ONLY; never falls back to
 *   the caller's personal token (an automation posting "as the bot" must not
 *   silently post as a person). Fails with an actionable message if unavailable.
 *   This branch is the mint boundary for the App privilege, so it first proves
 *   the identity the execution runs as holds push/admin on the owner/repo the
 *   action names — see assertExecutionCanUseAppForRepo. Anything reachable from
 *   a user-authored workflow node passes through here.
 * default → the user's linked OAuth token, falling back to an org App install
 *   (Organization preferred) when anonymous access is enabled. That fallback is
 *   reached only by a user with no linked GitHub identity at all — there is no
 *   personal token to check repo authority against — so it stays gated by the
 *   admin-set allowAnonymousGitHubAccess flag rather than by repo authority.
 *
 * App-install paths mint a bot token via getOrMintInstallationToken (D1-cached)
 * and attach user attribution (name + email from the users table). See the
 * inline comments below for the exact per-mode resolution order.
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
  const repo = params?.repo as string | undefined;

  // The user's own linked OAuth token.
  const tryUser = () => getCredential(env, 'user', userId, service, { forceRefresh });

  // An org GitHub-App installation (bot) token. Gated by the anonymous-access
  // flag; owner-strict when a repo owner is supplied, else any active install
  // (Organization preferred). Returns a not_found error result when no usable
  // installation exists so callers can fall back.
  const tryApp = async (): Promise<CredentialResult> => {
    // Total function: convert any failure (incl. a mint/JWT error from a
    // misconfigured App) into an ok:false result — app mode wraps it into the
    // 'ask an admin' message, and the default path's trailing `return tryApp()`
    // stays a value, not a throw. app mode does NOT fall back to the user token.
    try {
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
        return await mintBotCredential(env, db, userId, installation);
      }
      const orgInstalls = await listGithubInstallationsByAccountType(db, 'Organization');
      if (orgInstalls.length > 0) return await mintBotCredential(env, db, userId, orgInstalls[0]);
      const userInstalls = await listGithubInstallationsByAccountType(db, 'User');
      if (userInstalls.length > 0) return await mintBotCredential(env, db, userId, userInstalls[0]);
      return {
        ok: false as const,
        error: { service, reason: 'not_found' as const, message: 'No GitHub installation available' },
      };
    } catch (err) {
      return {
        ok: false as const,
        error: { service, reason: 'refresh_failed' as const, message: `GitHub App token unavailable: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  };

  // credentialMode='app' → the App installation (bot) token ONLY. No fallback
  // to the caller's personal token: an automation that says it posts as the
  // bot must never silently post as a person. If the App isn't installed or
  // the token can't be minted, the action fails with an actionable message.
  // Default mode → the owner's token, falling back to the org install (the
  // pre-existing "anonymous" chain).
  if (credentialMode === 'app') {
    // THE MINT BOUNDARY. Any tool node in any user-authored workflow can ask
    // for `credential: 'app'` — no trigger, no route, nothing else in the
    // path. So this is where the installation token has to be scoped to a
    // repository the execution's identity may actually speak for; a check on
    // the arming routes alone is bypassable by writing a workflow instead.
    //
    // Repo-scoped by construction: an App credential with no repository to
    // scope it to would be an org-wide token, which is the thing being
    // prevented, so a request that names no repo is refused rather than
    // granted the broader credential.
    if (!owner || !repo) {
      return {
        ok: false as const,
        error: {
          service,
          reason: 'not_found' as const,
          message:
            'GitHub App credentials are scoped to a single repository; this action did not specify owner and repo, so no App token can be issued for it.',
        },
      };
    }
    const authority = await assertExecutionCanUseAppForRepo(db, env, userId, owner, repo);
    if (!authority.ok) {
      return {
        ok: false as const,
        error: { service, reason: 'not_found' as const, message: authority.message },
      };
    }

    const appResult = await tryApp();
    if (appResult.ok) return appResult;
    return {
      ok: false as const,
      error: {
        service,
        reason: appResult.error.reason,
        message: `GitHub App credential unavailable (${appResult.error.message}). This action posts as the Valet App only — ask an admin to install the GitHub App on the repo owner and enable app access.`,
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
