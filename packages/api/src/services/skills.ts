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
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { validateSkillFrontmatter, type Principal, type SkillSource } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { skills, type SkillRow } from "../schema/index.js";
import { isTeamMember, listTeamsForUser } from "./teams.js";

export type SkillOrigin = "local" | "repo";
export type SkillOwnerType = "user" | "team" | "org";

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
 */
function assertValidFrontmatter(name: string, description: string): void {
  const violations = validateSkillFrontmatter({ name, description });
  if (violations.length > 0) {
    throw new SkillValidationError(violations.map((v) => v.message));
  }
}

/** True when `owner` may act on a row: its direct user owner, or a live
 * member of its owning team. Org-owned rows are readable by nobody yet —
 * nothing creates one, and an org-wide skill needs its own admin gate. */
async function isAuthorizedFor(db: AppDb, owner: SkillOwner, row: SkillRow): Promise<boolean> {
  if (row.orgId !== owner.orgId) return false;
  if (row.ownerType === "user") return row.ownerId === owner.userId;
  if (row.ownerType === "team") return isTeamMember(db, row.ownerId, owner.userId);
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
): Promise<SkillRow | null> {
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await isAuthorizedFor(db, owner, row)) ? row : null;
}

/**
 * Every skill the caller can reach: their own rows first, then the rows of
 * the teams they belong to, each group sorted by name.
 *
 * The personal-before-team order is load-bearing. The unique index stops two
 * rows sharing a name inside ONE owner scope, but a personal skill and a
 * team skill may legitimately share one — and only one of them can reach a
 * session, because a skill name is the `skill` tool's lookup key.
 * `listSkillSourcesFor` keeps the first of a repeated name, so this order is
 * what makes "my own copy wins" true.
 */
export async function listSkills(db: AppDb, owner: SkillOwner): Promise<SkillRow[]> {
  const teamIds = (await listTeamsForUser(db, owner.userId)).map((t) => t.id);
  const ownerMatch = and(eq(skills.ownerType, "user"), eq(skills.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(skills.ownerType, "team"), inArray(skills.ownerId, teamIds))
      : undefined;

  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, owner.orgId), teamMatch ? or(ownerMatch, teamMatch) : ownerMatch))
    .orderBy(asc(skills.name));

  return [...rows.filter((r) => r.ownerType === "user"), ...rows.filter((r) => r.ownerType !== "user")];
}

export interface CreateSkillInput {
  name: string;
  description: string;
  /** The body, with no frontmatter. */
  content: string;
  /** Creates the skill for a team the caller belongs to instead of for the
   * caller. A team the caller is not on is rejected as not found. */
  teamId?: string;
  /** Defaults to `local`. The repository importer passes `repo`. */
  origin?: SkillOrigin;
  sourceId?: string;
  upstreamPath?: string;
  /** Frontmatter fields beyond `name`/`description`, e.g. `license`. */
  frontmatter?: Record<string, unknown>;
}

/**
 * Inserts a skill for the caller, or for a team the caller belongs to.
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

  let ownerType: SkillOwnerType = "user";
  let ownerId = owner.userId;
  // `typeof === "string"`, not `!== undefined`: the route casts an unchecked
  // JSON body, so an explicit `teamId: null` from a client that always sends
  // the field must fall through to a personal skill.
  if (typeof input.teamId === "string") {
    // A non-member and an unknown team look identical here, so a team's
    // existence never leaks to a probe.
    if (!(await isTeamMember(db, input.teamId, owner.userId))) {
      throw new NotFoundError("team", input.teamId);
    }
    ownerType = "team";
    ownerId = input.teamId;
  }

  const now = Date.now();
  const row: SkillRow = {
    id: newSkillId(),
    orgId: owner.orgId,
    ownerType,
    ownerId,
    origin: input.origin ?? "local",
    sourceId: input.sourceId ?? null,
    name: input.name,
    description: input.description,
    content: input.content,
    frontmatter: { ...(input.frontmatter ?? {}), name: input.name, description: input.description },
    contentSha: skillContentSha(input.content),
    upstreamPath: input.upstreamPath ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insert(skills).values(row);
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
  const row = await ownedSkillRow(db, owner, id);
  if (!row) return null;
  if (row.origin !== "local") throw new SkillNotLocalError(id);

  const name = input.name ?? row.name;
  const description = input.description ?? row.description;
  const content = input.content ?? row.content;
  assertValidFrontmatter(name, description);

  const updated: SkillRow = {
    ...row,
    name,
    description,
    content,
    frontmatter: { ...asRecord(row.frontmatter), name, description },
    contentSha: skillContentSha(content),
    updatedAt: Date.now(),
  };

  try {
    await db
      .update(skills)
      .set({
        name: updated.name,
        description: updated.description,
        content: updated.content,
        frontmatter: updated.frontmatter,
        contentSha: updated.contentSha,
        updatedAt: updated.updatedAt,
      })
      .where(eq(skills.id, id));
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new SkillNameConflictError(name);
    throw err;
  }
  return updated;
}

export type DeleteSkillResult = "deleted" | "not_found" | "not_local";

/** Hard-deletes a local skill. A repo-origin row reports `not_local`: the
 * next sync would recreate it, so removal belongs at its source. */
export async function deleteSkill(
  db: AppDb,
  owner: SkillOwner,
  id: string,
): Promise<DeleteSkillResult> {
  const row = await ownedSkillRow(db, owner, id);
  if (!row) return "not_found";
  if (row.origin !== "local") return "not_local";
  await db.delete(skills).where(eq(skills.id, id));
  return "deleted";
}

/**
 * The stored skills a session owned by `principal` gets, as engine
 * `SkillSource`s.
 *
 * Scope by principal type:
 *   - `user` — that person's own skills, plus the skills of every team they
 *     belong to. The same union `listSkills` returns.
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
        eq(skills.ownerId, principal.type === "org" ? orgId : principal.id),
      ),
    )
    .orderBy(asc(skills.name));
}

/** A row as the engine sees it. `source` records where the markdown came
 * from: `user` for a skill someone wrote here, `repo` for a synced one. */
export function rowToSkillSource(row: SkillRow): SkillSource {
  return {
    name: row.name,
    description: row.description,
    content: row.content,
    source: row.origin === "repo" ? "repo" : "user",
  };
}

/** `frontmatter` is a jsonb column, so drizzle types it as `unknown`. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}
