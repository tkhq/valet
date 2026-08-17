/**
 * Stored-skill operations, shared by the HTTP routes (`routes/skills.ts`)
 * and the session-delivery seam (`engine/host.ts`).
 *
 * Access follows `workflows/service.ts` exactly, and for the same reason: a
 * skill is an owned resource, so `ownedSkillRow` returns null for BOTH a
 * missing id and another owner's id (routes map that to 404, never 403), and
 * `listSkills` unions the caller's own rows with the rows of every team the
 * caller belongs to. Membership is re-read on every call, never cached — a
 * person removed from a team loses that team's skills on their next request.
 *
 * Every frontmatter rule is checked HERE, on write, against the same
 * `validateSkillFrontmatter` the plugin loader uses. Delivery
 * (`listSkillSourcesFor`) then reads plain columns and cannot throw. That
 * split is deliberate: the four session builders in `engine/host.ts` have no
 * try/catch, so a throw during skill assembly would stop the owner from
 * starting ANY session.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { validateSkillFrontmatter, BUILTIN_COMMAND_NAMES, type Principal, type SkillSource } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor } from "../lib/page-cursor.js";
import { skills, teamMembers, type SkillRow } from "../schema/index.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "./teams.js";

export type SkillOrigin = "local" | "repo";

/** The caller acting on stored skills. Same shape as `WorkflowOwner`. */
export interface SkillOwner {
  userId: string;
  orgId: string;
}

/** Thrown when the name or the description breaks the skill spec. */
export class SkillValidationError extends Error {
  readonly code = "skill_invalid";
  readonly statusCode = 400;
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`skill does not follow the skill spec: ${errors.join(" ")}`);
    this.name = "SkillValidationError";
    this.errors = errors;
  }
}

/** Thrown when a skill name matches a built-in command name. */
export class SkillReservedNameError extends Error {
  readonly code = "skill_reserved_name";
  readonly statusCode = 400;
  constructor(name: string) {
    super(`"${name}" is a reserved built-in command name. Pick a different name.`);
    this.name = "SkillReservedNameError";
  }
}

/** Thrown when a name is already taken inside one owner scope. */
export class SkillNameConflictError extends Error {
  readonly code = "skill_name_conflict";
  readonly statusCode = 409;
  constructor(name: string) {
    super(`a skill named '${name}' already exists here. Choose a different name.`);
    this.name = "SkillNameConflictError";
  }
}

/** Thrown when a write targets a skill Valet does not own the source of. */
export class SkillNotLocalError extends Error {
  readonly code = "skill_not_local";
  readonly statusCode = 409;
  constructor(id: string) {
    super(`skill ${id} comes from a repository. Edit it in the repository it came from.`);
    this.name = "SkillNotLocalError";
  }
}

export function newSkillId(): string {
  return `skill_${randomUUID()}`;
}

/** SHA-256 of the body, hex. Stored on write so a later importer can tell an
 * upstream edit from a no-op re-read without re-reading the body. */
export function skillContentSha(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Checks a name/description pair against the Agent Skills spec, through the
 * same validator `loadSkillFromMarkdown` uses. `directoryName` is omitted —
 * a stored skill has no directory, so the name-matches-directory rule does
 * not apply to it.
 *
 * Also rejects names that match a built-in command, so skills can never
 * shadow `help`, `status`, `stop`, or the other built-ins.
 */
function assertValidFrontmatter(name: string, description: string): void {
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(name)) {
    throw new SkillReservedNameError(name);
  }
  const violations = validateSkillFrontmatter({ name, description });
  if (violations.length > 0) {
    throw new SkillValidationError(violations.map((v) => v.message));
  }
}

/** The ownership columns every skill-shaped row carries. */
export interface OwnerScope {
  orgId: string;
  ownerType: "user" | "team" | "org";
  ownerId: string;
}

/**
 * True when `owner` may WRITE a row: its direct user owner, or a live member
 * of its owning team. Org-owned rows return true only when the caller is an
 * org admin — a non-admin member can read them (they show in `listSkills`)
 * but cannot edit or delete them.
 *
 * Pass `isOrgAdmin: true` (resolved by the caller) to unlock org-row writes.
 * Default `false` preserves the original semantics: `ownedSkillRow` and all
 * non-org write paths call this without the option and are unaffected.
 *
 * Exported because `services/skill-sources.ts` scopes tracked repositories
 * by exactly this rule. One implementation, so the two tables cannot drift.
 */
