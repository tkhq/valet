/**
 * `/api/onepassword` — the org and personal service-account tokens for the
 * 1Password credential feature, plus one probe.
 *
 * `GET /settings` reports whether the org token and the caller's own
 * personal token are connected. `GET /vaults` lists the vaults a scope's
 * token can read; it is the live check that a token works and the route the
 * SDK-over-HTTP regression test drives. `scope=org` is open to any member
 * once the org token is connected (the token is shared org-wide by design;
 * scope the service account to a dedicated vault in 1Password to limit it).
 * `scope=personal` needs only the caller's own token, which the service
 * checks when it resolves one.
 *
 * A typed `OnePasswordAuthError` maps to 400 with its own message; any other
 * rejection maps to 502 so SDK or network detail never reaches the client.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { credentials } from "../schema/index.js";
import { canAdministerTeam, canViewTeam, getTeamInOrg } from "../services/teams.js";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { ONEPASSWORD_SERVICE, type OnePasswordScope } from "../services/onepassword.js";
import { mapOnePasswordError } from "./_onepassword-errors.js";
import type {
  ListOpVaultsResponse,
  TeamOnePasswordStatusResponse,
  OnePasswordSettingsResponse,
} from "../wire/types.js";

export const onePasswordRouter = new Hono<AppEnv>();


function scopeFromQuery(c: Context<AppEnv>): OnePasswordScope | null {
  const raw = c.req.query("scope");
  if (raw === undefined) return "personal";
  return raw === "org" || raw === "personal" || raw === "team" ? raw : null;
}

/**
 * Route-level gate shared by the vault/item browse endpoints: `scope=org`
 * is open to any authed org member (the org service-account token is
 * intentionally shared — see this file's doc comment); `scope=personal`
 * needs only the caller's own token. Returns a Hono response to
 * short-circuit with, or `undefined` to proceed.
 */
async function requireScopeAccess(c: Context<AppEnv>, scope: OnePasswordScope) {
  // `org` is shared by design and `personal` is the caller's own token, so
  // only the team scope has anything to check here.
  if (scope !== "team") return undefined;
  const { db } = c.var.providers;
  const user = c.var.user;
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "Pass teamId for team scope." }, 400);
  if (!(await getTeamInOrg(db, user.orgId, teamId)) || !(await canAdministerTeam(db, teamId, user.id))) {
    return c.json({ error: "Team not found." }, 404);
  }
  return undefined;
}


onePasswordRouter.get("/settings", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;

  const ctx = { orgId: user.orgId, userId: user.id };
  const [orgTokenConnected, personalTokenConnected] = await Promise.all([
    onePassword.tokenConnected("org", ctx),
    onePassword.tokenConnected("personal", ctx),
  ]);

  const resp: OnePasswordSettingsResponse = { orgTokenConnected, personalTokenConnected };
  return c.json(resp);
});

onePasswordRouter.get("/vaults", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);
  if (!scope) return c.json({ error: "Set scope to org, personal, or team." }, 400);

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  try {
    const vaults = await onePassword.listVaults(scope, { orgId: user.orgId, userId: user.id, teamId: scope === "team" ? c.req.query("teamId") : undefined });
    const resp: ListOpVaultsResponse = { vaults };
    return c.json(resp);
  } catch (err) {
    return mapOnePasswordError(c, err);
  }
});

/** Presence only: this read neither decrypts tokens nor contacts 1Password. */
onePasswordRouter.get("/team-status", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "Pass teamId." }, 400);
  if (!(await getTeamInOrg(db, user.orgId, teamId)) || !(await canViewTeam(db, teamId, user.id))) {
    return c.json({ error: "Team not found." }, 404);
  }
  const [row] = await db.select({ id: credentials.ownerId }).from(credentials)
    .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, teamId), eq(credentials.service, ONEPASSWORD_SERVICE), isNotNull(credentials.apiKeyEnc))).limit(1);
  return c.json({ tokenConnected: Boolean(row) } satisfies TeamOnePasswordStatusResponse);
});
