/**
 * Teams service — the org's membership structure (orchestrator spec,
 * "Identity"). Names unique per org (enforced at the schema level via
 * `teams_org_name`); last-admin guards on role change and removal, and
 * creator-auto-admin, are enforced here inside a single sqlite transaction
 * so a role-change and a removal racing on the same team's last admin can
 * never both succeed.
 *
 * Team-owned workflows don't exist yet (Phase 5+); `deleteTeam`'s
 * "blocked while team-owned workflows exist" guard is therefore a no-op
 * hook — see the comment on `assertNoTeamOwnedWorkflows` below.
 */
import { randomUUID } from "node:crypto";
import { SqliteError } from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { orgMembers, teamMembers, teams, type TeamRow } from "../schema/index.js";

export type TeamRole = "admin" | "member";

/** Thrown when creating a team whose name is already taken within the org. */
export class TeamNameConflictError extends Error {
  readonly code = "team_name_conflict";
  readonly statusCode = 409;
  constructor(orgId: string, name: string) {
    super(`team name '${name}' already exists in org ${orgId}`);
    this.name = "TeamNameConflictError";
  }
}

/**
 * Thrown when a role change or removal would leave a team with zero admins.
 * Checked and enforced inside the same transaction as the mutating write.
 */
export class LastAdminError extends Error {
  readonly code = "last_admin";
  readonly statusCode = 409;
  constructor(teamId: string) {
    super(`team ${teamId} must keep at least one admin`);
    this.name = "LastAdminError";
  }
}

/** Thrown when targeting a user who isn't a member of the team. */
export class NotTeamMemberError extends NotFoundError {
  constructor(teamId: string, userId: string) {
    super("team member", `${teamId}/${userId}`);
  }
}

/** Thrown when adding a user who isn't a member of the team's org. */
export class NotOrgMemberError extends NotFoundError {
  constructor(orgId: string, userId: string) {
    super("org member", `${orgId}/${userId}`);
  }
}

/** True when a sqlite unique-constraint violation fired on `teams_org_name`. */
function isTeamNameUniqueViolation(err: unknown): boolean {
  return (
    err instanceof SqliteError &&
    err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    err.message.includes("teams_org_name")
  );
}

function newTeamId(): string {
  return `team_${randomUUID()}`;
}

function countAdmins(db: AppQueryable, teamId: string): number {
  const rows = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")))
    .all();
  return rows.length;
}

function getMember(
  db: AppQueryable,
  teamId: string,
  userId: string,
): { teamId: string; userId: string; role: TeamRole } | undefined {
  return db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
}

export interface CreateTeamOptions {
  orgId: string;
  name: string;
  creatorUserId: string;
}

/**
 * Creates a team; the creator is auto-admitted as its first admin. The
 * name-conflict check runs inside the same transaction as the insert (plus
 * a belt-and-suspenders catch on the `teams_org_name` unique constraint) so
 * two concurrent creates of the same name can't both pass the pre-check and
 * race into a raw 500 — the loser always sees `TeamNameConflictError`.
 */
export async function createTeam(db: AppDb, opts: CreateTeamOptions): Promise<TeamRow> {
  const id = newTeamId();
  const now = Date.now();
  const row: TeamRow = { id, orgId: opts.orgId, name: opts.name, createdAt: now };

  try {
    db.transaction((tx) => {
      const existing = tx
        .select()
        .from(teams)
        .where(and(eq(teams.orgId, opts.orgId), eq(teams.name, opts.name)))
        .get();
      if (existing) throw new TeamNameConflictError(opts.orgId, opts.name);

      tx.insert(teams).values(row).run();
      tx.insert(teamMembers).values({ teamId: id, userId: opts.creatorUserId, role: "admin" }).run();
    });
  } catch (err) {
    if (isTeamNameUniqueViolation(err)) throw new TeamNameConflictError(opts.orgId, opts.name);
    throw err;
  }

  return row;
}

export interface AddMemberOptions {
  teamId: string;
  userId: string;
  role: TeamRole;
}

/**
 * Adds a member to a team. Adding an existing member updates their role.
 * Rejects with `NotOrgMemberError` if the target user isn't a member of the
 * team's org — otherwise any org member could add an arbitrary (or
 * cross-org) userId onto a team.
 */
