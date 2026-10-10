/**
 * Whether GitHub lets other accounts install the org's GitHub App.
 *
 * A GitHub App is public or private. GitHub installs a private App only on
 * the account that owns it. Its `/apps/{slug}/installations/new` page then
 * lists only that owner, so a member who opens it cannot pick a personal
 * account. The manifest flow created private Apps until 2026-10-09, and a
 * deployment can bring a private App through `GITHUB_APP_*`. Valet showed
 * the personal-install link for both, and the link could not work. New
 * Apps are public again (as in the legacy stack), but an App created
 * earlier stays private until its owner changes it on GitHub.
 *
 * GitHub's `GET /apps/{slug}` answers without authentication only for a
 * public App. It returns 404 for a private App. This module reads that
 * answer and sends no credential on purpose: with an App JWT or a user
 * token, GitHub also answers for a private App, and the check means nothing.
 *
 * Results are cached per API host and slug, because `/integrations` reads
 * the org status on every visit and GitHub limits unauthenticated reads to
 * 60 an hour for each IP address. A definite answer lasts 10 minutes, so an
 * owner who makes the App public sees the link within 10 minutes. Any other
 * answer (a network error, a rate limit, a 5xx) is "unknown". It lasts one
 * minute, so an outage does not send one request for each page load.
 */
import type { GetGithubOrgStatusResponse } from "../wire/types.js";
import { githubAppInstallUrl, resolveGithubApiUrl } from "./github-env.js";

/** `unverifiable`: the server requires sign-in for every API read (a
 * private-mode GitHub Enterprise Server answers 401), so the check cannot
 * tell. github.com answers 200 or 404. */
export type GithubAppVisibility = "public" | "private" | "unverifiable" | "unknown";

const KNOWN_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 5_000;

const cache = new Map<string, { visibility: GithubAppVisibility; expiresAt: number }>();

export interface GithubAppVisibilityDeps {
  /** Overrides `resolveGithubApiUrl(env)`. */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Reads the App's visibility from GitHub, or from the cache. Never throws. */
export async function githubAppVisibility(
  appSlug: string,
  env: NodeJS.ProcessEnv,
  deps: GithubAppVisibilityDeps = {},
): Promise<GithubAppVisibility> {
  const apiUrl = deps.apiUrl ?? resolveGithubApiUrl(env);
  const now = deps.now ?? Date.now;
  const key = `${apiUrl}\n${appSlug}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.visibility;

  let visibility: GithubAppVisibility = "unknown";
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${apiUrl}/apps/${encodeURIComponent(appSlug)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Valet-App" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) visibility = "private";
    else if (res.status === 401) visibility = "unverifiable";
    else if (res.ok) visibility = "public";
  } catch (err) {
    console.error(`github app visibility: GET /apps/${appSlug} failed:`, err);
  }
  cache.set(key, { visibility, expiresAt: now() + (visibility === "unknown" ? UNKNOWN_TTL_MS : KNOWN_TTL_MS) });
  return visibility;
}

/** Test hook: forget every cached answer. */
export function resetGithubAppVisibilityCache(): void {
  cache.clear();
}

/** The org-status fields for a member's personal install. Call it only when
 * the org has an App and allows personal installations. The link is present
 * only when GitHub confirms the App is public and the member connected
 * GitHub through the App, as the legacy stack required. Valet binds the
 * installation to the member through that connection, so an installation
 * made first would serve nobody until the member connects. Otherwise the
 * reason is present. */
export async function personalInstallFields(
  appSlug: string,
  env: NodeJS.ProcessEnv,
  connected: boolean,
  deps: GithubAppVisibilityDeps = {},
): Promise<Pick<GetGithubOrgStatusResponse, "personalInstallUrl" | "personalInstallBlocked" | "personalInstallUnverified">> {
  switch (await githubAppVisibility(appSlug, env, deps)) {
    case "public":
      if (!connected) return { personalInstallBlocked: "github_not_connected" };
      return { personalInstallUrl: githubAppInstallUrl(env, appSlug) };
    case "unverifiable":
      // Hiding the link would end personal installs on such a server for
      // good. Show it, and say that GitHub may list only the owner.
      if (!connected) return { personalInstallBlocked: "github_not_connected" };
      return { personalInstallUrl: githubAppInstallUrl(env, appSlug), personalInstallUnverified: true };
    case "private":
      return { personalInstallBlocked: "app_private" };
    case "unknown":
      return { personalInstallBlocked: "app_visibility_unknown" };
  }
}
