import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import {
  assertSessionAccess,
  addSessionParticipant,
  createSession,
  getSession,
  filterOwnedSessionIds,
} from './sessions.js';
import { addTeamMember, createTeam } from './teams.js';

const ALICE = 'user-alice'; // team admin
const BOB = 'user-bob'; // team member
const EVE = 'user-eve'; // outsider

describe('assertSessionAccess with principal ownership', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let teamId: string;

  const seedUser = (id: string) =>
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@test.com`);

  const seedSession = (
    id: string,
    userId: string,
    opts: { ownerType?: string; ownerId?: string; isOrchestrator?: boolean; purpose?: string } = {}
  ) =>
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, workspace, status, is_orchestrator, purpose, owner_type, owner_id)
         VALUES (?, ?, 'w', 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        userId,
        opts.isOrchestrator ? 1 : 0,
        opts.purpose ?? 'interactive',
        opts.ownerType ?? 'user',
        opts.ownerId ?? userId
      );

  beforeEach(async () => {
    ({ db, sqlite } = createTestDb());
    seedUser(ALICE);
    seedUser(BOB);
    seedUser(EVE);
    const team = await createTeam(db, { name: 'Platform', createdBy: ALICE });
    teamId = team.id;
    await addTeamMember(db, teamId, BOB, 'member', ALICE);
  });

  // ── user-owned sessions: today's behavior is preserved ──

  it('user-owned: owner has access, outsider gets 404', async () => {
    seedSession('sess-1', ALICE);
    await expect(assertSessionAccess(db, 'sess-1', ALICE)).resolves.toBeTruthy();
    await expect(assertSessionAccess(db, 'sess-1', EVE)).rejects.toThrow(/not found/i);
  });

  it('user-owned personal orchestrator stays private even from participants', async () => {
    seedSession('orchestrator:user:user-alice', ALICE, { isOrchestrator: true, purpose: 'orchestrator' });
    await addSessionParticipant(db, 'orchestrator:user:user-alice', BOB, 'collaborator');
    await expect(assertSessionAccess(db, 'orchestrator:user:user-alice', BOB)).rejects.toThrow(/not found/i);
    await expect(assertSessionAccess(db, 'orchestrator:user:user-alice', ALICE)).resolves.toBeTruthy();
  });

  // ── team-owned sessions ──

  it('team orchestrator: members get collaborator access, non-members 404', async () => {
    seedSession(`orchestrator:team:${teamId}`, ALICE, {
      ownerType: 'team',
      ownerId: teamId,
      isOrchestrator: true,
      purpose: 'orchestrator',
    });
    const id = `orchestrator:team:${teamId}`;
    await expect(assertSessionAccess(db, id, BOB, 'collaborator')).resolves.toBeTruthy();
    await expect(assertSessionAccess(db, id, EVE)).rejects.toThrow(/not found/i);
  });

  it('team members cannot act at owner level; team admins can', async () => {
    seedSession(`orchestrator:team:${teamId}`, ALICE, {
      ownerType: 'team',
      ownerId: teamId,
      isOrchestrator: true,
      purpose: 'orchestrator',
    });
    const id = `orchestrator:team:${teamId}`;
    await expect(assertSessionAccess(db, id, BOB, 'owner')).rejects.toThrow(/not found/i);
    await expect(assertSessionAccess(db, id, ALICE, 'owner')).resolves.toBeTruthy();
  });

  it('the actor loses access when no longer a member — membership is the only path', async () => {
    // Bob triggered the session (actor) but the team owns it.
    seedSession('sess-team-child', BOB, { ownerType: 'team', ownerId: teamId });
    await expect(assertSessionAccess(db, 'sess-team-child', BOB)).resolves.toBeTruthy();

    sqlite.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, BOB);
    await expect(assertSessionAccess(db, 'sess-team-child', BOB)).rejects.toThrow(/not found/i);
  });

  it('org-visibility fallback never applies to team-owned sessions', async () => {
    sqlite.prepare("UPDATE org_settings SET default_session_visibility = 'org_joinable' WHERE id = 'default'").run();
    seedSession('sess-team-child', ALICE, { ownerType: 'team', ownerId: teamId });

    // Org-joinable grants EVE access to a regular user-owned session…
    seedSession('sess-user-regular', ALICE);
    await expect(assertSessionAccess(db, 'sess-user-regular', EVE)).resolves.toBeTruthy();
    // …but never to a team-owned one.
    await expect(assertSessionAccess(db, 'sess-team-child', EVE)).rejects.toThrow(/not found/i);
  });

  it('team-owned workflow sessions follow the team rule', async () => {
    seedSession('sess-team-wf', ALICE, { ownerType: 'team', ownerId: teamId, purpose: 'workflow' });
    await expect(assertSessionAccess(db, 'sess-team-wf', BOB)).resolves.toBeTruthy();
    await expect(assertSessionAccess(db, 'sess-team-wf', EVE)).rejects.toThrow(/not found/i);
  });

  it('createSession persists an explicit owner (child inheritance path)', async () => {
    await createSession(db, {
      id: 'child-1',
      userId: BOB,
      workspace: 'repo',
      ownerType: 'team',
      ownerId: teamId,
    });
    const child = await getSession(db, 'child-1');
    expect(child?.ownerType).toBe('team');
    expect(child?.ownerId).toBe(teamId);
    // …and defaults to user-owned when omitted.
    await createSession(db, { id: 'child-2', userId: BOB, workspace: 'repo' });
    const plain = await getSession(db, 'child-2');
    expect(plain?.ownerType).toBe('user');
    expect(plain?.ownerId).toBe(BOB);
  });

  it('bulk-delete filter excludes team-owned sessions (no owner-op escalation via creator)', async () => {
    // Bob created a team-owned session (actor), but it's team-owned.
    seedSession('team-child', BOB, { ownerType: 'team', ownerId: teamId });
    seedSession('bobs-own', BOB);

    // Bulk-delete authorizes by creator + personal ownership only: the team
    // session is excluded even though Bob is its creator/userId.
    const deletable = await filterOwnedSessionIds(db, ['team-child', 'bobs-own'], BOB);
    expect(deletable).toEqual(['bobs-own']);

    // …and a departed member (removal never rewrites userId) still can't reach it.
    sqlite.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, BOB);
    expect(await filterOwnedSessionIds(db, ['team-child'], BOB)).toEqual([]);
  });

  it('user-owned workflow sessions keep the hard block', async () => {
    seedSession('sess-user-wf', ALICE, { purpose: 'workflow' });
    await expect(assertSessionAccess(db, 'sess-user-wf', BOB)).rejects.toThrow(/not found/i);
  });
});
