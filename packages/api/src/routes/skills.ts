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
 *
 * `/sources` holds the tracked repositories Valet mirrors skills from. Those
 * routes are owner-scoped the same way, and both the create route and the
 * "sync now" route call the one `SkillSyncService.syncOnce` the background
 * sweep calls (`services/skill-sync.ts`).
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SkillSource, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { partitionByName } from "../plugins/assemble.js";
import {
  asRecord,
  createSkill,
  deleteSkill,
  isAuthorizedFor,
  listSkills,
  readableSkillRow,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillReservedNameError,
  SkillValidationError,
  updateSkill,
  type SkillOwner,
} from "../services/skills.js";
import { isOrgAdmin } from "../services/org.js";
import {
  countSkillsPerSource,
  createSkillSource,
  deleteSkillSource,
  listSkillSources,
  markSkillSourceDue,
  ownedSkillSourceRow,
  SkillSourceConflictError,
  SkillSourceInputError,
} from "../services/skill-sources.js";
import type { SkillSyncOutcome } from "../services/skill-sync.js";
import { skillSources, type SkillRow, type SkillSourceRow } from "../schema/index.js";
import type {
  CreateSkillRequest,
  CreateSkillSourceRequest,
  DeleteSkillResponse,
  DeleteSkillSourceResponse,
  GetSkillResponse,
  ListSkillSourcesResponse,
  ListSkillsResponse,
  PluginSkillSummary,
  SkillResponse,
  SkillSourceSummary,
  SkillSourceSyncResponse,
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
  const fm = asRecord(row.frontmatter);
  const invocation = fm.invocation === "context" || fm.invocation === "prompt" ? fm.invocation : undefined;
  const argHint = typeof fm.argHint === "string" ? fm.argHint : undefined;
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
    ...(invocation !== undefined ? { invocation } : {}),
    ...(argHint !== undefined ? { argHint } : {}),
  };
}


function owner(c: { var: { user: { id: string; orgId: string } } }): SkillOwner {
  return { userId: c.var.user.id, orgId: c.var.user.orgId };
}

/** Maps a service error onto its HTTP status. Anything else rethrows. */
function errorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 404 | 409 } {
  if (err instanceof SkillReservedNameError) return { body: { error: err.message }, status: 400 };
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

  // Validate invocation when present.
  if (body.invocation !== undefined && body.invocation !== "context" && body.invocation !== "prompt") {
    return c.json(
      { error: `invocation must be "context" or "prompt". Got "${body.invocation}".` },
      400,
    );
  }

  // Org-owned skill: require org admin.
  if (body.ownerType === "org") {
    const adminCheck = await isOrgAdmin(c.var.providers.db, c.var.user.orgId, c.var.user.id);
    if (!adminCheck) {
      return c.json({ error: "org admin required" }, 403);
    }
  }

  try {
    const row = await createSkill(c.var.providers.db, owner(c), {
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      content: body.content,
      teamId: body.teamId,
      ownerType: body.ownerType,
      invocation: body.invocation,
      argHint: typeof body.argHint === "string" ? body.argHint : undefined,
    });
    // A brand-new skill is shadowed exactly when a plugin already ships its
    // name — the author needs to see that immediately, not at the next
    // session build.
    const takenByPlugin = ownedSkills(c.var.providers.plugins).some(
      (entry) => entry.skill.name === row.name,
    );
    // The caller just created this row, so they may edit it.
    const resp: SkillResponse = {
      ...toStoredSummary(row, takenByPlugin),
      content: row.content,
      editable: true,
    };
    return c.json(resp, 201);
  } catch (err) {
    const { body: errBody, status } = errorResponse(err);
    return c.json(errBody, status);
  }
});

// ── Stored skills, by row id ──────────────────────────────────────────────

