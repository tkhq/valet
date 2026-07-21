// Repo-authority preconditions for arming a GitHub App automation on a repo.
//
// Arming a `github-app` trigger points the org's App installation at
// `owner/repo` and lets the resulting workflow read that repo's diffs and write
// to it under the App identity. The App is installed org-wide, so "the App can
// reach the repo" says nothing about whether the CALLER may. Both arming paths
// (POST /api/templates/:id/enable-app and the github-app branch of
// POST /api/triggers) therefore have to prove the caller themselves has write
// access to the repo before the trigger exists.
//
// The proof deliberately uses the CALLER'S OWN linked GitHub OAuth token, never
// the App installation token: an installation token can read every repo the App
// covers, so using it here would answer the wrong question.

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
 * Reject unless the App is installed on `owner` AND the caller personally has
 * push or admin rights on `owner/repo`.
 *
 * Fails closed: no linked GitHub identity, a repo GitHub won't show the caller
 * (404), a refused read (403), an unexpected API status, or read-only rights
 * all reject. A 404 is indistinguishable from "private repo the caller can't
 * see", which is exactly the case this guards, so it is treated as a refusal.
 */
export async function assertCallerCanAdministerRepo(
  db: AppDb,
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<void> {
  // Coverage: without an installation on the owner the App can neither deliver
  // events nor act, so the trigger would be dead on arrival.
  const installation = await getGithubInstallationByLogin(db, owner);
  if (!installation) {
    throw new ValidationError(
      `The Valet GitHub App is not installed on "${owner}". Ask an admin to install it, then try again.`,
    );
  }

  const credential = await getCredential(env, 'user', userId, 'github');
  if (!credential.ok) {
    throw new ForbiddenError(
      `Connect your own GitHub account in Settings > Integrations before arming "${owner}/${repo}" — Valet verifies your access to the repository, not the App's.`,
    );
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
    throw new ForbiddenError(
      `Could not verify your access to "${owner}/${repo}" (GitHub unreachable: ${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  if (!res.ok) {
    // 404 and 403 are the same answer from Valet's side: GitHub will not
    // confirm this caller can see the repository.
    throw new ForbiddenError(
      `You do not have access to "${owner}/${repo}" (GitHub returned ${res.status}). Only someone with write access to the repository can arm it.`,
    );
  }

  const body = (await res.json().catch(() => null)) as { permissions?: RepoPermissions } | null;
  const permissions = body?.permissions;
  if (!permissions || !(permissions.push === true || permissions.admin === true)) {
    throw new ForbiddenError(
      `You need write access to "${owner}/${repo}" to arm it for review.`,
    );
  }
}
