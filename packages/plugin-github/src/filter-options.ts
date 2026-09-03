import type { FilterOption, FilterOptionContext, FilterOptionResolver } from "@valet/engine";
import { credentialSecret } from "@valet/engine";
import { Octokit } from "octokit";
import { resolveGithubApiUrl } from "./actions/api.js";

/**
 * Provider-populated filter-option resolvers for the GitHub plugin.
 *
 * The filter-options endpoint calls these when a user builds a subscription
 * filter whose field declares `options: { source }`. Each resolver reads the
 * org's stored GitHub credential from `ctx.credential`, lists the matching
 * options from the GitHub API, and maps them to `FilterOption[]`.
 *
 * A resolver never throws. A null credential or a failed request returns an
 * empty list — the picker turns that into a free-text fallback.
 */

/** Cap on API pages a resolver walks, so a large org cannot make one request
 * fan out without bound. Each page holds `PER_PAGE` items. */
const MAX_PAGES = 3;
const PER_PAGE = 100;
/** Cap on options returned, so the picker payload stays small. */
const MAX_OPTIONS = 100;

/** Reads the usable token from the org's stored GitHub credential. Returns
 * null when the org has no credential or no token. */
function tokenFrom(ctx: FilterOptionContext): string | null {
  const token = credentialSecret(ctx.credential);
  return typeof token === "string" && token.length > 0 ? token : null;
}

function octokitFor(token: string): Octokit {
  return new Octokit({ auth: token, baseUrl: resolveGithubApiUrl() });
}

/** Case-insensitive substring match against the typeahead query. An empty
 * query matches everything. */
function matchesQuery(value: string, q: string | undefined): boolean {
  if (!q) return true;
  return value.toLowerCase().includes(q.toLowerCase());
}

interface RepositoryRow {
  full_name?: unknown;
}

interface BranchRow {
  name?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `github.repos` — lists repositories the installation credential can see.
 *
 * Walks `GET /installation/repositories` up to `MAX_PAGES` pages, filters by
 * `ctx.q` against `full_name`, and maps each to `{ id, label }` on the
 * `owner/name` full name.
 */
const reposResolver: FilterOptionResolver = async (ctx) => {
  const token = tokenFrom(ctx);
  if (!token) return [];

  const octokit = octokitFor(token);
  const options: FilterOption[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await octokit.request("GET /installation/repositories", {
        per_page: PER_PAGE,
        page,
      });
      const rows = (res.data.repositories ?? []) as RepositoryRow[];
      for (const row of rows) {
        const fullName = str(row.full_name);
        if (!fullName || !matchesQuery(fullName, ctx.q)) continue;
        options.push({ id: fullName, label: fullName });
        if (options.length >= MAX_OPTIONS) return options;
      }
      if (rows.length < PER_PAGE) break;
    }
  } catch {
    // A missing scope or a revoked token is a normal, reportable outcome. The
    // picker turns an empty list into a free-text fallback.
    return [];
  }

  return options;
};

/**
 * `github.branches` — lists branches for the repo chosen in the `repo` filter.
 *
 * `dependsOn: ["repo"]`. Reads `ctx.deps.repo` as `owner/name`; returns [] when
 * it is absent or malformed, because a branch list means nothing without a
 * repo. Walks `GET /repos/{owner}/{repo}/branches` up to `MAX_PAGES` pages,
 * filters by `ctx.q` against the branch name, and maps each to `{ id, label }`
 * on the bare branch name.
 */
const branchesResolver: FilterOptionResolver = async (ctx) => {
  const token = tokenFrom(ctx);
  if (!token) return [];

  const repo = str(ctx.deps.repo);
  if (!repo) return [];
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return [];
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);

  const octokit = octokitFor(token);
  const options: FilterOption[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await octokit.request("GET /repos/{owner}/{repo}/branches", {
        owner,
        repo: name,
        per_page: PER_PAGE,
        page,
      });
      const rows = (res.data ?? []) as BranchRow[];
      for (const row of rows) {
        const branch = str(row.name);
        if (!branch || !matchesQuery(branch, ctx.q)) continue;
        options.push({ id: branch, label: branch });
        if (options.length >= MAX_OPTIONS) return options;
      }
      if (rows.length < PER_PAGE) break;
    }
  } catch {
    return [];
  }

  return options;
};

/** The GitHub plugin's filter-option resolvers, keyed by `options.source`. */
export const githubFilterOptionResolvers: Record<string, FilterOptionResolver> = {
  "github.repos": reposResolver,
  "github.branches": branchesResolver,
};
