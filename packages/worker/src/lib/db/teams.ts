import { ConflictError, NotFoundError, TERMINAL_SESSION_STATUSES, ValidationError } from '@valet/shared';
import type { Team, TeamMember, TeamRole } from '@valet/shared';
import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { sessions, teamMembers, teams, users, workflows } from '../schema/index.js';

type TeamRow = typeof teams.$inferSelect;

function mapTeamRow(row: TeamRow, extras?: { memberCount?: number; myRole?: TeamRole }): Team {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description ?? undefined,
    avatar: row.avatar ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    memberCount: extras?.memberCount,
    myRole: extras?.myRole,
  };
}

async function countMembers(db: AppDb, teamId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return row?.n ?? 0;
}

async function assertNameAvailable(db: AppDb, orgId: string, name: string, excludeTeamId?: string): Promise<void> {
  const clash = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      excludeTeamId
        ? and(eq(teams.orgId, orgId), eq(teams.name, name), ne(teams.id, excludeTeamId))
        : and(eq(teams.orgId, orgId), eq(teams.name, name))
    )
    .limit(1);
  if (clash.length > 0) throw new ConflictError(`A team named '${name}' already exists`);
}

export async function createTeam(
  db: AppDb,
  params: { name: string; description?: string; avatar?: string; createdBy: string; orgId?: string }
): Promise<Team> {
  const orgId = params.orgId ?? 'default';
  await assertNameAvailable(db, orgId, params.name);

  const id = crypto.randomUUID();
  await db.insert(teams).values({
    id,
    orgId,
    name: params.name,
    description: params.description ?? null,
    avatar: params.avatar ?? null,
    createdBy: params.createdBy,
  });

  try {
    await db.insert(teamMembers).values({
      teamId: id,
      userId: params.createdBy,
      role: 'admin',
      addedBy: params.createdBy,
    });
  } catch (err) {
    // Creator membership is not optional — roll back the team row rather than
    // leaving an unadministrable team behind.
    await db.delete(teams).where(eq(teams.id, id));
    throw err;
  }

  const [row] = await db.select().from(teams).where(eq(teams.id, id));
  return mapTeamRow(row, { memberCount: 1, myRole: 'admin' });
}

export async function getTeam(db: AppDb, teamId: string): Promise<Team | null> {
  const [row] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!row) return null;
  return mapTeamRow(row, { memberCount: await countMembers(db, teamId) });
}

export async function listTeamsForUser(db: AppDb, userId: string): Promise<Team[]> {
  const rows = await db
    .select({
      team: teams,
      role: teamMembers.role,
      memberCount: sql<number>`(SELECT count(*) FROM team_members tm WHERE tm.team_id = ${teams.id})`,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.name);
  return rows.map((r) => mapTeamRow(r.team, { memberCount: r.memberCount, myRole: r.role as TeamRole }));
}

export async function listAllTeams(db: AppDb, orgId = 'default'): Promise<Team[]> {
  const rows = await db
    .select({
      team: teams,
      memberCount: sql<number>`(SELECT count(*) FROM team_members tm WHERE tm.team_id = ${teams.id})`,
    })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(teams.name);
  return rows.map((r) => mapTeamRow(r.team, { memberCount: r.memberCount }));
}

export async function updateTeam(
  db: AppDb,
  teamId: string,
  params: { name?: string; description?: string; avatar?: string }
): Promise<Team> {
  const [existing] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!existing) throw new NotFoundError('Team', teamId);
  if (params.name && params.name !== existing.name) {
    await assertNameAvailable(db, existing.orgId, params.name, teamId);
  }

  await db
    .update(teams)
    .set({
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.avatar !== undefined ? { avatar: params.avatar } : {}),
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(teams.id, teamId));

  const [row] = await db.select().from(teams).where(eq(teams.id, teamId));
  return mapTeamRow(row, { memberCount: await countMembers(db, teamId) });
}

