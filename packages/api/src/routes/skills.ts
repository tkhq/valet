/**
 * `/api/skills` — the skill catalog, plus CRUD over the skills a person
 * writes here.
 *
 * The catalog joins two sources. Plugin skills come from `providers.plugins`
 * and are the same for everyone. Stored skills come from the `skills` table
 * and are owner-scoped, so this router reads them through
 * `services/skills.ts`, which applies the same ownership rule the workflow
 * routes do: a row another owner holds is reported as not found, never as
 * forbidden.
 *
 * The listing marks a stored skill as `shadowed` when a name already in the
 * set keeps it out. `partitionByName` decides that, and it is the same
 * function the session build uses, so what this page calls shadowed is
 * exactly what a session drops.
 *
 * Stored skills are addressed by row id (`/stored/:id`), not by name. A
 * shadowed skill shares its name with the skill that shadows it, and the id
 * is what lets a person open and rename it.
 *
 * A detail route never fills `{{placeholder}}` values, because reading a
 * skill is not invoking it — the `skill` tool does that (see
 * `plugins/skill-tool.ts`).
 */
import { Hono } from "hono";
import type { SkillSource, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { partitionByName } from "../plugins/assemble.js";
import {
  createSkill,
  deleteSkill,
  listSkills,
  ownedSkillRow,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillValidationError,
  updateSkill,
  type SkillOwner,
} from "../services/skills.js";
import type { SkillRow } from "../schema/index.js";
import type {
  CreateSkillRequest,
  DeleteSkillResponse,
  GetSkillResponse,
  ListSkillsResponse,
  PluginSkillSummary,
  SkillResponse,
  StoredSkillSummary,
  UpdateSkillRequest,
} from "../wire/types.js";

export const skillsRouter = new Hono<AppEnv>();

interface OwnedSkill {
  plugin: string;
  skill: SkillSource;
}

function ownedSkills(plugins: ValetPlugin[]): OwnedSkill[] {
  return plugins.flatMap((plugin) =>
    (plugin.skills ?? []).map((skill) => ({ plugin: plugin.name, skill })),
  );
}

function toPluginSummary({ plugin, skill }: OwnedSkill): PluginSkillSummary {
  return {
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    origin: "plugin",
    plugin,
    takesArgs: skill.argsSchema !== undefined,
  };
}

function toStoredSummary(row: SkillRow, shadowed: boolean): StoredSkillSummary {
  return {
    name: row.name,
    description: row.description,
    origin: row.origin === "repo" ? "repo" : "local",
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    shadowed,
    takesArgs: false,
    updatedAt: row.updatedAt,
  };
}

function owner(c: { var: { user: { id: string; orgId: string } } }): SkillOwner {
  return { userId: c.var.user.id, orgId: c.var.user.orgId };
}

/** Maps a service error onto its HTTP status. Anything else rethrows. */
function errorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 404 | 409 } {
  if (err instanceof SkillValidationError) {
    return { body: { error: err.message, errors: err.errors }, status: 400 };
  }
  if (err instanceof SkillNameConflictError) return { body: { error: err.message }, status: 409 };
  if (err instanceof SkillNotLocalError) return { body: { error: err.message }, status: 409 };
  if (err instanceof NotFoundError) return { body: { error: err.message }, status: 404 };
  throw err;
}

// ── Catalog ───────────────────────────────────────────────────────────────

skillsRouter.get("/", async (c) => {
  const pluginSkills = ownedSkills(c.var.providers.plugins);
  const rows = await listSkills(c.var.providers.db, owner(c));
  const { kept, shadowed } = partitionByName(
    pluginSkills.map((entry) => entry.skill.name),
    rows,
  );
  const shadowedIds = new Set(shadowed.map((row) => row.id));

  // Both kinds, in one list. A reader of this page asks "what can the
  // assistant read", and the answer includes the skills the installed
  // plugins ship — which is also the only way a shadow warning makes sense,
  // since the skill doing the shadowing is usually one of them.
  const resp: ListSkillsResponse = {
    skills: [
      ...pluginSkills.map(toPluginSummary),
      // Listing order matches delivery order, so the `kept` rows come first.
      ...[...kept, ...shadowed].map((row) => toStoredSummary(row, shadowedIds.has(row.id))),
    ],
  };
  return c.json(resp);
});

