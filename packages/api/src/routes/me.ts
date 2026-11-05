/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Returns `MeResponse` with user profile and org membership info.
 * A team `vlt_` key gets the team (`TeamMeResponse`), never the creating
 * admin: `valet login` verifies a key through this route, and the CLI
 * reads the team id off the answer.
 *
 * `GET` joins `users` with `org_members` for `orgRole` — a caller with no
 * membership row (shouldn't happen outside tests, but the query doesn't
 * assume it) reads as `"member"`.
 *
 * `PATCH` accepts a strict whitelist (`name`, `avatarUrl`, `defaultModel`,
 * `defaultReasoning`, `newThreadBehavior`, `timezone`);
 * any other key 400s rather than being silently ignored, so a typo'd field
 * name in a client doesn't quietly no-op. `defaultModel` (when non-null) is
 * validated against the org model catalog's active id set — the same set
 * `/api/models` reports (bare Anthropic ids remain valid back-compat, see
 * `services/model-catalog.ts`'s `catalogValidIds`) — and `null` clears the
 * override back to the host default. `defaultReasoning` follows the same
 * null-clears pattern.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requirePrincipal, requireUser } from "../middleware/auth.js";
import { getTeamInOrg } from "../services/teams.js";
import type { GetMeResponse, TeamMeResponse } from "../wire/types.js";
import { threadProjectsRouter } from "./thread-projects.js";
import { loadAccountSettings, patchAccountSettings } from "../services/account-settings.js";

export const meRouter = new Hono<AppEnv>();
meRouter.route("/thread-projects", threadProjectsRouter);

meRouter.get("/", async (c) => {
  const user = requireUser(c);
  const principal = requirePrincipal(c);
  if (!user || !principal) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;
  if (principal.type === "team") {
    // The ladder checked the team exists in this org; a delete can still
    // land between the ladder and here, and then the key is invalid.
    const team = await getTeamInOrg(db, user.orgId, principal.id);
    if (!team) return c.json({ error: "invalid api key" }, 401);
    const body: TeamMeResponse = { id: team.id, name: team.name, orgId: user.orgId, role: "team" };
    return c.json(body);
  }
  const body: GetMeResponse | undefined = await loadAccountSettings(db, user);
  if (!body) return c.json({ error: "user not found" }, 404);
  return c.json(body);
});

meRouter.patch("/", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON object, e.g. {\"name\": \"...\"}." }, 400);
  }
  const body = await patchAccountSettings(db, c.var.providers.engineCredentials, user, parsed);
  if ("error" in body) return c.json(body, body.error === "user not found" ? 404 : 400);
  return c.json(body);
});
