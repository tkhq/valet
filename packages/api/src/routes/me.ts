/**
 * `/api/me` — settings-shell per-user profile surface (split-settings
 * design). Distinct from `/api/auth/me` (`AuthMeResponse`, session-probe
 * shape used by the app boot check).
 *
 * `GET` joins `users` with `org_members` for `orgRole` — a caller with no
 * membership row (shouldn't happen outside tests, but the query doesn't
 * assume it) reads as `"member"`.
 *
 * `PATCH` accepts a strict whitelist (`name`, `avatarUrl`, `defaultModel`);
 * any other key 400s rather than being silently ignored, so a typo'd field
 * name in a client doesn't quietly no-op. `defaultModel` (when non-null) is
 * validated against pi-ai's static Anthropic registry — the same set
 * `/api/models` reports — and `null` clears the override back to the host
 * default.
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getModels } from "@mariozechner/pi-ai";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, users } from "../schema/index.js";
import type { MeResponse, PatchMeRequest, PatchMeResponse } from "../wire/types.js";

export const meRouter = new Hono<AppEnv>();

const KNOWN_MODEL_IDS = new Set(getModels("anthropic").map((m) => m.id));

const PATCH_FIELDS = new Set(["name", "avatarUrl", "defaultModel"]);

async function loadMeResponse(
  db: AppDb,
  user: { id: string; email: string; role: "admin" | "member"; orgId: string },
): Promise<MeResponse | undefined> {
  const row = await db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) return undefined;

  const membership = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, user.orgId), eq(orgMembers.userId, user.id)))
    .get();

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: user.role,
    orgId: user.orgId,
    orgRole: membership?.role ?? "member",
    defaultModel: row.defaultModel,
  };
}

meRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const body = await loadMeResponse(db, c.var.user);
  if (!body) return c.json({ error: "user not found" }, 404);
  return c.json(body);
});

meRouter.patch("/", async (c) => {
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

  const update: Partial<PatchMeRequest> = {};

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
    update.avatarUrl = raw.avatarUrl;
  }

  if ("defaultModel" in raw) {
    const defaultModel = raw.defaultModel;
    if (defaultModel !== null && typeof defaultModel !== "string") {
      return c.json({ error: "defaultModel must be a string or null" }, 400);
    }
    if (defaultModel !== null && !KNOWN_MODEL_IDS.has(defaultModel)) {
      return c.json({ error: `unknown model: ${defaultModel}` }, 400);
    }
    update.defaultModel = defaultModel;
  }

  if (Object.keys(update).length > 0) {
    db.update(users).set(update).where(eq(users.id, c.var.user.id)).run();
  }

  const body = await loadMeResponse(db, c.var.user);
  if (!body) return c.json({ error: "user not found" }, 404);
  const resp: PatchMeResponse = body;
  return c.json(resp);
});
