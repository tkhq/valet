/**
 * `/api/onepassword` — the org and personal service-account tokens for the
 * 1Password credential feature, plus one probe.
 *
 * `GET`/`PUT /settings` read and set the org token, the allow-personal
 * toggle, and the personal token (`PUT` is admin-only). `GET /vaults` lists
 * the vaults a scope's token can read; it is the live check that a token
 * works and the route the SDK-over-HTTP regression test drives. `scope=org`
 * is open to any member once the org token is connected (the token is
 * shared org-wide by design; scope the service account to a dedicated vault
 * in 1Password to limit it). `scope=personal` requires the org toggle,
 * checked here so the 403 copy matches `routes/credentials.ts`.
 *
 * A typed `OnePasswordAuthError` maps to 400 with its own message; any other
 * rejection maps to 502 so SDK or network detail never reaches the client.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { ONEPASSWORD_SERVICE, type OnePasswordScope } from "../services/onepassword.js";
import { PERSONAL_DISABLED, mapOnePasswordError } from "./_onepassword-errors.js";
import { getAllowPersonalOnePassword, setOrgFeatures } from "../services/org.js";
import type {
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  PutOnePasswordSettingsRequest,
} from "../wire/types.js";

export const onePasswordRouter = new Hono<AppEnv>();


function scopeFromQuery(c: Context<AppEnv>): OnePasswordScope {
  return c.req.query("scope") === "org" ? "org" : "personal";
}

/**
 * Route-level gate shared by the vault/item browse endpoints: `scope=org`
 * is open to any authed org member (the org service-account token is
 * intentionally shared — see this file's doc comment); `scope=personal`
 * requires the org toggle. Returns a Hono response to short-circuit with,
 * or `undefined` to proceed.
 */
async function requireScopeAccess(c: Context<AppEnv>, scope: OnePasswordScope) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (scope === "org") {
    return undefined;
  }
  const allowed = await getAllowPersonalOnePassword(db, user.orgId);
  if (!allowed) {
    return c.json(PERSONAL_DISABLED, 403);
  }
  return undefined;
}


onePasswordRouter.get("/settings", async (c) => {
  const { db, onePassword } = c.var.providers;
  const user = c.var.user;

  const allowPersonal = await getAllowPersonalOnePassword(db, user.orgId);
  const ctx = { orgId: user.orgId, userId: user.id };
  const [orgTokenConnected, personalTokenConnected] = await Promise.all([
    onePassword.tokenConnected("org", ctx),
    onePassword.tokenConnected("personal", ctx),
  ]);

  const resp: OnePasswordSettingsResponse = { allowPersonal, orgTokenConnected, personalTokenConnected };
  return c.json(resp);
});

onePasswordRouter.put("/settings", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, onePassword } = c.var.providers;
  const user = c.var.user;

  let body: PutOnePasswordSettingsRequest;
  try {
    body = (await c.req.json()) as PutOnePasswordSettingsRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.allowPersonal !== "boolean") {
    return c.json({ error: "allowPersonal must be a boolean" }, 400);
  }

  await setOrgFeatures(db, user.orgId, { allowPersonalOnePassword: body.allowPersonal });

  const ctx = { orgId: user.orgId, userId: user.id };
  const [orgTokenConnected, personalTokenConnected] = await Promise.all([
    onePassword.tokenConnected("org", ctx),
    onePassword.tokenConnected("personal", ctx),
  ]);
  const resp: OnePasswordSettingsResponse = {
    allowPersonal: body.allowPersonal,
    orgTokenConnected,
    personalTokenConnected,
  };
  return c.json(resp);
});

onePasswordRouter.get("/vaults", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  try {
    const vaults = await onePassword.listVaults(scope, { orgId: user.orgId, userId: user.id });
    const resp: ListOpVaultsResponse = { vaults };
    return c.json(resp);
  } catch (err) {
    return mapOnePasswordError(c, err);
  }
});
