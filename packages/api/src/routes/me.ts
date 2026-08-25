/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Returns `MeResponse` with user profile and org membership info.
 *
 * `GET` joins `users` with `org_members` for `orgRole` — a caller with no
 * membership row (shouldn't happen outside tests, but the query doesn't
 * assume it) reads as `"member"`.
 *
 * `PATCH` accepts a strict whitelist (`name`, `avatarUrl`, `defaultModel`,
 * `modelPreferences`); any other key 400s rather than being silently
 * ignored, so a typo'd field name in a client doesn't quietly no-op.
 * `defaultModel` (when non-null) and every entry of `modelPreferences`
 * (when non-empty) are validated against the org model catalog's active id
 * set — the same set `/api/models` reports (bare Anthropic ids remain
 * valid back-compat, see `services/model-catalog.ts`'s `catalogValidIds`)
 * — and `null` clears the `defaultModel` override back to the host default.
 * `modelPreferences: []` clears the user's ordered list. Restores the v1
 * per-user ordered model-preferences feature (regressed to
 * single-`defaultModel`-only in dev-v2); mirrors the org-admin
 * `PUT /api/org/llm-providers/preferences` validation without touching its
 * org-admin gate.
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { requireUser } from "../middleware/auth.js";
import { orgMembers, users } from "../schema/index.js";
import { buildOrgCatalog, catalogValidIds, isModelPreferenceList, unknownActiveCatalogIds, unknownActiveCatalogIdsError } from "../services/model-catalog.js";
import { getUserModelPreferences, setUserModelPreferences } from "../services/user.js";
import type { MeResponse, PatchMeResponse } from "../wire/types.js";

export const meRouter = new Hono<AppEnv>();

const PATCH_FIELDS = new Set(["name", "avatarUrl", "defaultModel", "modelPreferences"]);

/**
 * Bounds from v1's user-list validation, not from the org preferences
 * route (that route has no length cap). 20 entries is enough for a
 * personal fallback list. 255 chars covers the widest namespaced id we
 * accept today (`anthropic/...`, `openrouter/vendor/model`).
 */
const MAX_PREFERENCES = 20;
const MAX_PREFERENCE_LENGTH = 255;

async function loadMeResponse(
  db: AppDb,
  user: { id: string; email: string; role: "admin" | "member"; orgId: string },
): Promise<MeResponse | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;

  const membershipRows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, user.orgId), eq(orgMembers.userId, user.id)))
    .limit(1);
  const membership = membershipRows[0];

  const modelPreferences = await getUserModelPreferences(db, user.id);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.image,
    role: user.role,
    orgId: user.orgId,
    orgRole: membership?.role ?? "member",
    defaultModel: row.defaultModel,
    modelPreferences,
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
  // feeds `db.update(users).set(...)` directly. `modelPreferences` writes
  // through `setUserModelPreferences` (same helper the org PUT uses for
  // `orgs.model_preferences`), not this object.
  const update: {
    name?: string;
    image?: string;
    defaultModel?: string | null;
  } = {};
  let modelPreferences: string[] | undefined;

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

  // Lazily built ONCE and shared between `defaultModel` and
  // `modelPreferences` validation — a PATCH that touches both must not pay
  // the (mildly expensive) org-catalog build twice.
  let catalogValidIdsCache: Set<string> | undefined;
  const ensureValidIds = async (): Promise<Set<string>> => {
    if (catalogValidIdsCache) return catalogValidIdsCache;
    const { engineCredentials } = c.var.providers;
    const entries = await buildOrgCatalog(db, engineCredentials, user.orgId);
    catalogValidIdsCache = catalogValidIds(entries);
    return catalogValidIdsCache;
  };

  if ("defaultModel" in raw) {
    const defaultModel = raw.defaultModel;
    if (defaultModel !== null && typeof defaultModel !== "string") {
      return c.json({ error: "defaultModel must be a string or null" }, 400);
    }
    if (defaultModel !== null) {
      const validIds = await ensureValidIds();
      if (!validIds.has(defaultModel)) {
        return c.json({ error: `unknown model: ${defaultModel}` }, 400);
      }
    }
    update.defaultModel = defaultModel;
  }

  if ("modelPreferences" in raw) {
    if (!isModelPreferenceList(raw.modelPreferences)) {
      return c.json(
        { error: "modelPreferences must be an array of strings. Send a JSON array of model ids." },
        400,
      );
    }
    const prefs = raw.modelPreferences;
    if (prefs.length > MAX_PREFERENCES) {
      return c.json(
        {
          error: `modelPreferences must contain at most ${MAX_PREFERENCES} entries. Remove extra entries and retry.`,
        },
        400,
      );
    }
    if (prefs.some((p) => p.length > MAX_PREFERENCE_LENGTH)) {
      return c.json(
        {
          error: `modelPreferences entries must be at most ${MAX_PREFERENCE_LENGTH} characters. Use a catalog id from GET /api/models.`,
        },
        400,
      );
    }
    if (prefs.length > 0) {
      const validIds = await ensureValidIds();
      const unknownIds = unknownActiveCatalogIds(prefs, validIds);
      if (unknownIds.length > 0) {
        return c.json({ error: unknownActiveCatalogIdsError(unknownIds) }, 400);
      }
    }
    modelPreferences = prefs;
  }

  if (Object.keys(update).length > 0 || modelPreferences !== undefined) {
    await db.transaction(async (tx) => {
      if (Object.keys(update).length > 0) {
        await tx.update(users).set(update).where(eq(users.id, user.id));
      }
      if (modelPreferences !== undefined) {
        await setUserModelPreferences(tx, user.id, modelPreferences);
      }
    });
  }

  const body = await loadMeResponse(db, user);
  if (!body) return c.json({ error: "user not found" }, 404);
  const resp: PatchMeResponse = body;
  return c.json(resp);
});