export async function deleteTeam(db: AppDb, teamId: string): Promise<void> {
  const [existing] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
  if (!existing) throw new NotFoundError('Team', teamId);

  const [wf] = await db
    .select({ n: sql<number>`count(*)` })
    .from(workflows)
    .where(and(eq(workflows.ownerType, 'team'), eq(workflows.ownerId, teamId)));
  if ((wf?.n ?? 0) > 0) {
    throw new ConflictError('Team has team-owned workflows; delete or transfer them first');
  }

  await db.delete(teams).where(eq(teams.id, teamId));
}

/** IDs of all non-terminal team-owned sessions (used for live-connection eviction). */
export async function listNonTerminalTeamSessionIds(db: AppDb, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.ownerType, 'team'),
        eq(sessions.ownerId, teamId),
        notInArray(sessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    );
  return rows.map((r) => r.id);
}

// ─── Membership ──────────────────────────────────────────────────────────────

type MemberRow = typeof teamMembers.$inferSelect;

function mapMemberRow(row: MemberRow, user?: { name: string | null; email: string; avatarUrl: string | null }): TeamMember {
  return {
    teamId: row.teamId,
    userId: row.userId,
    role: row.role as TeamRole,
    addedBy: row.addedBy ?? undefined,
    createdAt: row.createdAt,
    name: user?.name ?? undefined,
    email: user?.email,
    avatarUrl: user?.avatarUrl ?? undefined,
  };
}

export async function listTeamMembers(db: AppDb, teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({
      member: teamMembers,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(teamMembers.createdAt);
  return rows.map((r) => mapMemberRow(r.member, { name: r.name, email: r.email, avatarUrl: r.avatarUrl }));
}

export async function getTeamMembership(db: AppDb, teamId: string, userId: string): Promise<TeamMember | null> {
  const [row] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row ? mapMemberRow(row) : null;
}

export async function addTeamMember(
  db: AppDb,
  teamId: string,
  userId: string,
  role: TeamRole,
  addedBy: string
): Promise<TeamMember> {
  const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
  if (!team) throw new NotFoundError('Team', teamId);

  const existing = await getTeamMembership(db, teamId, userId);
  if (existing) throw new ConflictError('User is already a member of this team');

  await db.insert(teamMembers).values({ teamId, userId, role, addedBy });
  const created = await getTeamMembership(db, teamId, userId);
  if (!created) throw new Error('Failed to add team member');
  return created;
}

// True iff the team has an admin OTHER than `userId`. Used as an atomic guard
// clause so the last-admin check and the mutation happen in one DB step — a
// read-then-write pair lets two concurrent requests each demote/remove a
// different admin and orphan the team.
function anotherAdminExists(teamId: string, userId: string) {
  return sql`EXISTS (SELECT 1 FROM team_members t2 WHERE t2.team_id = ${teamId} AND t2.role = 'admin' AND t2.user_id <> ${userId})`;
}

export async function updateTeamMemberRole(db: AppDb, teamId: string, userId: string, role: TeamRole): Promise<void> {
  const membership = await getTeamMembership(db, teamId, userId);
  if (!membership) throw new NotFoundError('Team member', userId);

  const isDemotion = membership.role === 'admin' && role !== 'admin';
  await db
    .update(teamMembers)
    .set({ role })
    .where(
      isDemotion
        ? and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), anotherAdminExists(teamId, userId))
        : and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
    );

  // If a demotion didn't apply, this was the last admin (the guard clause
  // suppressed it) — re-read to report it. Concurrency-safe: writes serialize,
  // so two racing demotions can't both pass anotherAdminExists.
  if (isDemotion) {
    const after = await getTeamMembership(db, teamId, userId);
    if (after?.role === 'admin') throw new ValidationError('Cannot demote the last admin of a team');
  }
}

export async function removeTeamMember(db: AppDb, teamId: string, userId: string): Promise<void> {
  const membership = await getTeamMembership(db, teamId, userId);
  if (!membership) throw new NotFoundError('Team member', userId);

  if (membership.role !== 'admin') {
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return;
  }

  // Atomic guarded delete: only removes an admin if another admin remains.
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), anotherAdminExists(teamId, userId)));

  const still = await getTeamMembership(db, teamId, userId);
  if (still) throw new ValidationError('Cannot remove the last admin of a team');
}
