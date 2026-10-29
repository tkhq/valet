/**
 * `PATCH /api/org/settings` — org-level toggles: bare-skill-commands
 * (slash-commands plan, Task 3) and the public-artifact opt-in
 * (artifacts design). Org-admin gated via `requireOrgAdmin`.
 *
 * Accepts boolean settings, including `allowAnonymousImageBakes`, and
 * `compactionWindowTokens`: a token count from 50,000 to 1,000,000, 0 for no
 * cap, or null for the Valet default. A new window reaches this process's
 * loaded sessions at once. Unknown fields 400. Responds with the updated org
 * settings row.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { orgs } from "../schema/index.js";
import type { OrgSettingsResponse } from "../wire/types.js";

export const orgSettingsRouter = new Hono<AppEnv>();

const PATCH_FIELDS = new Set(["bareSkillCommands", "allowPublicArtifacts", "allowAnonymousImageBakes", "allowPersonalInstallations", "compactionWindowTokens"]);

/** Smallest and largest compaction window an org can set (0 turns the cap off). */
const MIN_COMPACTION_WINDOW = 50_000;
const MAX_COMPACTION_WINDOW = 1_000_000;

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

  const update: {
    bareSkillCommands?: boolean;
    allowPublicArtifacts?: boolean;
    allowAnonymousImageBakes?: boolean;
    allowPersonalInstallations?: boolean;
    compactionWindowTokens?: number | null;
  } = {};

  if ("bareSkillCommands" in raw) {
    if (typeof raw.bareSkillCommands !== "boolean") {
      return c.json({ error: "bareSkillCommands must be a boolean" }, 400);
    }
    update.bareSkillCommands = raw.bareSkillCommands;
  }

  if ("allowPublicArtifacts" in raw) {
    if (typeof raw.allowPublicArtifacts !== "boolean") {
      return c.json({ error: "allowPublicArtifacts must be a boolean" }, 400);
    }
    update.allowPublicArtifacts = raw.allowPublicArtifacts;
  }

  if ("allowAnonymousImageBakes" in raw) {
    if (typeof raw.allowAnonymousImageBakes !== "boolean") {
      return c.json({ error: "allowAnonymousImageBakes must be a boolean. Send true or false." }, 400);
    }
    update.allowAnonymousImageBakes = raw.allowAnonymousImageBakes;
  }

  if ("allowPersonalInstallations" in raw) {
    if (typeof raw.allowPersonalInstallations !== "boolean") {
      return c.json({ error: "allowPersonalInstallations must be a boolean. Send true or false." }, 400);
    }
    update.allowPersonalInstallations = raw.allowPersonalInstallations;
  }

  if ("compactionWindowTokens" in raw) {
    const value = raw.compactionWindowTokens;
    const valid = value === null || value === 0 || (typeof value === "number" && Number.isInteger(value)
      && value >= MIN_COMPACTION_WINDOW && value <= MAX_COMPACTION_WINDOW);
    if (!valid) {
      return c.json({
        error: `compactionWindowTokens must be a whole number from ${MIN_COMPACTION_WINDOW} to ${MAX_COMPACTION_WINDOW}, 0 for no cap, or null for the Valet default.`,
      }, 400);
    }
    update.compactionWindowTokens = value;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "no recognized fields" }, 400);
  }

  await db.update(orgs).set(update).where(eq(orgs.id, user.orgId));

  const rows = await db.select().from(orgs).where(eq(orgs.id, user.orgId)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "org not found" }, 404);
  if ("compactionWindowTokens" in update) {
    c.var.providers.engineHost.setOrgCompactionWindow(user.orgId, row.compactionWindowTokens);
  }

  const resp: OrgSettingsResponse = {
    bareSkillCommands: row.bareSkillCommands,
    allowPublicArtifacts: row.allowPublicArtifacts,
    allowAnonymousImageBakes: row.allowAnonymousImageBakes,
    allowPersonalInstallations: row.allowPersonalInstallations,
    compactionWindowTokens: row.compactionWindowTokens,
  };
  return c.json(resp);
});