export async function isAuthorizedFor(
  db: AppDb,
  owner: SkillOwner,
  row: OwnerScope,
  opts: { isOrgAdmin?: boolean } = {},
): Promise<boolean> {
  if (row.orgId !== owner.orgId) return false;
  if (row.ownerType === "user") return row.ownerId === owner.userId;
  if (row.ownerType === "team") return isTeamMember(db, row.ownerId, owner.userId);
  // org row: only an org admin may write
  if (row.ownerType === "org") return opts.isOrgAdmin === true;
  return false;
}

/**
 * One row, or null when it is missing OR the caller may not reach it. The
 * two cases are deliberately indistinguishable — the same convention every
 * owned resource in this API follows.
 */
export async function ownedSkillRow(
  db: AppDb,
  owner: SkillOwner,
  id: string,
  opts: { isOrgAdmin?: boolean } = {},
): Promise<SkillRow | null> {
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await isAuthorizedFor(db, owner, row, opts)) ? row : null;
}

/**
 * One row a caller may READ, or null when it is missing OR out of reach.
 *
 * Read scope is wider than write scope: a member may read ANY row in their
 * own org, including an org-library row they cannot edit. So this returns the
 * row when `ownedSkillRow` would (user/team ownership, or an org row the
 * caller may write), and ALSO for any org-owned row in the caller's own org.
 *
 * The detail route (`GET /stored/:id`) uses this so opening an org skill's
 * page works for every member. Writes stay on `ownedSkillRow`, so a member
 * still cannot edit or delete an org row.
 */
export async function readableSkillRow(
  db: AppDb,
  owner: SkillOwner,
  id: string,
): Promise<SkillRow | null> {
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.orgId !== owner.orgId) return null;
  if (row.ownerType === "org") return row;
  return (await isAuthorizedFor(db, owner, row)) ? row : null;
}

/**
 * Every skill the caller can reach: their own rows first, then the rows of
 * the teams they belong to, then the org-library rows, each group sorted by
 * name.
 *
 * The user > team > org order is load-bearing. The unique index stops two
 * rows sharing a name inside ONE owner scope, but a personal, a team, and an
 * org skill may legitimately share one — and only one of them can reach a
 * session, because a skill name is the `skill` tool's lookup key.
 * `listSkillSourcesFor` keeps the first of a repeated name, so this order is
 * what makes "my own copy wins, then my team's, then the org's" true.
 *
 * Org-library rows are READ-ONLY to a member here: they show in the catalog
 * and reach the member's sessions, but `isAuthorizedFor` still returns false
 * for a non-admin org write, so `ownedSkillRow` (and every write path built
 * on it) never treats an org row as the caller's to edit.
 *
 * `scope` narrows the answer to ONE owner, for a client that shows one
 * workspace at a time. It replaces the union rather than adding to it: a
 * person who asks for a team's skills must not also get their own, and a
 * person who asks for the org library gets the org rows alone. The caller
 * decides whether `scope` may be reached BEFORE calling this — an ownerId off
 * a query string proves nothing, so `routes/skills.ts` runs it through
 * `readOwnerScope` first.
 */
export async function listSkills(
  db: AppDb,
  owner: SkillOwner,
  scope?: Principal,
): Promise<SkillRow[]> {
  const reach = await reachOfSkills(db, owner, scope);

  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, owner.orgId), reach))
    .orderBy(asc(skills.name));

  // Explicit user → team → org assembly. Do not rely on incidental row order
  // from the query — the dedupe in `listSkillSourcesFor` is first-name-wins,
  // so this precedence must be deterministic in code. A scoped read holds one
  // owner type, so for it the three groups collapse to one and the name order
  // above survives.
  return [
    ...rows.filter((r) => r.ownerType === "user"),
    ...rows.filter((r) => r.ownerType === "team"),
    ...rows.filter((r) => r.ownerType === "org"),
  ];
}

/**
 * The rows the caller may read, as one predicate: their own, the rows of
 * every team they belong to, and the org library. `scope` replaces that union
 * with the one owner it names — see `listSkills` for why it replaces rather
 * than adds. Shared by the full read and the paginated one so the two can
 * never disagree about reach.
 */
