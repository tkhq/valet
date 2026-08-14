/**
 * `PATCH /api/org/settings` — org-level bare-skill-commands toggle
 * (slash-commands plan, Task 3). Org-admin gated via `requireOrgAdmin`.
 *
 * Accepts `{ bareSkillCommands?: boolean }`. Unknown fields 400.
 * Responds with the updated org settings row.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { orgs } from "../schema/index.js";
import type { OrgSettingsResponse } from "../wire/types.js";

export const orgSettingsRouter = new Hono<AppEnv>();

const PATCH_FIELDS = new Set(["bareSkillCommands"]);

orgSettingsRouter.patch("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const user = c.var.user;
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

  const update: { bareSkillCommands?: boolean } = {};

  if ("bareSkillCommands" in raw) {
    if (typeof raw.bareSkillCommands !== "boolean") {
      return c.json({ error: "bareSkillCommands must be a boolean" }, 400);
    }
    update.bareSkillCommands = raw.bareSkillCommands;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "no recognized fields" }, 400);
  }

  await db.update(orgs).set(update).where(eq(orgs.id, user.orgId));

  const rows = await db.select().from(orgs).where(eq(orgs.id, user.orgId)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "org not found" }, 404);

  const resp: OrgSettingsResponse = { bareSkillCommands: row.bareSkillCommands };
  return c.json(resp);
});
