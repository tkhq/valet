/**
 * Teams service — the org's membership structure (orchestrator spec,
 * "Identity"). Names unique per org (enforced at the schema level via
 * `teams_org_name`); last-admin guards on role change and removal, and
 * creator-auto-admin, are enforced here inside a single sqlite transaction
 * so a role-change and a removal racing on the same team's last admin can
 * never both succeed.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import {
  orgMembers,
  skills,
  skillSources,
  teamMembers,
  teams,
  workflowDefinitions,
  type TeamRow,
} from "../schema/index.js";

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

/** Thrown by `deleteTeam` when the team still owns one or more workflows. */
export class TeamOwnsWorkflowsError extends Error {
  readonly code = "team_owns_workflows";
  readonly statusCode = 409;
  constructor(teamId: string) {
    super(`team ${teamId} still owns one or more workflows — reassign or delete them first`);
    this.name = "TeamOwnsWorkflowsError";
  }
}

/** Names which mutation a guard refused, so the message can name the fix. */
export type IdpManagedMutation = "membership" | "delete";

/** The fields a refusal message needs. Any team row satisfies it. */
export interface IdpManagedTeamRef {
  name: string;
  externalId: string | null;
}

/**
 * One wording for both guards. The routes build the refusal from the row
 * they already loaded; the service builds it from its own read. The two must
 * never drift, so both come through here.
 */
export function idpManagedTeamMessage(team: IdpManagedTeamRef, mutation: IdpManagedMutation): string {
  // The sync sets `external_id` on every team it creates. The name is a
  // fallback, so a row that somehow lost the path still points somewhere.
  const group = team.externalId ?? team.name;
  if (mutation === "delete") {
    return (
      `team '${team.name}' mirrors identity provider group '${group}' — ` +
      `delete that group in the identity provider to empty the team. ` +
      `Valet keeps the team itself.`
    );
  }
  return (
    `team '${team.name}' mirrors identity provider group '${group}' — ` +
    `add or remove people in that group in the identity provider, then ask them to sign in again`
  );
}

/**
 * Thrown when a mutation targets a team that mirrors an identity-provider
 * group. The identity provider owns that team's membership, so Valet must
 * not change it: a local edit would survive only until the next sign-in,
 * and it would read as data loss when the sync put it back.
 *
 * The routes refuse the same four mutations before they ever reach the
 * service. This class is the second line — it catches a caller that reaches
 * the service directly, and it keeps the refusal with the rule it enforces.
 *
 * The team sync is the deliberate exception. It writes `team_members`
 * directly and never calls the guarded functions, the same way `skill-sync`
 * owns its `repo`-origin skill rows.
 */