async function reachOfSkills(
  db: AppDb,
  owner: SkillOwner,
  scope: Principal | undefined,
): Promise<SQL | undefined> {
  // No team read when `scope` already names the one owner to list.
  const teamIds = scope ? [] : (await listTeamsForUser(db, owner.userId)).map((t) => t.id);
  const ownerMatch = and(eq(skills.ownerType, "user"), eq(skills.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(skills.ownerType, "team"), inArray(skills.ownerId, teamIds))
      : undefined;
  // Every org row in the caller's own org, because the org library is
  // readable by every member. The `orgId` predicate at the call site bounds it.
  const orgMatch = eq(skills.ownerType, "org");
  if (scope) return and(eq(skills.ownerType, scope.type), eq(skills.ownerId, scope.id));
  return teamMatch ? or(ownerMatch, teamMatch, orgMatch) : or(ownerMatch, orgMatch);
}

// ── The paginated catalog read ────────────────────────────────────────────

export const SKILL_DEFAULT_LIMIT = 24;
export const SKILL_MAX_LIMIT = 100;

/**
 * `user` before `team` before `org` — the delivery precedence `listSkills`
 * documents, written as a sort key so a page boundary cannot break it.
 * Plugin skills rank 0 and are merged in by `routes/skills.ts`, because they
 * live in memory and win every name clash.
 */
export const PLUGIN_SKILL_RANK = 0;
const OWNER_RANK = sql<number>`case ${skills.ownerType} when 'user' then 1 when 'team' then 2 else 3 end`;

/** What the Library's filter controls narrow the catalog by. Every one is
 * applied HERE and not in the client, because a filter applied to a page
 * alone would answer about that page while claiming to answer about the
 * catalog. */
export interface SkillCatalogFilter {
  /** `prompt` keeps the prompt-invocation skills; `skill` keeps the rest. */
  kind?: "skill" | "prompt";
  /** One library scope. `plugin` holds no stored row, so the route skips
   * this read entirely for it. */
  scope?: "personal" | "team" | "org";
  /** Case-insensitive substring over name and description. */
  query?: string;
}

/** The sort key of the last row of a page. `r` is the owner rank above, `n`
 * the name, `id` the tiebreaker for one name held in two owner scopes. */
export interface SkillCursor {
  r: number;
  n: string;
  id: string;
}

export function encodeSkillCursor(cursor: SkillCursor): string {
  return encodePageCursor({ ...cursor });
}

/** `undefined` for a cursor this listing did not issue. The route answers
 * that with 400 rather than silently restarting at page one. */
export function decodeSkillCursor(raw: string): SkillCursor | undefined {
  const fields = decodePageCursor(raw);
  if (!fields) return undefined;
  const { r, n, id } = fields;
  if (typeof r !== "number" || typeof n !== "string" || typeof id !== "string") return undefined;
  return { r, n, id };
}

export interface SkillPage {
  rows: SkillRow[];
  nextCursor: string | undefined;
}

/** Escapes the LIKE wildcards so a person searching for `100%` searches for
 * that text and not for "anything". Backslash is Postgres's default LIKE
 * escape character, so no ESCAPE clause is needed. */
function containsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * One page of the caller's reachable stored skills, ordered
 * `(owner rank, name, id)` and filtered by `filter`.
 *
 * Keyset-paginated, the same shape the action log uses
 * (`policies/admin.ts`): the cursor holds the last row's sort key, so a skill
 * written while somebody reads page two never shifts a row onto a page
 * already read or off one not yet read, which `OFFSET` would. `limit + 1`
 * rows are fetched to learn whether a further page exists without a second
 * COUNT.
 *
 * This read answers "what is on this page". It cannot answer which rows are
 * shadowed — that is a property of the caller's WHOLE reach — so the route
 * asks `listSkillNamesInReach` for that separately.
 */
export async function listSkillsPage(
  db: AppDb,
  owner: SkillOwner,
  scope: Principal | undefined,
  filter: SkillCatalogFilter,
  limit: number,
  cursor: SkillCursor | undefined,
): Promise<SkillPage> {
  const conditions = [eq(skills.orgId, owner.orgId), await reachOfSkills(db, owner, scope)];

  if (filter.scope !== undefined) {
    conditions.push(eq(skills.ownerType, filter.scope === "personal" ? "user" : filter.scope));
  }
  if (filter.kind !== undefined) {
    // `invocation` rides in the frontmatter document, not in a column of its
    // own. An absent value means the `context` default, so "not a prompt" has
    // to hold for NULL as well — `is distinct from` does, `<>` does not.
    const invocation = sql`${skills.frontmatter}->>'invocation'`;
    conditions.push(
      filter.kind === "prompt"
        ? sql`${invocation} = 'prompt'`
        : sql`${invocation} is distinct from 'prompt'`,
    );
  }
  if (filter.query !== undefined && filter.query.length > 0) {
    const pattern = containsPattern(filter.query);
    conditions.push(or(ilike(skills.name, pattern), ilike(skills.description, pattern)));
  }
  if (cursor) {
    conditions.push(
      sql`(${OWNER_RANK}, ${skills.name}, ${skills.id}) > (${cursor.r}, ${cursor.n}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select()
    .from(skills)
    .where(and(...conditions))
    .orderBy(OWNER_RANK, asc(skills.name), asc(skills.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      hasMore && last
        ? encodeSkillCursor({ r: rankOf(last.ownerType), n: last.name, id: last.id })
        : undefined,
  };
}

/** The rank `OWNER_RANK` computes, for building a cursor out of a row. */
export function rankOf(ownerType: "user" | "team" | "org"): number {
  return ownerType === "user" ? 1 : ownerType === "team" ? 2 : 3;
}

/** Name and owner of every stored skill the caller can reach, in delivery
 * precedence, with no body. This is what decides the `shadowed` flag: the
 * flag is a property of the whole reach, so it cannot be read off one page,
 * and reading full rows to answer it would pull every skill body on every
 * page request. */
export interface SkillNameRow {
  id: string;
  name: string;
}

export async function listSkillNamesInReach(
  db: AppDb,
  owner: SkillOwner,
): Promise<SkillNameRow[]> {
  return db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(and(eq(skills.orgId, owner.orgId), await reachOfSkills(db, owner, undefined)))
    .orderBy(OWNER_RANK, asc(skills.name), asc(skills.id));
}

export interface CreateSkillInput {
  name: string;
  description: string;
  /** The body, with no frontmatter. */
  content: string;
  /** Creates the skill for a team the caller belongs to instead of for the
   * caller. A team the caller is not on is rejected as not found. */
  teamId?: string;
  /** Creates the skill for the org instead of for the caller.
   * Only accepted when `isOrgAdmin` is `true`; ignored otherwise. */
  ownerType?: "user" | "team" | "org";
  /** Defaults to `local`. The repository importer passes `repo`. */
  origin?: SkillOrigin;
  sourceId?: string;
  upstreamPath?: string;
  /** Frontmatter fields beyond `name`/`description`, e.g. `license`. */
  frontmatter?: Record<string, unknown>;
  /**
   * How the engine expands this skill as a slash command.
   * `"context"` (default) wraps the body in `<skill>` tags;
   * `"prompt"` substitutes args and sends the body bare.
   */
  invocation?: "context" | "prompt";
  /**
   * Hint shown in the command palette for the first argument.
   * Meaningful only for `invocation: "prompt"` skills.
   */
  argHint?: string;
  /**
   * When `ownerType` is `"org"`, the caller must be an org admin.
   * Pass `true` after checking — the service trusts this flag.
   */
  isOrgAdmin?: boolean;
}

/**
 * Inserts a skill for the caller, for a team the caller belongs to, or for
 * the org when the caller is an org admin.
 *
 * A team the caller is not a member of is reported as not found, so team
 * membership never leaks to a probe — the same rule
 * `createWorkflowDefinition` follows.
 */
export async function createSkill(
  db: AppDb,
  owner: SkillOwner,
  input: CreateSkillInput,
): Promise<SkillRow> {
  assertValidFrontmatter(input.name, input.description);

  // `typeof === "string"`, not `!== undefined`: the route casts an unchecked
  // JSON body, so an explicit `teamId: null` from a client that always sends
  // the field must fall through to a personal skill.
  const teamId = typeof input.teamId === "string" ? input.teamId : undefined;
  const isOrgOwned = input.ownerType === "org";

  // Build the frontmatter object, merging invocation and argHint when present.
  const fm: Record<string, unknown> = {
    ...(input.frontmatter ?? {}),
    name: input.name,
    description: input.description,
  };
  if (input.invocation !== undefined) fm.invocation = input.invocation;
  if (input.argHint !== undefined) fm.argHint = input.argHint;

  const now = Date.now();
  const row: SkillRow = {
    id: newSkillId(),
    orgId: owner.orgId,
    ownerType: isOrgOwned ? "org" : teamId ? "team" : "user",
    ownerId: isOrgOwned ? owner.orgId : teamId ?? owner.userId,
    origin: input.origin ?? "local",
    sourceId: input.sourceId ?? null,
    name: input.name,
    description: input.description,
    content: input.content,
    frontmatter: fm,
    contentSha: skillContentSha(input.content),
    upstreamPath: input.upstreamPath ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    if (isOrgOwned || teamId === undefined) {
      await db.insert(skills).values(row);
    } else {
      // The membership check and the insert run inside one transaction
      // holding `lockTeamForOwnership`'s advisory lock, so this cannot race
      // `deleteTeam` — without it, a skill could be inserted for a team
      // whose rows are deleted in the gap between the check and the insert,
      // stranding it permanently. `db.transaction` alone is not enough; see
      // that lock's own doc comment.
      await db.transaction(async (tx) => {
        await lockTeamForOwnership(tx, teamId);
        // A non-member and an unknown team look identical here, so a team's
        // existence never leaks to a probe.
        if (!(await isTeamMember(tx, teamId, owner.userId))) {
          throw new NotFoundError("team", teamId);
        }
        await tx.insert(skills).values(row);
      });
    }
  } catch (err) {
    // The only unique index on this table is `skills_owner_name` (ids are
    // freshly minted UUIDs), so a unique violation is always a name clash.
    if (isPgUniqueViolation(err)) throw new SkillNameConflictError(input.name);
    throw err;
  }
  return row;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  /**
   * How the engine expands this skill as a slash command.
   * When present, replaces the stored value.
   */
  invocation?: "context" | "prompt";
  /**
   * Hint shown in the command palette for the first argument.
   * When present, replaces the stored value.
   */
  argHint?: string;
  /**
   * When the row is org-owned, the caller must be an org admin to edit it.
   * Pass `true` after checking — the service trusts this flag.
   */
  isOrgAdmin?: boolean;
}

/**
 * Edits a local skill. Returns null when the id is missing or unreachable —
 * same null-for-both rule as `ownedSkillRow`. Throws `SkillNotLocalError`
 * for a repo-origin row: its body belongs to the repository, and an edit
 * here would be overwritten by the next sync.
 */
export async function updateSkill(
  db: AppDb,
  owner: SkillOwner,
  id: string,
  input: UpdateSkillInput,
): Promise<SkillRow | null> {
  const row = await ownedSkillRow(db, owner, id, { isOrgAdmin: input.isOrgAdmin });
  if (!row) return null;
  if (row.origin !== "local") throw new SkillNotLocalError(id);

  const name = input.name ?? row.name;
  const description = input.description ?? row.description;
  const content = input.content ?? row.content;
  assertValidFrontmatter(name, description);

  // Merge invocation/argHint into frontmatter, preserving existing values
  // when the caller omits them (undefined = keep stored; explicit value = replace).
  const existingFm = asRecord(row.frontmatter);
  const fm: Record<string, unknown> = { ...existingFm, name, description };
  if (input.invocation !== undefined) fm.invocation = input.invocation;
  if (input.argHint !== undefined) fm.argHint = input.argHint;

  const updated: SkillRow = {
    ...row,
    name,
    description,
    content,
    frontmatter: fm,
    contentSha: skillContentSha(content),
    updatedAt: Date.now(),
  };

  try {
    const written = await db
      .update(skills)
      .set({
        name: updated.name,
        description: updated.description,
        content: updated.content,
        frontmatter: updated.frontmatter,
        contentSha: updated.contentSha,
        updatedAt: updated.updatedAt,
      })
      .where(writeScope(owner, row))
      .returning({ id: skills.id });
    // The scope above re-asks in the database what `ownedSkillRow` read a
    // moment ago. Nothing matched means the row stopped being this caller's
    // local skill in between — the team was deleted, or their membership of
    // it was revoked — and the caller must not be told the edit landed.
    if (written.length === 0) return null;
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new SkillNameConflictError(name);
    throw err;
  }
  return updated;
}

/**
 * The predicate a write must carry to be safe on its own.
 *
 * `ownedSkillRow` answers "may this caller write this row" with a SELECT,
 * and a write that then filters on `id` alone trusts an answer the database
 * is no longer being asked. The owner columns and `origin` never change
 * after insert, so repeating them proves nothing on its own — the answer
 * that CAN go stale is team membership, which an admin may revoke in the gap
 * between the two statements. This restates the membership check inside the
 * write, so one statement under one snapshot decides.
 *
 * A transaction would not be enough on its own, and the advisory lock is the
 * wrong tool: `removeMember` never takes it, so locking here would serialize
 * against the wrong party.
 */
export function writeScope(owner: SkillOwner, row: SkillRow) {
  return and(
    eq(skills.id, row.id),
    eq(skills.orgId, owner.orgId),
    eq(skills.ownerType, row.ownerType),
    eq(skills.ownerId, row.ownerId),
    eq(skills.origin, row.origin),
    row.ownerType === "team"
      ? sql`exists (select 1 from ${teamMembers} where ${teamMembers.teamId} = ${row.ownerId} and ${teamMembers.userId} = ${owner.userId})`
      : undefined,
  );
}

export type DeleteSkillResult = "deleted" | "not_found" | "not_local";

/** Hard-deletes a local skill. A repo-origin row reports `not_local`: the
 * next sync would recreate it, so removal belongs at its source. */
export async function deleteSkill(
  db: AppDb,
  owner: SkillOwner,
  id: string,
  opts: { isOrgAdmin?: boolean } = {},
): Promise<DeleteSkillResult> {
  const row = await ownedSkillRow(db, owner, id, opts);
  if (!row) return "not_found";
  if (row.origin !== "local") return "not_local";
  const removed = await db.delete(skills).where(writeScope(owner, row)).returning({ id: skills.id });
  // Same reasoning as `updateSkill`: the write carries its own authority
  // check, and a row that stopped matching reports not found.
  return removed.length > 0 ? "deleted" : "not_found";
}

/**
 * The stored skills a session owned by `principal` gets, as engine
 * `SkillSource`s.
 *
 * Scope by principal type:
 *   - `user` — that person's own skills, then the skills of every team they
 *     belong to, then the org-library skills. The same union `listSkills`
 *     returns, deduped user > team > org (first name wins).
 *   - `team` — that team's skills only. A team-owned session is shared, so
 *     one member's personal skills must not appear in it.
 *   - `org`  — that org's own skills only.
 *
 * A repeated name keeps the FIRST row and drops the rest. It never throws:
 * this runs inside a session build with no try/catch above it, so a throw
 * would stop the owner from starting any session at all. Plugin skills are
 * added on top of this list by `pluginSessionExtras`, which applies the same
 * first-wins rule with the plugin set holding the names.
 */
export async function listSkillSourcesFor(
  db: AppDb,
  principal: Principal,
  orgId: string,
): Promise<SkillSource[]> {
  const rows = await rowsForPrincipal(db, principal, orgId);
  const seen = new Set<string>();
  const sources: SkillSource[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    sources.push(rowToSkillSource(row));
  }
  return sources;
}

async function rowsForPrincipal(db: AppDb, principal: Principal, orgId: string): Promise<SkillRow[]> {
  if (principal.type === "user") {
    return listSkills(db, { userId: principal.id, orgId });
  }
  return db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.orgId, orgId),
        eq(skills.ownerType, principal.type),
        eq(skills.ownerId, principal.id),
      ),
    )
    .orderBy(asc(skills.name));
}

/** A row as the engine sees it. `source` records where the markdown came
 * from: `user` for a skill someone wrote here, `repo` for a synced one.
 *
 * `invocation` and `argHint` are read out of the `frontmatter` jsonb column
 * (a stored prompt skill carries `invocation: "prompt"` there): they drive how
 * the engine expands the slash command — a `"prompt"` skill substitutes args
 * into its body and sends bare, a `"context"` skill wraps in `<skill>` tags.
 * Both are omitted when absent or the wrong type, so the engine falls back to
 * its `"context"` default. */
export function rowToSkillSource(row: SkillRow): SkillSource {
  const fm = asRecord(row.frontmatter);
  const invocation = fm.invocation === "context" || fm.invocation === "prompt" ? fm.invocation : undefined;
  const argHint = typeof fm.argHint === "string" ? fm.argHint : undefined;
  return {
    name: row.name,
    description: row.description,
    content: row.content,
    source: row.origin === "repo" ? "repo" : "user",
    ...(invocation ? { invocation } : {}),
    ...(argHint ? { argHint } : {}),
  };
}

/** `frontmatter` is a jsonb column, so drizzle types it as `unknown`. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}
