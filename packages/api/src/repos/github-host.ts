/**
 * `RepoHost` implementation over GitHub (GitHub/repo integration plan,
 * Task 7) — the only host `repos/host.ts`'s `repoHostForUrl` resolves
 * today. Built entirely on Tasks 3-4's services; does not call the GitHub
 * API directly for anything token-related (`services/github-app.ts`'s
 * `mintInstallationToken`, `services/github-tokens.ts`'s
 * `resolveGitHubToken`/`resolveUserApiToken`/`resolveOrgPatApiToken` are
 * the only credential paths used here).
 *
 * ── `mapGitHubRepo` provenance ───────────────────────────────────────────
 * Copied (not imported) from `packages/plugin-github/src/repo-shared.ts`.
 * That file has no `./repo-shared` entry in `plugin-github`'s package
 * `exports` map (only `./actions`, `./repo`, `./plugin` are public) — a
 * deep import would bypass the package boundary. The mapper itself is 14
 * lines with zero dependencies, so copying it here (typed, unlike the
 * original's `r: any`) is cheaper than adding a new export surface to
 * `plugin-github` for one non-exported helper. If it drifts from the
 * original, that's a signal the two packages should share it via a real
 * export instead.
 *
 * ── Listing: union + dedupe + sort ───────────────────────────────────────
 * `listRepos` unions two sources:
 *   - Installation repos: `GET {api}/installation/repositories` once per
 *     non-suspended `github_installations` row for the org, each minted via
 *     `mintInstallationToken`. Sets `installed: true`.
 *   - User/org-PAT repos: `GET {api}/user/repos?affiliation=owner,
 *     collaborator,organization_member&sort=updated&per_page=100`, using
 *     the signed-in user's healthy credential (`resolveUserApiToken`) when
 *     present, else the org's healthy pasted PAT (`resolveOrgPatApiToken`)
 *     — mirrors `resolveGitHubToken`'s `auto`+`api` tier ordering (user
 *     before org PAT), just without the installation/throw tiers that
 *     don't apply to listing.
 * Deduped by `fullName`; an installation-sourced repo wins a collision
 * (keeps `installed: true`) over the same repo surfacing via the user/PAT
 * source. Sorted by `updatedAt` descending (falls back to string `""` for
 * a missing timestamp, sorting it last).
 *
 * ── Pagination cap (documented, not exhaustive) ──────────────────────────
 * Both listing calls fetch exactly one page (`per_page=100`, no `Link`
 * header following, unlike `github-app.ts`'s `fetchAllInstallations`). An
 * org/user with more than 100 repos in a single source will not see the
 * overflow. Acceptable for a repo picker at today's scale; revisit with
 * real pagination (or a search-driven picker) if this becomes a complaint.
 *
 * ── Soft-degrade on upstream failure ─────────────────────────────────────
 * Every GitHub API call in `listRepos` (per-installation mint + fetch, the
 * user/PAT fetch) is individually try/caught and logged — a single failing
 * installation or a down GitHub API does not fail the whole listing; it
 * just omits that source's repos. `GET /api/repos` (routes/repos.ts) can
 * therefore always return 200 with whatever succeeded.
 */
import { and, eq } from "drizzle-orm";
import type { RepoListItem } from "@valet/sdk/repos";
import { githubInstallations } from "../schema/index.js";
import { resolveGithubApiUrl } from "../services/github-env.js";
import { mintInstallationToken, type GithubAppDeps } from "../services/github-app.js";
import {
  resolveGitHubToken,
  resolveOrgPatApiToken,
  resolveUserApiToken,
  GitHubAuthError,
  type GitHubTokenDeps,
} from "../services/github-tokens.js";
import type { GitTokenRequest, GitTokenResult, RepoHost, RepoHostContext } from "./host.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Raw shape of a GitHub API repo object — just the fields `mapGitHubRepo`
 * reads. Not exhaustive of GitHub's actual response. */
interface RawGitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  language: string | null;
}

function isRawGitHubRepo(value: unknown): value is RawGitHubRepo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.name === "string" &&
    typeof value.full_name === "string" &&
    typeof value.html_url === "string" &&
    typeof value.clone_url === "string" &&
    typeof value.default_branch === "string" &&
    typeof value.private === "boolean"
  );
}

/** See the module doc comment's "`mapGitHubRepo` provenance" section —
 * copied from `packages/plugin-github/src/repo-shared.ts`, typed. */
function mapGitHubRepo(r: RawGitHubRepo): RepoListItem {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    private: r.private,
    description: r.description ?? null,
    updatedAt: r.updated_at,
    language: r.language ?? null,
  };
}

