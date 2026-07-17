/**
 * `RepoHost` port (GitHub/repo integration plan, Task 7, spec decision 8
 * verbatim) — the thin interface `GET /api/repos` (this task) and the
 * sandbox credential-helper route (Task 8) go through instead of reaching
 * into `services/github-tokens.ts`/`services/github-app.ts` directly. Only
 * one implementation exists today (`./github-host.ts`); `repoHostForUrl`
 * is the registry future providers (GitLab, Bitbucket, …) would extend.
 */
import type { CredentialStore } from "@valet/engine";
import type { RepoListItem } from "@valet/sdk/repos";
import type { AppQueryable } from "../lib/drizzle.js";
import { githubHost } from "./github-host.js";

export interface RepoHostDeps {
  db: AppQueryable;
  credentials: CredentialStore;
  /** AES-256-GCM key for `github_installations.cachedToken` — same wiring
   * `services/github-app.ts`'s `GithubAppDeps.key` uses. */
  key: Buffer;
  /** Overrides the provider's default API base URL. Tests point this at a
   * fixture server. */
  apiUrl?: string;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

export interface RepoHostContext {
  orgId: string;
  /** Absent for host-to-host calls with no signed-in user (none exist yet,
   * but the port doesn't assume one). */
  userId?: string;
  deps: RepoHostDeps;
}

export interface GitTokenRequest {
  owner: string;
  repo: string;
  purpose: "git" | "api";
  /** Defaults to `"auto"` — see `services/github-tokens.ts`'s resolution
   * contract doc comment for what each mode does. */
  auth?: "auto" | "app" | "user";
}

/**
 * Honest result shapes (spec decision 8's "pick honest shapes"):
 *
 *   - `{ token, username, source }` — a usable credential. `username` is the
 *     git Basic-Auth username to pair with `token` (GitHub App/installation
 *     tokens always use `"x-access-token"`; see `github-host.ts`).
 *     `source` is the provider's own tier name (e.g. `"installation"`,
 *     `"user"`, `"pat"`) — free-form per host, not a shared enum, since
 *     different hosts have different tiers.
 *   - `{ anonymous: true }` — the host resolved successfully but no
 *     credential applies (e.g. GitHub `auto` + `git` with nothing
 *     configured); callers should proceed tokenless (a public clone works,
 *     a private one surfaces the provider's own auth error downstream).
 *
 * `resolveGitToken` itself returns `null` (distinct from `{anonymous:true}`)
 * when the host could NOT resolve at all — e.g. an explicit `auth: "app"`/
 * `"user"` selection that has no eligible credential (`GitHubAuthError` in
 * the GitHub implementation). `null` means "this request cannot be
 * satisfied", not "proceed without a token".
 */
export type GitTokenResult = { token: string; username: string; source: string } | { anonymous: true };

export interface RepoHost {
  readonly id: string;
  /** Lists repos visible to `ctx` across every tier the host supports
   * (installation + personal + org-level, for GitHub). Never throws on a
   * partial upstream failure — see `github-host.ts`'s soft-degrade doc
   * comment; a host with nothing configured returns `[]`. */
  listRepos(ctx: RepoHostContext): Promise<RepoListItem[]>;
  /** Resolves a usable git/API credential for one `owner/repo`. See
   * `GitTokenResult`'s doc comment for the three-way result. */
  resolveGitToken(ctx: RepoHostContext, req: GitTokenRequest): Promise<GitTokenResult | null>;
}

const GITHUB_URL_PATTERN = /github\.com/;

/** Looks up the `RepoHost` for a clone URL. Only `github.com` is recognized
 * today (spec decision 8); `null` for anything else (unsupported provider —
 * callers treat that as "no host-mediated auth is available for this URL",
 * not an error). A second host (GitLab, Bitbucket, …) adds another
 * `pattern.test` branch here, not a new registration API — there's no
 * plugin-discovery need for a two-host list. */
export function repoHostForUrl(cloneUrl: string): RepoHost | null {
  if (GITHUB_URL_PATTERN.test(cloneUrl)) return githubHost;
  return null;
}
