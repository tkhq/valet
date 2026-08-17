/**
 * Resolves the repository reader one skill-sync run uses, from the source
 * row it is about to read. This is where the org/personal split is enforced:
 *
 *   - An ORG-scoped source may read through the org's GitHub App
 *     installation. Creating an org source already requires an org admin
 *     (`routes/skills.ts`), and the skills it imports are org-visible, so
 *     the App's reach — every repository the org installed it on — sits
 *     behind an admin action, never behind the general "add a repository"
 *     box.
 *   - A PERSONAL or TEAM source stays unauthenticated and can read public
 *     repositories only. GitHub repository permissions are per-user, and
 *     "the App can read it" says nothing about whether the person who added
 *     the source can.
 *
 * Token resolution goes through `resolveGitHubToken` with `auth: "app"` —
 * THE canonical path (see `services/github-tokens.ts`); no second path is
 * added here. A `GitHubAuthError` (no App configured, or no installation
 * for the repository's owner) is not a failure: the source falls back to
 * the public reader, so an org source tracking a public repository works
 * with no App at all. Any other error propagates, and skill sync records
 * it on the row with its normal backoff.
 */
import type { SkillSourceRow } from "../schema/index.js";
import { PublicSkillRepoReader, type SkillRepoReader } from "./skill-repo-reader.js";
import { GitHubAuthError, resolveGitHubToken, type GitHubTokenDeps } from "./github-tokens.js";

export interface SkillSourceReaderOptions {
  /** GitHub API base URL for the readers. Tests pass a fixture's URL. */
  apiUrl?: string;
}

export function skillSourceReaderProvider(
  deps: GitHubTokenDeps,
  opts: SkillSourceReaderOptions = {},
): (source: SkillSourceRow) => Promise<SkillRepoReader> {
  const publicReader = new PublicSkillRepoReader({ apiUrl: opts.apiUrl });
  return async (source) => {
    if (source.ownerType !== "org") return publicReader;
    const [owner = "", name = ""] = source.repoFullName.split("/");
    try {
      const { token } = await resolveGitHubToken(deps, {
        orgId: source.orgId,
        purpose: "api",
        auth: "app",
        repo: { owner, name },
      });
      // `auth: "app"` either returns an installation token or throws, but
      // the type keeps `token` nullable; treat null as "no App reach".
      if (token === null) return publicReader;
      return new PublicSkillRepoReader({ apiUrl: opts.apiUrl, token });
    } catch (err) {
      if (err instanceof GitHubAuthError) return publicReader;
      throw err;
    }
  };
}