export class IdpManagedTeamError extends Error {
  readonly code = "team_idp_managed";
  readonly statusCode = 409;
  constructor(team: IdpManagedTeamRef, mutation: IdpManagedMutation) {
    super(idpManagedTeamMessage(team, mutation));
    this.name = "IdpManagedTeamError";
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

/** True when a Postgres unique-constraint violation fired — within
 * `createTeam`'s transaction, the only unique index that can fire is
 * `teams_org_name` (team ids are freshly minted UUIDs). */
function isTeamNameUniqueViolation(err: unknown): boolean {
  return isPgUniqueViolation(err);
}

function newTeamId(): string {
  return `team_${randomUUID()}`;
}

async function countAdmins(db: AppQueryable, teamId: string): Promise<number> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  return rows.length;
}

/**
 * Refuses the mutation when the team mirrors an identity-provider group.
 *
 * A missing team is not this guard's business. Each caller already reports
 * its own not-found, and inventing a second one here would change what a
 * caller sees for a team id that never existed.
 */
async function assertNotIdpManaged(
  db: AppQueryable,
  teamId: string,
  mutation: IdpManagedMutation,
): Promise<void> {
  const rows = await db
    .select({ name: teams.name, origin: teams.origin, externalId: teams.externalId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  const team = rows[0];
  if (team?.origin === "idp") throw new IdpManagedTeamError(team, mutation);
}

async function getMember(
  db: AppQueryable,
  teamId: string,
  userId: string,
): Promise<{ teamId: string; userId: string; role: TeamRole } | undefined> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows[0];
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
  // A team created through this service is always `local`: it belongs to the
  // org, not to an identity provider, so no group sync may ever rewrite it.
  const row: TeamRow = {
    id,
    orgId: opts.orgId,
    name: opts.name,
    origin: "local",
    externalId: null,
    createdAt: now,
  };

  try {
    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(teams)
        .where(and(eq(teams.orgId, opts.orgId), eq(teams.name, opts.name)))
        .limit(1);
      if (existingRows[0]) throw new TeamNameConflictError(opts.orgId, opts.name);

      await tx.insert(teams).values(row);
      await tx.insert(teamMembers).values({ teamId: id, userId: opts.creatorUserId, role: "admin" });
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
 * cross-org) userId onto a team. Rejects with `IdpManagedTeamError` on a
 * team that mirrors a group: only the sync writes those memberships.
 */
export async function addMember(db: AppDb, opts: AddMemberOptions): Promise<void> {
  const teamRows = await db.select().from(teams).where(eq(teams.id, opts.teamId)).limit(1);
  const team = teamRows[0];
  if (!team) throw new NotFoundError("team", opts.teamId);
  // The row is already here, so check it directly instead of re-reading.
  if (team.origin === "idp") throw new IdpManagedTeamError(team, "membership");

  const targetOrgMemberRows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, team.orgId), eq(orgMembers.userId, opts.userId)))
    .limit(1);
  if (!targetOrgMemberRows[0]) throw new NotOrgMemberError(team.orgId, opts.userId);

  await db.transaction(async (tx) => {
    const existing = await getMember(tx, opts.teamId, opts.userId);
    if (existing) {
      await tx
        .update(teamMembers)
        .set({ role: opts.role })
        .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
    } else {
      await tx.insert(teamMembers).values({ teamId: opts.teamId, userId: opts.userId, role: opts.role });
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
 * team's sole remaining admin, and with `IdpManagedTeamError` on a team that
 * mirrors a group. Runs the read-check-write as one transaction so a
 * concurrent removal/demotion on the same team can't both succeed.
 */
export async function setRole(db: AppDb, opts: SetRoleOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await assertNotIdpManaged(tx, opts.teamId, "membership");
    const member = await getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin" && opts.role === "member") {
      const admins = await countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    await tx
      .update(teamMembers)
      .set({ role: opts.role })
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
  });
}

export interface RemoveMemberOptions {
  teamId: string;
  userId: string;
}

/**
 * Removes a member from a team. Rejects with `LastAdminError` when removing
 * the team's sole remaining admin, `NotTeamMemberError` when the target
 * isn't a member, and `IdpManagedTeamError` on a team that mirrors a group.
 * Atomic with the admin-count check (same transaction).
 */
export async function removeMember(db: AppDb, opts: RemoveMemberOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await assertNotIdpManaged(tx, opts.teamId, "membership");
    const member = await getMember(tx, opts.teamId, opts.userId);
    if (!member) throw new NotTeamMemberError(opts.teamId, opts.userId);

    if (member.role === "admin") {
      const admins = await countAdmins(tx, opts.teamId);
      if (admins <= 1) throw new LastAdminError(opts.teamId);
    }

    await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)));
  });
}

