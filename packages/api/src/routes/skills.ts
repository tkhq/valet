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
 *
 * Both listings take the same optional `?ownerType=&ownerId=` filter, for a
 * client that shows one workspace at a time. `readOwnerScope` reads it for
 * both, so the two pages cannot answer a bad filter differently.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Principal, SkillSource, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { partitionByName } from "../plugins/assemble.js";
import {
  createSkill,
  deleteSkill,
  isAuthorizedFor,
  listSkills,
  ownedSkillRow,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillValidationError,
  updateSkill,
  type SkillOwner,
} from "../services/skills.js";
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

// ── The `?ownerType=&ownerId=` filter ─────────────────────────────────────

const OWNER_TYPES: ReadonlySet<string> = new Set(["user", "team", "org"]);

function isOwnerType(value: string): value is Principal["type"] {
  return OWNER_TYPES.has(value);
}

/** The one workspace to list, the response to send instead, or neither. */
type OwnerScope =
  | { ok: true; scope?: Principal }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * Reads the workspace filter both listings take — the same shape, and the
 * same two messages, `GET /api/workflows`, `GET /api/sessions` and
 * `GET /api/assistants` take, so one client builds one query for all of
 * them. Absent is an answer too: no parameters means the caller's whole
 * reach, exactly as before this filter existed.
 *
 * A query string names an owner; it never proves the caller may read that
 * owner. `isAuthorizedFor` decides that here, in application code, against
 * the caller's OWN org — the same rule every row-level read of these two
 * tables goes through, so a filter can never surface what an unfiltered list
 * hides. An `ownerType=org` filter therefore always fails: no rule admits
 * anybody to an org-owned skill yet.
 */
async function readOwnerScope(
  db: AppDb,
  caller: SkillOwner,
  ownerType: string | undefined,
  ownerId: string | undefined,
): Promise<OwnerScope> {
  if (ownerType === undefined && ownerId === undefined) return { ok: true };
  if (ownerType === undefined || ownerId === undefined) {
    return {
      ok: false,
      error: "Filter by owner with both ownerType and ownerId, or send neither.",
      status: 400,
    };
  }
  if (!isOwnerType(ownerType)) {
    return { ok: false, error: "ownerType must be 'user', 'team' or 'org'.", status: 400 };
  }
  const reachable = await isAuthorizedFor(db, caller, {
    orgId: caller.orgId,
    ownerType,
    ownerId,
  });
  // 404, and a message that repeats nothing back: an owner the caller cannot
  // reach must read exactly like an owner that does not exist.
  if (!reachable) return { ok: false, error: "owner not found", status: 404 };
  return { ok: true, scope: { type: ownerType, id: ownerId } };
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
  const { db } = c.var.providers;
  const caller = owner(c);
  const filter = await readOwnerScope(db, caller, c.req.query("ownerType"), c.req.query("ownerId"));
  if (!filter.ok) return c.json({ error: filter.error }, filter.status);

  const pluginSkills = ownedSkills(c.var.providers.plugins);
  const rows = await listSkills(db, caller, filter.scope);

  // Shadowing is a property of the caller's whole reach, never of the page
  // being read. `listSkills` returns personal rows before team rows and the
  // first of a repeated name is the one that reaches a session, so judging a
  // filtered page against itself drops the very row that wins: a team page
  // would report a team skill live while a personal copy of the same name
  // silently beat it everywhere. Judge against the unfiltered set, then show
  // only the rows this page asked for.
  const judged = filter.scope === undefined ? rows : await listSkills(db, caller);
  const { shadowed } = partitionByName(
    pluginSkills.map((entry) => entry.skill.name),
    judged,
  );
  const shadowedIds = new Set(shadowed.map((row) => row.id));
  const onPage = new Set(rows.map((row) => row.id));
  const kept = rows.filter((row) => !shadowedIds.has(row.id));
  const shadowedOnPage = shadowed.filter((row) => onPage.has(row.id));

  // Both kinds, in one list. A reader of this page asks "what can the
  // assistant read", and the answer includes the skills the installed
  // plugins ship — which is also the only way a shadow warning makes sense,
  // since the skill doing the shadowing is usually one of them.
  //
  // A filtered listing drops them: the filter selects rows BY owner, and a
  // plugin skill has no owner to select it by. It still shadows, and so does
  // a stored row from another workspace — see the `judged` set above, which
  // is why a filtered page can flag a row shadowed by something it does not
  // itself list.
  const resp: ListSkillsResponse = {
    skills: [
      ...(filter.scope ? [] : pluginSkills.map(toPluginSummary)),
      // Listing order matches delivery order, so the `kept` rows come first.
      ...[...kept, ...shadowedOnPage].map((row) => toStoredSummary(row, shadowedIds.has(row.id))),
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
  const caller = owner(c);
  const filter = await readOwnerScope(db, caller, c.req.query("ownerType"), c.req.query("ownerId"));
  if (!filter.ok) return c.json({ error: filter.error }, filter.status);

  const rows = await listSkillSources(db, caller, filter.scope);
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
  let sourceId: string;
  try {
    const row = await createSkillSource(db, owner(c), {
      repo: body.repo,
      ref: body.ref,
      subpath: body.subpath,
      teamId: body.teamId,
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
  const row = await ownedSkillSourceRow(db, owner(c), c.req.param("id"));
  if (!row) return c.json({ error: "skill source not found" }, 404);

  await markSkillSourceDue(db, row.id);
  const outcome = await skillSync.syncOnce(row.id);
  return c.json(await syncResponse(c, row.id, outcome));
});

skillsRouter.delete("/sources/:id", async (c) => {
  const { db } = c.var.providers;
  const deleted = await deleteSkillSource(db, owner(c), c.req.param("id"));
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
