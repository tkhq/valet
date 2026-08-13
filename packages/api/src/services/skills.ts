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
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { validateSkillFrontmatter, type Principal, type SkillSource } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
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

/** The ownership columns every skill-shaped row carries. */
export interface OwnerScope {
  orgId: string;
  ownerType: "user" | "team" | "org";
  ownerId: string;
}

/**
 * True when `owner` may WRITE a row: its direct user owner, or a live member
 * of its owning team. Org-owned rows return false here — an org-library skill
 * needs its own admin gate before a member may edit it. Note this governs
 * WRITES only: `listSkills` still delivers org rows to a member read-only, so
 * an org skill reaches the member's catalog and sessions without letting a
 * non-admin edit it.
 *
 * Exported because `services/skill-sources.ts` scopes tracked repositories
 * by exactly this rule. One implementation, so the two tables cannot drift.
 */
export async function isAuthorizedFor(
  db: AppDb,
  owner: SkillOwner,
  row: OwnerScope,
): Promise<boolean> {
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
 */
export async function listSkills(db: AppDb, owner: SkillOwner): Promise<SkillRow[]> {
  const teamIds = (await listTeamsForUser(db, owner.userId)).map((t) => t.id);
  const ownerMatch = and(eq(skills.ownerType, "user"), eq(skills.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(skills.ownerType, "team"), inArray(skills.ownerId, teamIds))
      : undefined;
  const orgMatch = eq(skills.ownerType, "org");

  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.orgId, owner.orgId),
        teamMatch ? or(ownerMatch, teamMatch, orgMatch) : or(ownerMatch, orgMatch),
      ),
    )
    .orderBy(asc(skills.name));

  // Explicit user → team → org assembly. Do not rely on incidental row order
  // from the query — the dedupe in `listSkillSourcesFor` is first-name-wins,
  // so this precedence must be deterministic in code.
  return [
    ...rows.filter((r) => r.ownerType === "user"),
    ...rows.filter((r) => r.ownerType === "team"),
    ...rows.filter((r) => r.ownerType === "org"),
  ];
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

  // `typeof === "string"`, not `!== undefined`: the route casts an unchecked
  // JSON body, so an explicit `teamId: null` from a client that always sends
  // the field must fall through to a personal skill.
  const teamId = typeof input.teamId === "string" ? input.teamId : undefined;
  const now = Date.now();
  const row: SkillRow = {
    id: newSkillId(),
    orgId: owner.orgId,
    ownerType: teamId ? "team" : "user",
    ownerId: teamId ?? owner.userId,
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
    if (teamId === undefined) {
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
): Promise<DeleteSkillResult> {
  const row = await ownedSkillRow(db, owner, id);
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
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}
