/**
 * `/api/onepassword` — picker backend (vaults/items browse) + org/personal
 * settings for the 1Password reference-credential feature (1Password
 * credential provider plan, Task 3). All routes are authed; `scope` query
 * param selects which service-account token to use (`org`|`personal`,
 * default `personal`).
 *
 * Trust model: `scope=org` browsing (`/vaults`, `/vaults/:vaultId/items`,
 * `/vaults/:vaultId/items/:itemId`) is open to any authenticated org member
 * once the org's 1Password service account token is connected — the org
 * token is intentionally shared org-wide, giving members access to whatever
 * vaults the service account itself can read (see the design doc's decision
 * 2). Admins who want to restrict exposure should scope the service account
 * to a dedicated vault in 1Password itself, not rely on this route to gate
 * it. `PUT /settings` (which connects/rotates the org token and flips the
 * personal-token toggle) and creating an **org-owned** credential row stay
 * admin-only — those are the actual privileged actions. `scope=personal`
 * requires the org's `allowPersonalOnePassword` toggle to be on — checked
 * here at the route level (not left to `OnePasswordService`'s internal
 * check) so the 403 copy is consistent with the PUT-credential 403 in
 * `routes/credentials.ts`.
 *
 * `OnePasswordAuthError` thrown by the service (missing token, resolve
 * failure, etc.) maps to 400 with the error's own message — it never
 * contains secret material (see `services/onepassword.ts`'s doc comment).
 * Any other rejection maps to a generic 502 so a raw SDK/network error never
 * leaks upstream detail to the client.
 */
import { Hono, type Context } from "hono";
import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { ONEPASSWORD_SERVICE, titleNamesService, type OnePasswordScope } from "../services/onepassword.js";
import { PERSONAL_DISABLED, mapOnePasswordError } from "./_onepassword-errors.js";
import { getAllowPersonalOnePassword, setOrgFeatures } from "../services/org.js";
import type {
  ListOpItemsResponse,
  OpSuggestionsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
  PutOnePasswordSettingsRequest,
} from "../wire/types.js";

/** A vault can hold hundreds of items; the picker shows one page at a time. */
const OP_ITEMS_DEFAULT_LIMIT = 100;
const OP_ITEMS_MAX_LIMIT = 500;

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

onePasswordRouter.get("/vaults/:vaultId/items", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);
  const vaultId = c.req.param("vaultId");

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  const limit = readLimit(c.req.query("limit"), OP_ITEMS_DEFAULT_LIMIT, OP_ITEMS_MAX_LIMIT);
  if (limit === undefined) return c.json({ error: "limit must be a positive integer" }, 400);

  const rawCursor = c.req.query("cursor");
  // A corrupted cursor is an error, not a silent jump back to page one: a
  // client retrying with one must not skip items without being told.
  const after = rawCursor === undefined ? 0 : readItemOffset(rawCursor);
  if (after === undefined) return c.json({ error: "invalid cursor" }, 400);

  try {
    const all = await onePassword.listItems(scope, { orgId: user.orgId, userId: user.id }, vaultId);
    // Sliced here rather than upstream: `items.list` has no page parameter,
    // so the SDK call still reads the whole vault. What this bounds is the
    // response and the DOM built from it, which is where a several-hundred
    // item vault actually hurts.
    const page = all.slice(after, after + limit);
    const end = after + page.length;
    const resp: ListOpItemsResponse = {
      items: page,
      ...(end < all.length ? { nextCursor: encodePageCursor({ after: end }) } : {}),
    };
    return c.json(resp);
  } catch (err) {
    return mapOnePasswordError(c, err);
  }
});

/** Offset carried by an items cursor, or undefined when it is unreadable. */
function readItemOffset(raw: string): number | undefined {
  const fields = decodePageCursor(raw);
  const after = fields?.after;
  return typeof after === "number" && Number.isInteger(after) && after >= 0 ? after : undefined;
}

/**
 * Items that look like credentials for integrations this org has not
 * connected yet.
 *
 * Connecting a token and then hand-typing a service name for every
 * credential is work Valet can do itself: it knows which services declare a
 * credential (the plugin registry), which of those are already connected,
 * and what the vaults hold. The match is on the item title, deliberately
 * simple — a suggestion the person confirms, never an automatic write.
 *
 * A vault the token cannot read is reported by name rather than dropped, so
 * a partial answer does not read as "nothing found".
 */
onePasswordRouter.get("/suggestions", async (c) => {
  const { onePassword, plugins, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const scope = scopeFromQuery(c);

  const forbidden = await requireScopeAccess(c, scope);
  if (forbidden) return forbidden;

  const owner = scope === "org" ? { type: "org" as const, id: user.orgId } : { type: "user" as const, id: user.id };
  const ctx = { orgId: user.orgId, userId: user.id };

  try {
    // Services that declare a credential and have none stored yet. A service
    // already connected needs no suggestion.
    const declared = new Set<string>();
    for (const plugin of plugins) {
      for (const decl of plugin.credentials ?? []) declared.add(decl.service ?? plugin.name);
    }
    declared.delete(ONEPASSWORD_SERVICE);
    // One list, not one get per service: `get` may refresh an OAuth row and
    // write it back, and a suggestion scan should read, not write.
    const connected = new Set((await engineCredentials.list(owner)).map((c) => c.service));
    const wanted = [...declared].filter((service) => !connected.has(service));
    if (wanted.length === 0) {
      return c.json({ suggestions: [], unreadableVaults: [] } satisfies OpSuggestionsResponse);
    }

    const suggestions: OpSuggestionsResponse["suggestions"] = [];
    const unreadableVaults: string[] = [];
    // Vaults in parallel, results in vault order so the page is stable.
    const vaults = await onePassword.listVaults(scope, ctx);
    const scans = await Promise.all(
      vaults.map(async (vault) => {
        try {
          return { vault, items: await onePassword.listItems(scope, ctx, vault.id) };
        } catch {
          // One unreadable vault must not fail the whole scan.
          return { vault, items: null };
        }
      }),
    );
    for (const { vault, items } of scans) {
      if (items === null) {
        unreadableVaults.push(vault.title);
        continue;
      }
      for (const item of items) {
        const service = wanted.find((s) => titleNamesService(item.title, s));
        if (!service) continue;
        suggestions.push({
          service,
          vaultId: vault.id,
          vaultTitle: vault.title,
          itemId: item.id,
          itemTitle: item.title,
        });
      }
    }
    return c.json({ suggestions, unreadableVaults } satisfies OpSuggestionsResponse);
  } catch (err) {
    return mapOnePasswordError(c, err);
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
    return mapOnePasswordError(c, err);
  }
});