skillsRouter.get("/stored/:id", async (c) => {
  // A member may READ any org row in their own org, so this uses the
  // read-scoped lookup — `ownedSkillRow` would 404 an org row for a non-admin
  // and break the detail page. Writes stay on `ownedSkillRow`.
  const row = await readableSkillRow(c.var.providers.db, owner(c), c.req.param("id"));
  if (!row) return c.json({ error: "skill not found" }, 404);
  // `editable`: a user/team row follows ownership; an org row needs org admin.
  const orgAdmin = row.ownerType === "org"
    ? await isOrgAdmin(c.var.providers.db, c.var.user.orgId, c.var.user.id)
    : false;
  const editable = await isAuthorizedFor(c.var.providers.db, owner(c), row, { isOrgAdmin: orgAdmin });
  const resp: SkillResponse = {
    ...toStoredSummary(row, isShadowed(c.var.providers.plugins, row)),
    content: row.content,
    editable,
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

  // Validate invocation when present.
  if (body.invocation !== undefined && body.invocation !== "context" && body.invocation !== "prompt") {
    return c.json(
      { error: `invocation must be "context" or "prompt". Got "${body.invocation}".` },
      400,
    );
  }

  const orgAdmin = await isOrgAdmin(c.var.providers.db, c.var.user.orgId, c.var.user.id);

  try {
    const row = await updateSkill(c.var.providers.db, owner(c), c.req.param("id"), {
      name: body.name,
      description: body.description,
      content: body.content,
      invocation: body.invocation,
      argHint: typeof body.argHint === "string" ? body.argHint : undefined,
      isOrgAdmin: orgAdmin,
    });
    if (!row) return c.json({ error: "skill not found" }, 404);
    // The PATCH succeeded, so the caller may write this row.
    const resp: SkillResponse = {
      ...toStoredSummary(row, isShadowed(c.var.providers.plugins, row)),
      content: row.content,
      editable: true,
    };
    return c.json(resp);
  } catch (err) {
    const { body: errBody, status } = errorResponse(err);
    return c.json(errBody, status);
  }
});

skillsRouter.delete("/stored/:id", async (c) => {
  const orgAdmin = await isOrgAdmin(c.var.providers.db, c.var.user.orgId, c.var.user.id);
  const result = await deleteSkill(c.var.providers.db, owner(c), c.req.param("id"), { isOrgAdmin: orgAdmin });
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

// ── Tracked repositories ──────────────────────────────────────────────────
//
// Registered BEFORE `/:name` below: Hono matches in registration order, so a
// `/sources` route added after it would be swallowed by the skill-by-name
// route.
//
// Adding a source imports it right away. The point of the feature is "point
// Valet at a repository and pull the skills in", and a repository that 404s
// must say so while the person is still looking at the box they typed it
// into. The sweep keeps it fresh afterwards.

skillsRouter.get("/sources", async (c) => {
  const { db } = c.var.providers;
  const rows = await listSkillSources(db, owner(c));
  const counts = await countSkillsPerSource(
    db,
    rows.map((row) => row.id),
  );
  const resp: ListSkillSourcesResponse = {
    sources: rows.map((row) => toSourceSummary(row, counts.get(row.id) ?? 0)),
  };
  return c.json(resp);
});

skillsRouter.post("/sources", async (c) => {
  let body: CreateSkillSourceRequest;
  try {
    body = (await c.req.json()) as CreateSkillSourceRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.repo !== "string" || body.repo.length === 0) {
    return c.json({ error: "Enter a repository. Write it as owner/repo, or paste its GitHub URL." }, 400);
  }

  const { db, skillSync } = c.var.providers;

  // Org-owned source: require org admin.
  if (body.ownerType === "org") {
    const adminCheck = await isOrgAdmin(db, c.var.user.orgId, c.var.user.id);
    if (!adminCheck) {
      return c.json(
        { error: "Only an org admin can add an org source. Ask an admin, or add it as a personal source." },
        403,
      );
    }
  }

  let sourceId: string;
  try {
    const row = await createSkillSource(db, owner(c), {
      repo: body.repo,
      ref: body.ref,
      subpath: body.subpath,
      teamId: body.teamId,
      ownerType: body.ownerType,
    });
    sourceId = row.id;
  } catch (err) {
    const { body: errBody, status } = sourceErrorResponse(err);
    return c.json(errBody, status);
  }

  // A failed first sync is reported ON the row, not as a failed request: the
  // source exists, and its error is what the person needs to read.
  const outcome = await skillSync.syncOnce(sourceId);
  return c.json(await syncResponse(c, sourceId, outcome), 201);
});

skillsRouter.post("/sources/:id/sync", async (c) => {
  const { db, skillSync } = c.var.providers;
  const orgAdmin = await isOrgAdmin(db, c.var.user.orgId, c.var.user.id);
  const row = await ownedSkillSourceRow(db, owner(c), c.req.param("id"), { isOrgAdmin: orgAdmin });
  if (!row) return c.json({ error: "skill source not found" }, 404);

  await markSkillSourceDue(db, row.id);
  const outcome = await skillSync.syncOnce(row.id);
  return c.json(await syncResponse(c, row.id, outcome));
});

skillsRouter.delete("/sources/:id", async (c) => {
  const { db } = c.var.providers;
  const orgAdmin = await isOrgAdmin(db, c.var.user.orgId, c.var.user.id);
  const deleted = await deleteSkillSource(db, owner(c), c.req.param("id"), { isOrgAdmin: orgAdmin });
  if (!deleted) return c.json({ error: "skill source not found" }, 404);
  const resp: DeleteSkillSourceResponse = { ok: true };
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

function toSourceSummary(row: SkillSourceRow, skillCount: number): SkillSourceSummary {
  return {
    id: row.id,
    repo: row.repoFullName,
    ref: row.ref,
    subpath: row.subpath,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    enabled: row.enabled,
    status: row.status,
    skillCount,
    lastSyncedAt: row.lastSyncedAt,
    lastSha: row.lastSha,
    lastMessage: row.lastError,
  };
}

/** Re-reads the source row after a sync, so the response carries the status
 * the sync just recorded rather than the one it started from. */
async function syncResponse(
  c: { var: { providers: { db: AppDb } } },
  sourceId: string,
  outcome: SkillSyncOutcome | null,
): Promise<SkillSourceSyncResponse> {
  const { db } = c.var.providers;
  const rows = await db.select().from(skillSources).where(eq(skillSources.id, sourceId)).limit(1);
  const counts = await countSkillsPerSource(db, [sourceId]);
  const row = rows[0];
  if (!row) throw new NotFoundError("skill source", sourceId);
  return {
    source: toSourceSummary(row, counts.get(sourceId) ?? 0),
    imported: outcome?.imported ?? 0,
    updated: outcome?.updated ?? 0,
    deleted: outcome?.deleted ?? 0,
    warnings: outcome?.warnings ?? [],
  };
}

/** Maps a source-service error onto its HTTP status. */
function sourceErrorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 404 | 409 } {
  if (err instanceof SkillSourceInputError) return { body: { error: err.message }, status: 400 };
  if (err instanceof SkillSourceConflictError) return { body: { error: err.message }, status: 409 };
  if (err instanceof NotFoundError) return { body: { error: err.message }, status: 404 };
  throw err;
}
