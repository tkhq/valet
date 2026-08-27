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
 *
 * Both are keyset-paginated, in the shape the action log set
 * (`policies/admin.ts`): `?limit=` with a default and a cap, an opaque
 * `?cursor=` a client only passes back, and `nextCursor: null` on the last
 * page. The catalog walks ONE cursor over two sources — the in-memory plugin
 * skills first, then the stored rows — so a page boundary can fall between
 * them without repeating a skill or skipping one.
 *
 * The catalog also takes the Library's own three controls: `?scope=`,
 * `?kind=`, and `?q=`. They are applied here and not in the client because a
 * control that filtered one page would answer about that page while claiming
 * to answer about the library.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Principal, SkillSource, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { partitionByName } from "../plugins/assemble.js";
import { readLimit } from "../lib/page-cursor.js";
import {
  asRecord,
  createSkill,
  decodeSkillCursor,
  deleteSkill,
  encodeSkillCursor,
  isAuthorizedFor,
  listSkillNamesInReach,
  listSkills,
  listSkillsPage,
  PLUGIN_SKILL_RANK,
  rankOf,
  readableSkillRow,
  SKILL_DEFAULT_LIMIT,
  SKILL_MAX_LIMIT,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillReservedNameError,
  SkillValidationError,
  updateSkill,
  type SkillCursor,
  type SkillOwner,
} from "../services/skills.js";
import { isOrgAdmin } from "../services/org.js";
import {
  countSkillsPerSource,
  createSkillSource,
  decodeSkillSourceCursor,
  deleteSkillSource,
  listSkillSources,
  markSkillSourceDue,
  ownedSkillSourceRow,
  readableSkillSourceRow,
  SKILL_SOURCE_DEFAULT_LIMIT,
  SKILL_SOURCE_MAX_LIMIT,
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
  SkillSummary,
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
 * owner. This decides that here, in application code, against the caller's
 * OWN org — the same rule every row-level read of these two tables goes
 * through, so a filter can never surface what an unfiltered list hides.
 *
 * The rule a filter must agree with is the READ rule, not the write rule.
 * `isAuthorizedFor` answers "may this caller WRITE here", and it says no to
 * an org row for everybody but an org admin. Reading an org row is wider:
 * `readableSkillRow` gives every member every org row of their own org, and
 * both `listSkills` and `listSkillSources` put those rows in an unfiltered
 * listing. So `ownerType=org` is a filter any member may use, for the
 * caller's own org id alone — another org's id still reads as not found.
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
  // The org library belongs to the whole org, so its filter asks about the
  // org id and not about admin rights. User and team reach is unchanged.
  const reachable =
    ownerType === "org"
      ? ownerId === caller.orgId
      : await isAuthorizedFor(db, caller, {
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
  if (err instanceof SkillReservedNameError) return { body: { error: err.message }, status: 400 };
  if (err instanceof SkillValidationError) {
    return { body: { error: err.message, errors: err.errors }, status: 400 };
  }
  if (err instanceof SkillNameConflictError) return { body: { error: err.message }, status: 409 };
  if (err instanceof SkillNotLocalError) return { body: { error: err.message }, status: 409 };
  if (err instanceof NotFoundError) return { body: { error: err.message }, status: 404 };
  throw err;
}

// ── The Library filters ───────────────────────────────────────────────────
//
// The Library's chips, scope select, and search box are applied HERE, not in
// the client. A page is a slice of the catalog, so a filter applied to the
// slice alone answers about that slice while the control claims to answer
// about the catalog: a search would miss every match on a page not yet read.

type FilterCheck<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function readKind(raw: string | undefined): FilterCheck<"skill" | "prompt"> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "skill" || raw === "prompt") return { ok: true, value: raw };
  return { ok: false, error: "kind must be 'skill' or 'prompt'. Remove it to list both." };
}

const CATALOG_SCOPES = ["personal", "team", "org", "plugin"] as const;
type CatalogScope = (typeof CATALOG_SCOPES)[number];

function readCatalogScope(raw: string | undefined): FilterCheck<CatalogScope> {
  if (raw === undefined) return { ok: true, value: undefined };
  const found = CATALOG_SCOPES.find((s) => s === raw);
  if (found) return { ok: true, value: found };
  return {
    ok: false,
    error: "scope must be 'personal', 'team', 'org' or 'plugin'. Remove it to list every scope.",
  };
}

