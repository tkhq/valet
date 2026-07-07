import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  getTeamMembership,
  listAllTeams,
  listTeamMembers,
  listTeamsForUser,
  removeTeamMember,
  updateTeam,
  updateTeamMemberRole,
} from './teams.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

describe('teams db helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];

  const seedUser = (id: string, name: string) =>
    sqlite
      .prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'member')")
      .run(id, `${id}@test.com`, name);

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    seedUser(ALICE, 'Alice');
    seedUser(BOB, 'Bob');
    seedUser(CAROL, 'Carol');
  });

  it('createTeam makes the creator an admin, atomically', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    expect(team.name).toBe('Platform');
    expect(team.memberCount).toBe(1);
    expect(team.myRole).toBe('admin');

    const membership = await getTeamMembership(db, team.id, ALICE);
    expect(membership?.role).toBe('admin');
  });

  it('rejects duplicate team names within the org', async () => {
    await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await expect(createTeam(db, { name: 'Platform', createdBy: BOB })).rejects.toThrow(/already exists/i);
  });

  it('getTeam returns member count and null for missing teams', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await addTeamMember(db, team.id, BOB, 'member', ALICE);

    const fetched = await getTeam(db, team.id);
    expect(fetched?.memberCount).toBe(2);
    expect(await getTeam(db, 'nope')).toBeNull();
  });

  it('listTeamsForUser returns only memberships, with myRole', async () => {
    const platform = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await createTeam(db, { name: 'Growth', createdBy: BOB });
    await addTeamMember(db, platform.id, CAROL, 'member', ALICE);

    const carols = await listTeamsForUser(db, CAROL);
    expect(carols.map((t) => t.name)).toEqual(['Platform']);
    expect(carols[0].myRole).toBe('member');
    expect(carols[0].memberCount).toBe(2);

    expect(await listTeamsForUser(db, 'user-nobody')).toEqual([]);
  });

  it('listAllTeams returns every team', async () => {
    await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await createTeam(db, { name: 'Growth', createdBy: BOB });
    const all = await listAllTeams(db);
    expect(all.map((t) => t.name).sort()).toEqual(['Growth', 'Platform']);
  });

  it('updateTeam renames; duplicate rename rejected', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await createTeam(db, { name: 'Growth', createdBy: BOB });

    const renamed = await updateTeam(db, team.id, { name: 'Infra', description: 'infra things' });
    expect(renamed.name).toBe('Infra');
    expect(renamed.description).toBe('infra things');

    await expect(updateTeam(db, team.id, { name: 'Growth' })).rejects.toThrow(/already exists/i);
  });

  it('listTeamMembers joins user display fields', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await addTeamMember(db, team.id, BOB, 'member', ALICE);

    const members = await listTeamMembers(db, team.id);
    expect(members).toHaveLength(2);
    const bob = members.find((m) => m.userId === BOB);
    expect(bob?.name).toBe('Bob');
    expect(bob?.email).toBe(`${BOB}@test.com`);
    expect(bob?.role).toBe('member');
  });

  it('addTeamMember rejects duplicates and unknown teams', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await addTeamMember(db, team.id, BOB, 'member', ALICE);
    await expect(addTeamMember(db, team.id, BOB, 'member', ALICE)).rejects.toThrow(/already/i);
    await expect(addTeamMember(db, 'nope', CAROL, 'member', ALICE)).rejects.toThrow(/not found/i);
  });

  it('role changes work; demoting the last admin is blocked', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await addTeamMember(db, team.id, BOB, 'member', ALICE);

    await updateTeamMemberRole(db, team.id, BOB, 'admin');
    expect((await getTeamMembership(db, team.id, BOB))?.role).toBe('admin');

    await updateTeamMemberRole(db, team.id, ALICE, 'member');
    await expect(updateTeamMemberRole(db, team.id, BOB, 'member')).rejects.toThrow(/last admin/i);
  });

  it('removing the last admin is blocked; leave works when another admin exists', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await expect(removeTeamMember(db, team.id, ALICE)).rejects.toThrow(/last admin/i);

    await addTeamMember(db, team.id, BOB, 'admin', ALICE);
    await removeTeamMember(db, team.id, ALICE);
    expect(await getTeamMembership(db, team.id, ALICE)).toBeNull();
  });

  it('deleteTeam cascades membership rows', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    await addTeamMember(db, team.id, BOB, 'member', ALICE);

    await deleteTeam(db, team.id);
    expect(await getTeam(db, team.id)).toBeNull();
    const orphans = sqlite.prepare('SELECT count(*) AS n FROM team_members WHERE team_id = ?').get(team.id) as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('deleteTeam is blocked while team-owned workflows exist', async () => {
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    sqlite
      .prepare(
        "INSERT INTO workflows (id, user_id, owner_type, owner_id, name, data) VALUES ('wf1', ?, 'team', ?, 'Team WF', '{}')"
      )
      .run(ALICE, team.id);

    await expect(deleteTeam(db, team.id)).rejects.toThrow(/workflow/i);
  });
});
