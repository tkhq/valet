// Repo authority for anything that lets the org's GitHub App act on a repo.
//
// The App installation token is the privilege being protected. It is installed
// org-wide, so "the App can reach the repo" says nothing about whether the
// person on whose behalf we are minting it may. Two kinds of caller need that
// question answered:
//
//   • Arming paths (POST /api/templates/:id/enable-app, the github-app branch
//     of POST/PATCH /api/triggers) prove it before the trigger exists, so a
//     trigger pointed at a repo the caller has no standing on never gets
//     created. `assertCallerCanAdministerRepo` is that check and it throws.
//
//   • The mint boundary itself — the GitHub credential resolver, whenever a
//     tool node asks for `credential: 'app'`. This is the control that actually
//     makes the token unreachable: a workflow node can request App credentials
//     with no trigger involved at all, so a per-route check alone is bypassable
//     by construction. `assertExecutionCanUseAppForRepo` is that check; it
//     returns a verdict rather than throwing, and memoizes per
//     (userId, owner, repo) so a workflow running many nodes against one repo
//     does not pay a GitHub round-trip each time.
//
// The proof deliberately uses the identity's OWN linked GitHub OAuth token,
// never the App installation token: an installation token can read every repo
// the App covers, so using it here would answer the wrong question.

import { ForbiddenError, ValidationError } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { getGithubInstallationByLogin } from '../lib/db/github-installations.js';
import { getCredential } from './credentials.js';

/** GitHub repo permissions block returned by GET /repos/{owner}/{repo}. */
interface RepoPermissions {
  push?: boolean;
  admin?: boolean;
  maintain?: boolean;
  triage?: boolean;
  pull?: boolean;
}

/**
 * Why a repo-authority evaluation came out the way it did. `unreachable` is the
 * only transient one — it is never cached, because a network blip must not pin
 * a denial for the whole TTL.
 */
type AuthorityOutcome =
  | 'allowed'
  | 'no_installation'
  | 'no_identity'
  | 'no_access'
  | 'no_write'
  | 'unreachable';

interface AuthorityVerdict {
  outcome: AuthorityOutcome;
  message: string;
}

const ALLOWED: AuthorityVerdict = { outcome: 'allowed', message: '' };

/**
 * The single evaluation: is the App installed on `owner`, and does `userId`
 * personally hold push or admin rights on `owner/repo`?
 *
 * Fails closed. No linked GitHub identity, a repo GitHub won't show the
 * identity (404), a refused read (403), an unexpected API status, or read-only
 * rights all deny. A 404 is indistinguishable from "private repo the caller
 * can't see", which is exactly the case this guards, so it is a refusal.
 */
async function evaluateRepoAuthority(
  db: AppDb,
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<AuthorityVerdict> {
  // Coverage: without an installation on the owner the App can neither deliver
  // events nor act, so there is nothing to authorize.
  const installation = await getGithubInstallationByLogin(db, owner);
  if (!installation) {
    return {
      outcome: 'no_installation',
      message: `The Valet GitHub App is not installed on "${owner}". Ask an admin to install it, then try again.`,
    };
  }

  const credential = await getCredential(env, 'user', userId, 'github');
  if (!credential.ok) {
    return {
      outcome: 'no_identity',
      message: `Connect your own GitHub account in Settings > Integrations before arming "${owner}/${repo}" — Valet verifies your access to the repository, not the App's.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        Authorization: `Bearer ${credential.credential.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    });
  } catch (err) {
    return {
      outcome: 'unreachable',
      message: `Could not verify your access to "${owner}/${repo}" (GitHub unreachable: ${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  if (!res.ok) {
    // 404 and 403 are the same answer from Valet's side: GitHub will not
    // confirm this identity can see the repository.
    return {
      outcome: 'no_access',
      message: `You do not have access to "${owner}/${repo}" (GitHub returned ${res.status}). Only someone with write access to the repository can arm it.`,
    };
  }

  const body = (await res.json().catch(() => null)) as { permissions?: RepoPermissions } | null;
  const permissions = body?.permissions;
  if (!permissions || !(permissions.push === true || permissions.admin === true)) {
    return {
      outcome: 'no_write',
      message: `You need write access to "${owner}/${repo}" to arm it for review.`,
    };
  }

  return ALLOWED;
}

/**
 * Reject unless the App is installed on `owner` AND the caller personally has
 * push or admin rights on `owner/repo`. Used by the arming routes, where the
 * right answer to a denial is an HTTP error.
 */
export async function assertCallerCanAdministerRepo(
  db: AppDb,
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<void> {
  const verdict = await evaluateRepoAuthority(db, env, userId, owner, repo);
  if (verdict.outcome === 'allowed') return;
  // A missing installation is a setup problem, not an authorization one, and
  // has always surfaced as a 400.
  if (verdict.outcome === 'no_installation') throw new ValidationError(verdict.message);
  throw new ForbiddenError(verdict.message);
}

// ── Mint-boundary check ──────────────────────────────────────────────────────

/**
 * How long a decided verdict is reused. Short enough that revoking someone's
 * repo access takes effect within a minute (this is also what re-validates
 * authority on every delivery, not just at arming time), long enough that a
 * workflow with several GitHub nodes costs one GitHub call rather than one per
 * node.
 */
const AUTHORITY_TTL_MS = 60_000;

/** Bound so a long-lived isolate can't accumulate entries without limit. */
const AUTHORITY_CACHE_MAX = 500;

interface CacheEntry {
  verdict: AuthorityVerdict;
  expiresAt: number;
}

const authorityCache = new Map<string, CacheEntry>();

/** Test seam — the cache is process-global, so suites must be able to clear it. */
export function __resetRepoAuthorityCache(): void {
  authorityCache.clear();
}

/**
 * The mint-boundary check: may the identity this execution runs as (the
 * workflow owner / `trigger.user_id`) have the App act on `owner/repo`?
 *
 * Returns a verdict instead of throwing because the caller is a credential
 * resolver, which reports failures as a `CredentialResult`. Denials are cached
 * exactly like grants — the cache is an optimization over a check that already
 * failed closed, so a cached denial is still a denial.
 */
export async function assertExecutionCanUseAppForRepo(
  db: AppDb,
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // `/` is safe as a separator: GitHub logins and repo names cannot contain one.
  const key = `${userId}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const now = Date.now();
  const cached = authorityCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.verdict.outcome === 'allowed'
      ? { ok: true }
      : { ok: false, message: cached.verdict.message };
  }

  const verdict = await evaluateRepoAuthority(db, env, userId, owner, repo);

  // Never cache a transient failure: a momentary network fault would otherwise
  // deny a legitimate workflow for the rest of the TTL.
  if (verdict.outcome !== 'unreachable') {
    if (authorityCache.size >= AUTHORITY_CACHE_MAX) authorityCache.clear();
    authorityCache.set(key, { verdict, expiresAt: now + AUTHORITY_TTL_MS });
  }

  return verdict.outcome === 'allowed' ? { ok: true } : { ok: false, message: verdict.message };
}