/** A plugin skill sorts before every stored row and carries its plugin name
 * where a stored row carries its id, so one cursor walks both. */
function pluginCursorKey(summary: PluginSkillSummary): SkillCursor {
  return { r: PLUGIN_SKILL_RANK, n: summary.name, id: summary.plugin };
}

/** Orders two plugin skills by the same key the cursor compares them with.
 * Plain `<` and not `localeCompare`: the cursor test below is a plain string
 * comparison, and a locale that disagrees with it would skip an entry or
 * hand the same one back twice. */
function byCursorKey(a: PluginSkillSummary, b: PluginSkillSummary): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.plugin !== b.plugin) return a.plugin < b.plugin ? -1 : 1;
  return 0;
}

/** Keeps the plugin skills that sort after `cursor`. Nothing survives a
 * cursor already past the plugin block. */
function pluginsAfter(summaries: PluginSkillSummary[], cursor: SkillCursor | undefined): PluginSkillSummary[] {
  const sorted = [...summaries].sort(byCursorKey);
  if (!cursor) return sorted;
  if (cursor.r !== PLUGIN_SKILL_RANK) return [];
  return sorted.filter(
    (s) => s.name > cursor.n || (s.name === cursor.n && s.plugin > cursor.id),
  );
}

/** Applies the same three filters to the in-memory plugin skills the SQL
 * read applies to stored rows. A plugin skill never declares an invocation,
 * so it is always a plain skill and never a prompt. */
function keepPluginSkill(
  summary: PluginSkillSummary,
  filter: { kind?: "skill" | "prompt"; query?: string },
): boolean {
  if (filter.kind === "prompt") return false;
  if (filter.query === undefined || filter.query.length === 0) return true;
  const needle = filter.query.toLowerCase();
  return (
    summary.name.toLowerCase().includes(needle) ||
    (summary.description ?? "").toLowerCase().includes(needle)
  );
}

// ── Catalog ───────────────────────────────────────────────────────────────

skillsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const caller = owner(c);
  const ownerType = c.req.query("ownerType");
  // `pin`, not `filter`: this selects ONE owner by id, where the `scope`
  // below selects a class of owners. The two read alike and mean different
  // things, so they do not share a name in this handler.
  const pin = await readOwnerScope(db, caller, ownerType, c.req.query("ownerId"));
  if (!pin.ok) return c.json({ error: pin.error }, pin.status);

  const kind = readKind(c.req.query("kind"));
  if (!kind.ok) return c.json({ error: kind.error }, 400);
  const scope = readCatalogScope(c.req.query("scope"));
  if (!scope.ok) return c.json({ error: scope.error }, 400);
  // Two ways to name the same axis. The owner pin selects ONE owner by id;
  // `scope` selects a whole class of owners. Answering both at once would
  // mean silently ignoring one, so say which to drop.
  if (scope.value !== undefined && ownerType !== undefined) {
    return c.json(
      { error: "Filter by scope or by owner, not both. Remove scope, or remove ownerType and ownerId." },
      400,
    );
  }
  const query = c.req.query("q")?.trim();
  const limit = readLimit(c.req.query("limit"), SKILL_DEFAULT_LIMIT, SKILL_MAX_LIMIT);
  if (limit === undefined) {
    return c.json(
      { error: `limit must be a whole number of 1 or more. Remove it to take the default of ${SKILL_DEFAULT_LIMIT}.` },
      400,
    );
  }
  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam === undefined ? undefined : decodeSkillCursor(cursorParam);
  if (cursorParam !== undefined && cursor === undefined) {
    return c.json(
      { error: "That cursor is not one this listing issued. Remove it to start at the first page." },
      400,
    );
  }

  const catalogFilter = {
    ...(kind.value === undefined ? {} : { kind: kind.value }),
    ...(query === undefined || query.length === 0 ? {} : { query }),
  };

  // Both kinds, in one list. A reader of this page asks "what can the
  // assistant read", and the answer includes the skills the installed
  // plugins ship — which is also the only way a shadow warning makes sense,
  // since the skill doing the shadowing is usually one of them.
  //
  // An owner-pinned listing drops them: that filter selects rows BY owner,
  // and a plugin skill has no owner to select it by. They still shadow —
  // see `judged` below, which is why a pinned page can flag a row shadowed
  // by something it does not itself list.
  const pluginSkills = ownedSkills(c.var.providers.plugins);
  const wantsPlugins = pin.scope === undefined && (scope.value === undefined || scope.value === "plugin");
  const pluginPage = wantsPlugins
    ? pluginsAfter(
        pluginSkills.map(toPluginSummary).filter((s) => keepPluginSkill(s, catalogFilter)),
        cursor,
      )
    : [];

  // Stored rows fill whatever the plugin block leaves. One extra entry over
  // the limit is what says a further page exists.
  const wantStored = scope.value === "plugin" ? 0 : limit + 1 - pluginPage.length;
  const stored =
    wantStored > 0
      ? (
          await listSkillsPage(
            db,
            caller,
            pin.scope,
            {
              ...catalogFilter,
              ...(scope.value === undefined || scope.value === "plugin" ? {} : { scope: scope.value }),
            },
            wantStored,
            cursor,
          )
        ).rows
      : [];

  // Shadowing is a property of the caller's whole reach, never of the page
  // being read. Personal rows come before team rows and the first of a
  // repeated name is the one that reaches a session, so judging a page
  // against itself drops the very row that wins: a team page would report a
  // team skill live while a personal copy of the same name silently beat it
  // everywhere. Judge against the caller's whole reach — names only, so a
  // page request never pulls every skill body.
  const judged = await listSkillNamesInReach(db, caller);
  const { shadowed } = partitionByName(
    pluginSkills.map((entry) => entry.skill.name),
    judged,
  );
  const shadowedIds = new Set(shadowed.map((row) => row.id));

  const entries: Array<{ summary: SkillSummary; key: SkillCursor }> = [
    ...pluginPage.map((summary) => ({ summary, key: pluginCursorKey(summary) })),
    ...stored.map((row) => ({
      summary: toStoredSummary(row, shadowedIds.has(row.id)),
      key: { r: rankOf(row.ownerType), n: row.name, id: row.id },
    })),
  ];
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  const last = page[page.length - 1];

  const resp: ListSkillsResponse = {
    skills: page.map((entry) => entry.summary),
    nextCursor: hasMore && last ? encodeSkillCursor(last.key) : null,
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
  const caller = owner(c);
  const filter = await readOwnerScope(db, caller, c.req.query("ownerType"), c.req.query("ownerId"));
  if (!filter.ok) return c.json({ error: filter.error }, filter.status);

  const limit = readLimit(c.req.query("limit"), SKILL_SOURCE_DEFAULT_LIMIT, SKILL_SOURCE_MAX_LIMIT);
  if (limit === undefined) {
    return c.json(
      { error: `limit must be a whole number of 1 or more. Remove it to take the default of ${SKILL_SOURCE_DEFAULT_LIMIT}.` },
      400,
    );
  }
  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam === undefined ? undefined : decodeSkillSourceCursor(cursorParam);
  if (cursorParam !== undefined && cursor === undefined) {
    return c.json(
      { error: "That cursor is not one this listing issued. Remove it to start at the first page." },
      400,
    );
  }

  const page = await listSkillSources(db, caller, filter.scope, limit, cursor);
  // The count query is scoped to the page's ids, so it grows with the page
  // and not with the number of sources tracked.
  const counts = await countSkillsPerSource(
    db,
    page.rows.map((row) => row.id),
  );
  const resp: ListSkillSourcesResponse = {
    sources: page.rows.map((row) => toSourceSummary(row, counts.get(row.id) ?? 0)),
    nextCursor: page.nextCursor ?? null,
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
  // Sync is a read-side kick: any member who can see the row can bring the
  // sweep forward. Add and remove stay on ownedSkillSourceRow (admin for org).
  const row = await readableSkillSourceRow(db, owner(c), c.req.param("id"));
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
    discovered: outcome?.discovered ?? 0,
    excluded: outcome?.excluded ?? 0,
  };
}

/** Maps a source-service error onto its HTTP status. */
function sourceErrorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 404 | 409 } {
  if (err instanceof SkillSourceInputError) return { body: { error: err.message }, status: 400 };
  if (err instanceof SkillSourceConflictError) return { body: { error: err.message }, status: 409 };
  if (err instanceof NotFoundError) return { body: { error: err.message }, status: 404 };
  throw err;
}
