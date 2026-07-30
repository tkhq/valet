/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Returns `MeResponse` with user profile and org membership info.
 *
 * `orgRole` comes straight from `AuthUser.orgRole` — the auth middleware
 * already resolved it against `org_members.role` per request (defaults to
 * `"member"` when no membership row exists; see `middleware/auth.ts`'s
 * `resolveOrgRole`).
 *
 * `PATCH` accepts a strict whitelist (`name`, `avatarUrl`, `defaultModel`);
 * any other key 400s rather than being silently ignored, so a typo'd field
 * name in a client doesn't quietly no-op. `defaultModel` (when non-null) is
 * validated against the org model catalog's active id set — the same set
 * `/api/models` reports (bare Anthropic ids remain valid back-compat, see
 * `services/model-catalog.ts`'s `catalogValidIds`) — and `null` clears the
 * override back to the host default.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { requireUser } from "../middleware/auth.js";
import { users } from "../schema/index.js";
import type { OrgRole } from "../auth/permissions.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import type { MeResponse, PatchMeResponse } from "../wire/types.js";

export const meRouter = new Hono<AppEnv>();

const PATCH_FIELDS = new Set(["name", "avatarUrl", "defaultModel"]);

async function loadMeResponse(
  db: AppDb,
  user: { id: string; email: string; role: "admin" | "member"; orgId: string; orgRole: OrgRole },
): Promise<MeResponse | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.image,
    role: user.role,
    orgId: user.orgId,
    // `org_members.role` — the auth middleware already resolved this per
    // request (middleware/auth.ts's `resolveOrgRole`); no need to re-query.
    orgRole: user.orgRole,
    defaultModel: row.defaultModel,
  };
}

meRouter.get("/", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;
  const body = await loadMeResponse(db, user);
  if (!body) return c.json({ error: "user not found" }, 404);
  return c.json(body);
});

meRouter.patch("/", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const unknownFields = Object.keys(raw).filter((k) => !PATCH_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return c.json({ error: `unknown field(s): ${unknownFields.join(", ")}` }, 400);
  }

  // Keyed by db column name (`image`, not wire-level `avatarUrl`) since this
  // feeds `db.update(users).set(...)` directly.
  const update: { name?: string; image?: string; defaultModel?: string | null } = {};

  if ("name" in raw) {
    if (typeof raw.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    update.name = raw.name;
  }

  if ("avatarUrl" in raw) {
    if (typeof raw.avatarUrl !== "string") {
      return c.json({ error: "avatarUrl must be a string" }, 400);
    }
    update.image = raw.avatarUrl;
  }

  if ("defaultModel" in raw) {
    const defaultModel = raw.defaultModel;
    if (defaultModel !== null && typeof defaultModel !== "string") {
      return c.json({ error: "defaultModel must be a string or null" }, 400);
    }
    if (defaultModel !== null) {
      const { engineCredentials } = c.var.providers;
      const entries = await buildOrgCatalog(db, engineCredentials, user.orgId);
      const validIds = catalogValidIds(entries);
      if (!validIds.has(defaultModel)) {
        return c.json({ error: `unknown model: ${defaultModel}` }, 400);
      }
    }
    update.defaultModel = defaultModel;
  }

  if (Object.keys(update).length > 0) {
    await db.update(users).set(update).where(eq(users.id, user.id));
  }

  const body = await loadMeResponse(db, user);
  if (!body) return c.json({ error: "user not found" }, 404);
  const resp: PatchMeResponse = body;
  return c.json(resp);
});