function toTokenDeps(ctx: RepoHostContext): GitHubTokenDeps {
  return {
    db: ctx.deps.db,
    credentials: ctx.deps.credentials,
    key: ctx.deps.key,
    apiUrl: ctx.deps.apiUrl,
    fetchImpl: ctx.deps.fetchImpl,
    now: ctx.deps.now,
  };
}

function apiUrlOf(ctx: RepoHostContext): string {
  return ctx.deps.apiUrl ?? resolveGithubApiUrl(process.env);
}

function fetchOf(ctx: RepoHostContext): typeof fetch {
  return ctx.deps.fetchImpl ?? fetch;
}

async function fetchRepoPage(
  ctx: RepoHostContext,
  path: string,
  token: string,
): Promise<RawGitHubRepo[] | null> {
  let res: Response;
  try {
    res = await fetchOf(ctx)(`${apiUrlOf(ctx)}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App",
      },
    });
  } catch (err) {
    console.error(`github-host: GET ${path} request failed:`, err);
    return null;
  }
  if (!res.ok) {
    console.error(`github-host: GET ${path} returned ${res.status}`);
    return null;
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    console.error(`github-host: GET ${path} returned unparseable JSON:`, err);
    return null;
  }
  // `GET /installation/repositories` wraps the array in `{ repositories }`;
  // `GET /user/repos` returns the array directly.
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.repositories)
      ? payload.repositories
      : null;
  if (!list) {
    console.error(`github-host: GET ${path} returned an unexpected shape`);
    return null;
  }
  return list.filter(isRawGitHubRepo);
}

async function listInstallationRepos(ctx: RepoHostContext): Promise<RepoListItem[]> {
  const appDeps: GithubAppDeps = {
    db: ctx.deps.db,
    credentials: ctx.deps.credentials,
    key: ctx.deps.key,
    apiUrl: ctx.deps.apiUrl,
    fetchImpl: ctx.deps.fetchImpl,
    now: ctx.deps.now,
  };
  const rows = await ctx.deps.db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, ctx.orgId), eq(githubInstallations.suspended, false)));

  const items: RepoListItem[] = [];
  for (const row of rows) {
    let token: string | null;
    try {
      token = await mintInstallationToken(appDeps, ctx.orgId, row.accountLogin);
    } catch (err) {
      console.error(`github-host: minting installation token for ${row.accountLogin} failed:`, err);
      continue;
    }
    if (!token) continue;
    const repos = await fetchRepoPage(ctx, "/installation/repositories?per_page=100", token);
    if (!repos) continue;
    for (const r of repos) items.push(mapGitHubRepo(r));
  }
  return items;
}

async function listUserOrPatRepos(ctx: RepoHostContext): Promise<RepoListItem[]> {
  const deps = toTokenDeps(ctx);
  const userToken = await resolveUserApiToken(deps, ctx.orgId, ctx.userId);
  const token = userToken ?? (await resolveOrgPatApiToken(deps, ctx.orgId));
  if (!token) return [];
  const repos = await fetchRepoPage(
    ctx,
    "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
    token.token,
  );
  return repos ? repos.map(mapGitHubRepo) : [];
}

function updatedAtKey(item: RepoListItem): string {
  return item.updatedAt ?? "";
}

export const githubHost: RepoHost = {
  id: "github",

  async listRepos(ctx: RepoHostContext): Promise<RepoListItem[]> {
    const [installationRepos, userOrPatRepos] = await Promise.all([
      listInstallationRepos(ctx),
      listUserOrPatRepos(ctx),
    ]);

    const byFullName = new Map<string, RepoListItem & { installed?: boolean }>();
    // Installation repos first — they win the dedupe below.
    for (const repo of installationRepos) {
      byFullName.set(repo.fullName, { ...repo, installed: true });
    }
    for (const repo of userOrPatRepos) {
      if (byFullName.has(repo.fullName)) continue;
      byFullName.set(repo.fullName, repo);
    }

    return [...byFullName.values()].sort((a, b) => updatedAtKey(b).localeCompare(updatedAtKey(a)));
  },

  async resolveGitToken(ctx: RepoHostContext, req: GitTokenRequest): Promise<GitTokenResult | null> {
    const deps = toTokenDeps(ctx);
    let resolved;
    try {
      resolved = await resolveGitHubToken(deps, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        purpose: req.purpose,
        repo: { owner: req.owner, name: req.repo },
        auth: req.auth,
      });
    } catch (err) {
      if (err instanceof GitHubAuthError) return null;
      throw err;
    }

    if (resolved.token === null) return { anonymous: true };
    // Git Basic-Auth username: GitHub ignores it for token auth, but
    // `x-access-token` is the documented convention for both installation
    // and OAuth/PAT tokens — see GitHub's own clone-with-a-token docs.
    const username = req.purpose === "git" ? "x-access-token" : (resolved.login ?? "x-access-token");
    return { token: resolved.token, username, source: resolved.source };
  },
};