/** Lists every team the given user is currently a member of. */
export async function listTeamsForUser(db: AppDb, userId: string): Promise<TeamRow[]> {
  return db
    .select({
      id: teams.id,
      orgId: teams.orgId,
      name: teams.name,
      origin: teams.origin,
      externalId: teams.externalId,
      createdAt: teams.createdAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.createdAt);
}

/**
 * Live membership check — re-queries on every call, never cached. Per the
 * orchestrator spec's access model: "Eligibility is re-checked at action
 * time, not delivery time" — a member removed from a team must lose access
 * to its resources on their very next request, not at the next snapshot.
 * This is the sole access path to any team-owned resource (memory,
 * workflows, sessions, credentials): no creator shortcut, no org-visible
 * fallback.
 */
export async function isTeamMember(db: AppQueryable, teamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
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
      origin: teams.origin,
      externalId: teams.externalId,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(teams.createdAt);
}

/** Lists a team's members (userId + role), for the teams settings panel. */
export async function listTeamMembers(
  db: AppDb,
  teamId: string,
): Promise<Array<{ userId: string; role: TeamRole }>> {
  return db
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
}

/**
 * Deletion guard: the orchestrator spec blocks team deletion "while
 * team-owned workflows exist" — a deleted team's `ownerId` would otherwise
 * strand its workflows (every `ownedDefinitionRow` check reads through live
 * `team_members`, so an orphaned `ownerId` becomes permanently
 * inaccessible, not just unowned). Queries `workflow_definitions` directly
 * rather than importing `workflows/service.ts`, which would create a
 * services/teams.ts <-> services/workflows.ts import cycle.
 */
async function assertNoTeamOwnedWorkflows(db: AppQueryable, teamId: string): Promise<void> {
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, teamId)))
    .limit(1);
  if (rows.length > 0) throw new TeamOwnsWorkflowsError(teamId);
}

/**
 * `pg_advisory_xact_lock` keyed by team id, released automatically at
 * transaction end. `deleteTeam`'s checks and the team-owned INSERTs in
 * `workflows/service.ts` and `services/skills.ts` target tables with no FK
 * between them (a polymorphic `owner_id` can't carry one), so under plain
 * MVCC a SELECT here never blocks a concurrent INSERT there — this lock is
 * what actually serializes "is the team still valid to own this" against
 * "delete the team," not the surrounding `db.transaction` on its own. Every
 * side must take this same lock for it to do anything.
 */
export async function lockTeamForOwnership(tx: AppQueryable, teamId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${teamId}))`);
}

export interface DeleteTeamOptions {
  teamId: string;
}

/**
 * Deletes a team, its memberships, the skills it owns, and the skill
 * repositories it tracks. Rejects while the team owns any workflow, and
 * rejects on a team that mirrors an identity-provider group.
 *
 * A mirrored team is refused because deletion here does not reach the source.
 * The group stays in the identity provider, so the next sign-in recreates the
 * team — but the skills and tracked repositories this function removes do not
 * come back. Deleting the group in the identity provider empties the team
 * instead, and destroys nothing the sync cannot rebuild.
 *
 * Skills are removed rather than blocking, because a skill is a document,
 * not a running thing — there is nothing to cancel first. They must go
 * somewhere: every read path for a team-owned skill goes through
 * `isTeamMember`, so a surviving row would sit in the table forever with no
 * owner who can ever reach it, the same orphan `deleteWorkflowDefinition`
 * closes for `workflow_webhooks`. A tracked repository is unreachable the
 * same way, and it would go on polling GitHub for a team that no longer
 * exists, so it goes with them.
 */
export async function deleteTeam(db: AppDb, opts: DeleteTeamOptions): Promise<void> {
  const teamRows = await db.select().from(teams).where(eq(teams.id, opts.teamId)).limit(1);
  const team = teamRows[0];
  if (!team) throw new NotFoundError("team", opts.teamId);
  if (team.origin === "idp") throw new IdpManagedTeamError(team, "delete");

  await db.transaction(async (tx) => {
    await lockTeamForOwnership(tx, opts.teamId);
    await assertNoTeamOwnedWorkflows(tx, opts.teamId);
    await tx
      .delete(skills)
      .where(and(eq(skills.ownerType, "team"), eq(skills.ownerId, opts.teamId)));
    await tx
      .delete(skillSources)
      .where(and(eq(skillSources.ownerType, "team"), eq(skillSources.ownerId, opts.teamId)));
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, opts.teamId));
    await tx.delete(teams).where(eq(teams.id, opts.teamId));
  });
}