export async function addMember(db: AppDb, opts: AddMemberOptions): Promise<void> {
  const team = db.select().from(teams).where(eq(teams.id, opts.teamId)).get();
  if (!team) throw new NotFoundError("team", opts.teamId);

  const targetOrgMember = db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, team.orgId), eq(orgMembers.userId, opts.userId)))
    .get();
  if (!targetOrgMember) throw new NotOrgMemberError(team.orgId, opts.userId);

  db.transaction((tx) => {
    const existing = getMember(tx, opts.teamId, opts.userId);
    if (existing) {
      tx.update(teamMembers)
        .set({ role: opts.role })
        .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)))
        .run();
    } else {
      tx.insert(teamMembers).values({ teamId: opts.teamId, userId: opts.userId, role: opts.role }).run();
    }
  });
}

export interface SetRoleOptions {
  teamId: string;
  userId: string;
  role: TeamRole;
}

/**
 * Changes a member's role. Rejects with `LastAdminError` when demoting the
 * team's sole remaining admin. Runs the read-check-write as one transaction
 * so a concurrent removal/demotion on the same team can't both succeed.
 */
export async function setRole(db: AppDb, opts: SetRoleOptions): Promise<void> {
  db.transaction((tx) => {
    const member = getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin" && opts.role === "member") {
      const admins = countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    tx.update(teamMembers)
      .set({ role: opts.role })
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)))
      .run();
  });
}

export interface RemoveMemberOptions {
  teamId: string;
  userId: string;
}

/**
 * Removes a member from a team. Rejects with `LastAdminError` when removing
 * the team's sole remaining admin, and `NotTeamMemberError` when the target
 * isn't a member. Atomic with the admin-count check (same transaction).
 */
export async function removeMember(db: AppDb, opts: RemoveMemberOptions): Promise<void> {
  db.transaction((tx) => {
    const member = getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin") {
      const admins = countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    tx.delete(teamMembers)
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)))
      .run();
  });
}

/** Lists every team the given user is currently a member of. */
export async function listTeamsForUser(db: AppDb, userId: string): Promise<TeamRow[]> {
  return db
    .select({
      id: teams.id,
      orgId: teams.orgId,
      name: teams.name,
      createdAt: teams.createdAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.createdAt)
    .all();
}

/**
 * Lists every team in an org, regardless of the caller's own membership.
 * Org admins manage the whole roster, not just teams they happen to belong
 * to — `listTeamsForUser` alone would hide a team from an admin who isn't
 * on it.
 */
export async function listTeamsForOrg(db: AppDb, orgId: string): Promise<TeamRow[]> {
  return db
    .select({
      id: teams.id,
      orgId: teams.orgId,
      name: teams.name,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(teams.createdAt)
    .all();
}

/** Lists a team's members (userId + role), for the teams settings panel. */
export async function listTeamMembers(
  db: AppDb,
  teamId: string,
): Promise<Array<{ userId: string; role: TeamRole }>> {
  return db
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId))
    .all();
}

/**
 * Deletion guard hook: the orchestrator spec blocks team deletion "while
 * team-owned workflows exist." Workflows don't exist in v2 yet (Phase 5/6),
 * so this is a deliberate no-op — wire the real check here once the
 * workflow host lands, before deleteTeam is exposed on any destructive UI
 * path.
 */
function assertNoTeamOwnedWorkflows(_teamId: string): void {
  // no-op — see doc comment above.
}

export interface DeleteTeamOptions {
  teamId: string;
}

/** Deletes a team and its memberships. */
export async function deleteTeam(db: AppDb, opts: DeleteTeamOptions): Promise<void> {
  const team = db.select().from(teams).where(eq(teams.id, opts.teamId)).get();
  if (!team) throw new NotFoundError("team", opts.teamId);

  assertNoTeamOwnedWorkflows(opts.teamId);

  db.transaction((tx) => {
    tx.delete(teamMembers).where(eq(teamMembers.teamId, opts.teamId)).run();
    tx.delete(teams).where(eq(teams.id, opts.teamId)).run();
  });
}
