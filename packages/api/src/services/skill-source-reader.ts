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
  /** Sink for the org-source fallback notice. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export function skillSourceReaderProvider(
  deps: GitHubTokenDeps,
  opts: SkillSourceReaderOptions = {},
): (source: SkillSourceRow) => Promise<SkillRepoReader> {
  // ONE reader for every unauthenticated source. Intentional: the reader is
  // immutable (URL, transport, timeout, and the absent token are all fixed
  // at construction), so sources cannot observe each other through it. A
  // reader that grows per-source state must stop being shared here.
  const publicReader = new PublicSkillRepoReader({ apiUrl: opts.apiUrl });
  const log = opts.log ?? console.warn;
  // An org source with no App reach falls back BY DESIGN (a public
  // repository needs no App), so the fallback logs once per source and
  // again only when its reason changes — not on all of a 15-minute poll's
  // repeats. Without this line, a misconfigured App (installed, but not on
  // this repository's owner) reads exactly like "no App" in the logs.
  const loggedFallbacks = new Map<string, string>();
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
      loggedFallbacks.delete(source.id);
      return new PublicSkillRepoReader({ apiUrl: opts.apiUrl, token });
    } catch (err) {
      if (err instanceof GitHubAuthError) {
        if (loggedFallbacks.get(source.id) !== err.message) {
          loggedFallbacks.set(source.id, err.message);
          log(
            `skill sync ${source.id}: reading ${source.repoFullName} unauthenticated — ${err.message}`,
          );
        }
        return publicReader;
      }
      throw err;
    }
  };
}
