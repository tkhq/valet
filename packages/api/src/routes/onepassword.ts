/**
 * `/api/onepassword` — picker backend (vaults/items browse) + org/personal
 * settings for the 1Password reference-credential feature (1Password
 * credential provider plan, Task 3). All routes are authed; `scope` query
 * param selects which service-account token to use (`org`|`personal`,
 * default `personal`).
 *
 * `scope=org` requires the caller to be an org admin (same `ORG_ADMIN_REQUIRED`
 * copy `routes/credentials.ts` uses). `scope=personal` requires the org's
 * `allowPersonalOnePassword` toggle to be on — checked here at the route
 * level (not left to `OnePasswordService`'s internal check) so the 403 copy
 * is consistent with the PUT-credential 403 in `routes/credentials.ts`.
 *
 * `OnePasswordAuthError` thrown by the service (missing token, resolve
 * failure, etc.) maps to 400 with the error's own message — it never
 * contains secret material (see `services/onepassword.ts`'s doc comment).
 * Any other rejection maps to a generic 502 so a raw SDK/network error never
 * leaks upstream detail to the client.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { OnePasswordAuthError, type OnePasswordScope } from "../services/onepassword.js";
import { getAllowPersonalOnePassword, setOrgFeatures } from "../services/org.js";
import type {
  ListOpItemsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
  PutOnePasswordSettingsRequest,
} from "../wire/types.js";

export const onePasswordRouter = new Hono<AppEnv>();

const ORG_ADMIN_REQUIRED = { error: "org admin required" } as const;
const PERSONAL_DISABLED = { error: "personal 1Password tokens are disabled by your organization" } as const;
const REQUEST_FAILED = { error: "1Password request failed" } as const;

function scopeFromQuery(c: Context<AppEnv>): OnePasswordScope {
  return c.req.query("scope") === "org" ? "org" : "personal";
}

/**
 * Route-level gate shared by the vault/item browse endpoints: `scope=org`
 * requires admin, `scope=personal` requires the org toggle. Returns a Hono
 * response to short-circuit with, or `undefined` to proceed.
 */
async function requireScopeAccess(c: Context<AppEnv>, scope: OnePasswordScope) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (scope === "org") {
    if (user.role !== "admin") {
      return c.json(ORG_ADMIN_REQUIRED, 403);
    }
    return undefined;
  }
  const allowed = await getAllowPersonalOnePassword(db, user.orgId);
  if (!allowed) {
    return c.json(PERSONAL_DISABLED, 403);
  }
  return undefined;
}

/** Maps a rejection from `OnePasswordService` to the route's error response. */
function mapServiceError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof OnePasswordAuthError) {
    return c.json({ error: err.message }, 400);
  }
  return c.json(REQUEST_FAILED, 502);
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
  const { db, onePassword } = c.var.providers;
  const user = c.var.user;
  if (user.role !== "admin") {
    return c.json(ORG_ADMIN_REQUIRED, 403);
  }

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
    return mapServiceError(c, err);
  }
});

onePasswordRouter.get("/vaults/:vaultId/items", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);
  const vaultId = c.req.param("vaultId");

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  try {
    const items = await onePassword.listItems(scope, { orgId: user.orgId, userId: user.id }, vaultId);
    const resp: ListOpItemsResponse = { items };
    return c.json(resp);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

onePasswordRouter.get("/vaults/:vaultId/items/:itemId", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);
  const vaultId = c.req.param("vaultId");
  const itemId = c.req.param("itemId");

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  try {
    const item = await onePassword.getItem(scope, { orgId: user.orgId, userId: user.id }, vaultId, itemId);
    const resp: OpItemDetailResponse = item;
    return c.json(resp);
  } catch (err) {
    return mapServiceError(c, err);
  }
});
