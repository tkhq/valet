/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Returns `MeResponse` with user profile and org membership info.
 *
 * `GET` joins `users` with `org_members` for `orgRole` — a caller with no
 * membership row (shouldn't happen outside tests, but the query doesn't
 * assume it) reads as `"member"`.
 *
 * `PATCH` accepts a strict whitelist (`name`, `avatarUrl`, `defaultModel`,
 * `defaultReasoning`, `newThreadBehavior`);
 * any other key 400s rather than being silently ignored, so a typo'd field
 * name in a client doesn't quietly no-op. `defaultModel` (when non-null) is
 * validated against the org model catalog's active id set — the same set
 * `/api/models` reports (bare Anthropic ids remain valid back-compat, see
 * `services/model-catalog.ts`'s `catalogValidIds`) — and `null` clears the
 * override back to the host default. `defaultReasoning` follows the same
 * null-clears pattern.
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { requireUser } from "../middleware/auth.js";
import { orgMembers, users } from "../schema/index.js";
import { validateDefaultModelId } from "../services/model-catalog.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { assertModelSelectable } from "../services/approved-models.js";
import { assertReasoningSelectable } from "../services/reasoning.js";
import type { MeResponse, PatchMeResponse } from "../wire/types.js";

export const meRouter = new Hono<AppEnv>();

const PATCH_FIELDS = new Set([
  "name",
  "avatarUrl",
  "defaultModel",
  "defaultReasoning",
  "newThreadBehavior",
]);

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

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.image,
    role: user.role,
    orgId: user.orgId,
    orgRole: membership?.role ?? "member",
    defaultModel: row.defaultModel,
    defaultReasoning: row.defaultReasoning ?? null,
    newThreadBehavior: row.newThreadBehavior,
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

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON object, e.g. {\"name\": \"...\"}." }, 400);
  }
  // `JSON.parse` accepts `null`/numbers/strings, which `Object.keys` and the
  // `in` operator below would throw on — reject anything but a plain object.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ error: "invalid JSON body. Send a JSON object, e.g. {\"name\": \"...\"}." }, 400);
  }
  const raw = parsed as Record<string, unknown>;

  const unknownFields = Object.keys(raw).filter((k) => !PATCH_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return c.json(
      { error: `unknown field(s): ${unknownFields.join(", ")}. Send only supported profile settings.` },
      400,
    );
  }

  // Keyed by db column name (`image`, not wire-level `avatarUrl`) since this
  // feeds `db.update(users).set(...)` directly.
  const update: {
    name?: string;
    image?: string;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    newThreadBehavior?: "keep_current" | "use_defaults";
  } = {};

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
      return c.json(
        { error: "defaultModel must be a model id from the model list (GET /api/models), or null to clear the override." },
        400,
      );
    }
    const { engineCredentials } = c.var.providers;
    const invalid = await validateDefaultModelId(db, engineCredentials, user.orgId, defaultModel);
    if (invalid) return c.json({ error: invalid }, 400);
    if (defaultModel !== null) {
      const isAdmin = await isOrgAdminUser(c);
      const err = await assertModelSelectable(db, user.orgId, isAdmin, defaultModel);
      if (err) return c.json({ error: err }, 400);
    }
    update.defaultModel = defaultModel;
  }

  if ("defaultReasoning" in raw) {
    const defaultReasoning = raw.defaultReasoning;
    if (defaultReasoning !== null && typeof defaultReasoning !== "string") {
      return c.json(
        { error: "defaultReasoning must be a reasoning level string, or null to clear the override." },
        400,
      );
    }
    if (defaultReasoning === null) {
      update.defaultReasoning = null;
    } else {
      const normalizedReasoning = defaultReasoning.trim().toLowerCase();
      const err = await assertReasoningSelectable(db, user.orgId, normalizedReasoning);
      if (err) return c.json({ error: err }, 400);
      update.defaultReasoning = normalizedReasoning;
    }
  }

  if ("newThreadBehavior" in raw) {
    if (raw.newThreadBehavior !== "keep_current" && raw.newThreadBehavior !== "use_defaults") {
      return c.json(
        { error: "newThreadBehavior is not supported. Select keep_current or use_defaults." },
        400,
      );
    }
    update.newThreadBehavior = raw.newThreadBehavior;
  }

  if (Object.keys(update).length > 0) {
    await db.update(users).set(update).where(eq(users.id, user.id));
  }

  const body = await loadMeResponse(db, user);
  if (!body) return c.json({ error: "user not found" }, 404);
  const resp: PatchMeResponse = body;
  return c.json(resp);
});