skillsRouter.post("/", async (c) => {
  let body: CreateSkillRequest;
  try {
    body = (await c.req.json()) as CreateSkillRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  try {
    const row = await createSkill(c.var.providers.db, owner(c), {
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      content: body.content,
      teamId: body.teamId,
    });
    // A brand-new skill is shadowed exactly when a plugin already ships its
    // name — the author needs to see that immediately, not at the next
    // session build.
    const takenByPlugin = ownedSkills(c.var.providers.plugins).some(
      (entry) => entry.skill.name === row.name,
    );
    const resp: SkillResponse = { ...toStoredSummary(row, takenByPlugin), content: row.content };
    return c.json(resp, 201);
  } catch (err) {
    const { body: errBody, status } = errorResponse(err);
    return c.json(errBody, status);
  }
});

// ── Stored skills, by row id ──────────────────────────────────────────────

skillsRouter.get("/stored/:id", async (c) => {
  const row = await ownedSkillRow(c.var.providers.db, owner(c), c.req.param("id"));
  if (!row) return c.json({ error: "skill not found" }, 404);
  const resp: SkillResponse = {
    ...toStoredSummary(row, isShadowed(c.var.providers.plugins, row)),
    content: row.content,
  };
  return c.json(resp);
});

skillsRouter.patch("/stored/:id", async (c) => {
  let body: UpdateSkillRequest;
  try {
    body = (await c.req.json()) as UpdateSkillRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    const row = await updateSkill(c.var.providers.db, owner(c), c.req.param("id"), {
      name: body.name,
      description: body.description,
      content: body.content,
    });
    if (!row) return c.json({ error: "skill not found" }, 404);
    const resp: SkillResponse = {
      ...toStoredSummary(row, isShadowed(c.var.providers.plugins, row)),
      content: row.content,
    };
    return c.json(resp);
  } catch (err) {
    const { body: errBody, status } = errorResponse(err);
    return c.json(errBody, status);
  }
});

skillsRouter.delete("/stored/:id", async (c) => {
  const result = await deleteSkill(c.var.providers.db, owner(c), c.req.param("id"));
  if (result === "not_found") return c.json({ error: "skill not found" }, 404);
  if (result === "not_local") {
    return c.json(
      { error: "this skill comes from a repository. Remove it in the repository it came from." },
      409,
    );
  }
  const resp: DeleteSkillResponse = { ok: true };
  return c.json(resp);
});

// ── One skill, by name ────────────────────────────────────────────────────

skillsRouter.get("/:name", async (c) => {
  const name = c.req.param("name");

  // Plugin skills first: a plugin skill shadows a stored one of the same
  // name at session build, so it must win here too.
  const plugin = ownedSkills(c.var.providers.plugins).find((entry) => entry.skill.name === name);
  if (plugin) {
    const resp: GetSkillResponse = { ...toPluginSummary(plugin), content: plugin.skill.content };
    return c.json(resp);
  }

  const rows = await listSkills(c.var.providers.db, owner(c));
  const row = rows.find((r) => r.name === name);
  if (!row) {
    return c.json(
      { error: `skill "${name}" not found. Open /skills to see the installed skills.` },
      404,
    );
  }
  // `listSkills` returns the winner of a repeated name first, so the row
  // this route resolves is by definition the one a session gets.
  const resp: GetSkillResponse = { ...toStoredSummary(row, false), content: row.content };
  return c.json(resp);
});

/** True when a plugin already ships this name. The stored-vs-stored case is
 * not decidable from one row, so `/stored/:id` reports only this half; the
 * listing route reports both. */
function isShadowed(plugins: ValetPlugin[], row: SkillRow): boolean {
  return ownedSkills(plugins).some((entry) => entry.skill.name === row.name);
}
