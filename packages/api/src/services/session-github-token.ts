/**
 * Session-scoped GitHub token resolution (GH-T10 fix). Bridges an app
 * `session_repos` binding to the canonical `resolveGitHubToken` path so that
 * BOTH the live-agent `github` action path (`engine/host.ts`'s
 * `credentialResolver`) and the workflow tool-node path
 * (`plugins/action-invoker.ts`) share one binding-selection + resolution
 * helper instead of duplicating `ownerOf`/`repoOf`/`primaryRepoBinding`
 * (third-caller rule — extracted here now that host.ts is the third caller).
 */
import { eq } from "drizzle-orm";
import { isUsableGithubUserRow } from "./github-tokens.js";
import { credentialSecret, type StoredCredential } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { sessionRepos } from "../schema/index.js";
import {
  resolveGitHubToken,
  type GitHubAuthMode,
  type GitHubTokenDeps,
  type ResolvedGitHubToken,
} from "./github-tokens.js";

/**
 * `owner/repo` → `owner` (empty string when there is no `/`). The single
 * canonical splitter — the route (`routes/sandbox-git-credential.ts`) and
 * workspace prep (`engine/workspace-prep.ts`) import these rather than keeping
 * their own copies (third-caller rule).
 */
export function ownerOf(fullName: string): string {
  const idx = fullName.indexOf("/");
  return idx === -1 ? "" : fullName.slice(0, idx);
}

/** `owner/repo` → `repo` (empty string when there is no `/`). */
export function repoOf(fullName: string): string {
  const idx = fullName.indexOf("/");
  return idx === -1 ? "" : fullName.slice(idx + 1);
}

/**
 * The session's primary (position-0) repo binding translated into
 * `resolveGitHubToken`'s `repo`/`auth` request shape, or `undefined` when the
 * session has no bindings — the caller then resolves with `auto` precedence
 * and no repo, same as an unbound session.
 */
export async function primaryRepoBinding(
  db: AppQueryable,
  sessionId: string,
): Promise<{ repo: { owner: string; name: string }; auth: GitHubAuthMode } | undefined> {
  const rows = await db
    .select()
    .from(sessionRepos)
    .where(eq(sessionRepos.sessionId, sessionId))
    .orderBy(sessionRepos.position)
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { repo: { owner: ownerOf(row.fullName), name: repoOf(row.fullName) }, auth: row.auth };
}

/**
 * Whether a stored `github` row can back an API call: it carries a secret
 * and is neither identity-only (sign-in scopes, no repo access) nor marked
 * by a failed refresh, or expired without a refresh token. The same rule `resolveGitHubToken`
 * applies to a user row, so a team row is held to the user row's bar. A
 * row that fails here is skipped, and the caller falls through to the App.
 */
export function isUsableGithubRow(row: StoredCredential | null | undefined): row is StoredCredential {
  if (!row) return false;
  // One health rule for a GitHub user row everywhere it is read: the same
  // predicate `resolveUserCredential` and the delegate route apply.
  return isUsableGithubUserRow(
    {
      accessToken: credentialSecret(row),
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      metadata: row.metadata,
    },
    Date.now(),
  );
}

/**
 * GitHub token args for a session owner. A user principal keeps `userId`
 * so their PAT or App-OAuth can win. A team or org principal omits `userId`
 * and always selects `auth: "app"`, so only an installation token can back
 * the run: never a member credential, and never the org PAT row, because
 * `github` declares no org credential. With a repo the App must be
 * installed on that repo's owner. Without one, the org's sole installation
 * is used. Either miss is a `GitHubAuthError` that names the install step.
 * The team's own `github` row, when it holds one, is read BEFORE these args
 * apply (`engine/host.ts`, `plugins/action-invoker.ts`); this is the
 * fallback behind it.
 */
export function githubTokenArgsForOwner(
  owner: { type: string; id: string },
  orgId: string,
  sessionId: string,
  knownRepo?: { owner: string; name: string },
): {
  orgId: string;
  sessionId: string;
  purpose: "api";
  userId?: string;
  auth?: GitHubAuthMode;
  repo?: { owner: string; name: string };
} {
  if (owner.type === "user") {
    return { orgId, userId: owner.id, sessionId, purpose: "api" };
  }
  if (knownRepo) {
    return { orgId, sessionId, purpose: "api", auth: "app", repo: knownRepo };
  }
  return { orgId, sessionId, purpose: "api", auth: "app" };
}

/**
 * Resolve a GitHub token for a session: loads the session's primary repo
 * binding (when `sessionId` is given and the session has one) and calls
 * `resolveGitHubToken` with the binding's `repo`/`auth`, falling back to
 * repo-less `auto` resolution otherwise. A `GitHubAuthError` from
 * `resolveGitHubToken` propagates to the caller unchanged.
 *
 * `auth` and `repo` are caller-supplied overrides that OUTRANK the binding.
 * A workflow `tool` node with `credential: "app"` uses them: it has no
 * session binding to read a selection from, and the repository comes from
 * the action's own parameters. Omit both to keep the binding-derived
 * behavior.
 */
export async function resolveSessionGitHubToken(
  deps: GitHubTokenDeps,
  args: {
    orgId: string;
    userId?: string;
    sessionId?: string;
    purpose: "git" | "api";
    auth?: GitHubAuthMode;
    repo?: { owner: string; name: string };
  },
): Promise<ResolvedGitHubToken> {
  const binding = args.sessionId ? await primaryRepoBinding(deps.db, args.sessionId) : undefined;
  return resolveGitHubToken(deps, {
    orgId: args.orgId,
    userId: args.userId,
    purpose: args.purpose,
    repo: args.repo ?? binding?.repo,
    auth: args.auth ?? binding?.auth ?? "auto",
  });
}
