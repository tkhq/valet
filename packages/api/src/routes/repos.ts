/**
 * `GET /api/repos` (GitHub/repo integration plan, Task 7) — any authed org
 * member. Delegates listing entirely to the `github` `RepoHost`
 * (`repos/github-host.ts`) via `repos/host.ts`'s port; this route only
 * adds the `connected`/`installed` summary flags and the soft-empty
 * default (no App configured, no personal connection → `{repos: [],
 * connected: false, installed: false}`, which just falls out of
 * `listRepos`/the flag queries below returning nothing — no special-cased
 * branch).
 *
 * `connected` and `installed` are deliberately NOT derived from the
 * `repos` array (a repo-less installation, or a healthy personal
 * credential with zero visible repos, would otherwise read as
 * disconnected) — each is its own direct check:
 *   - `connected`: the signed-in user has a healthy personal GitHub
 *     credential (`resolveUserApiToken`) — same health rules
 *     `services/github-tokens.ts` uses everywhere else.
 *   - `installed`: the org has at least one non-suspended
 *     `github_installations` row.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { githubInstallations } from "../schema/index.js";
import { resolveUserApiToken } from "../services/github-tokens.js";
import { githubHost } from "../repos/github-host.js";
import type { RepoHostContext } from "../repos/host.js";
import type { GetReposResponse } from "../wire/types.js";

export const reposRouter = new Hono<AppEnv>();

reposRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db, engineCredentials, encryptionKey } = c.var.providers;

  const ctx: RepoHostContext = {
    orgId: user.orgId,
    userId: user.id,
    deps: { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) },
  };

  const [repos, userToken, installationRows] = await Promise.all([
    githubHost.listRepos(ctx),
    resolveUserApiToken(ctx.deps, user.orgId, user.id),
    db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, user.orgId), eq(githubInstallations.suspended, false)))
      .limit(1),
  ]);

  const resp: GetReposResponse = {
    repos,
    connected: userToken !== null,
    installed: installationRows.length > 0,
  };
  return c.json(resp);
});
