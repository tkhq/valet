import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from './schema/users.js';
import { workflows } from './schema/workflows.js';
import { assertWorkflowAccess } from './workflow-access.js';
import { NotFoundError } from '@valet/shared';
import type { AppDb } from './drizzle.js';

let db: AppDb;

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb; sqlite: unknown });
  db.insert(users).values([
    { id: 'user-1', email: 'one@example.com' },
    { id: 'user-2', email: 'two@example.com' },
  ]).run();
  db.insert(workflows).values([
    {
      id: 'wf-owned',
      slug: 'owned',
      userId: 'user-1',
      name: 'Owned Workflow',
      version: 'dag/v1',
      data: '{}',
      enabled: true,
    },
    {
      id: 'wf-other',
      slug: 'other',
      userId: 'user-2',
      name: 'Someone Else',
      version: 'dag/v1',
      data: '{}',
      enabled: true,
    },
  ]).run();
});

describe('assertWorkflowAccess', () => {
  it('returns the workflow when the user is the owner (viewer role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'viewer');
    expect(result).toEqual({ id: 'wf-owned', userId: 'user-1' });
  });

  it('returns the workflow when the user is the owner (editor role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'editor');
    expect(result.id).toBe('wf-owned');
  });

  it('returns the workflow when the user is the owner (publisher role)', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'wf-owned', 'publisher');
    expect(result.id).toBe('wf-owned');
  });

  it('accepts the slug as well as the id', async () => {
    const result = await assertWorkflowAccess(db, { id: 'user-1' }, 'owned', 'viewer');
    expect(result.id).toBe('wf-owned');
  });

  it('rejects when the user is not the owner', async () => {
    await expect(assertWorkflowAccess(db, { id: 'user-1' }, 'wf-other', 'viewer')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when the workflow does not exist', async () => {
    await expect(assertWorkflowAccess(db, { id: 'user-1' }, 'wf-missing', 'viewer')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('team-owned workflow access', () => {
  const ALICE = 'user-alice';
  const BOB = 'user-bob';
  const EVE = 'user-eve';

  let tdb: AppDb;
  let sqlite: any;
  let teamId: string;

  beforeEach(async () => {
    ({ db: tdb, sqlite } = createTestDb() as { db: AppDb; sqlite: any });
    for (const id of [ALICE, BOB, EVE]) {
      sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@x.com`);
    }
    const { createTeam, addTeamMember } = await import('./db/teams.js');
    teamId = (await createTeam(tdb, { name: 'Platform', createdBy: ALICE })).id;
    await addTeamMember(tdb, teamId, BOB, 'member', ALICE);
    sqlite
      .prepare("INSERT INTO workflows (id, user_id, owner_type, owner_id, name, data) VALUES ('wf1', ?, 'user', ?, 'Deploy', '{}')")
      .run(ALICE, ALICE);
  });

  it('user-owned workflows stay owner-only', async () => {
    await expect(assertWorkflowAccess(tdb, { id: ALICE }, 'wf1')).resolves.toBeTruthy();
    await expect(assertWorkflowAccess(tdb, { id: BOB }, 'wf1')).rejects.toThrow(NotFoundError);
  });

  it('transfer to team grants current members access, listing, and fetch', async () => {
    const { setWorkflowOwner, listWorkflows, getWorkflowByIdOrSlug } = await import('./db/workflows.js');
    await setWorkflowOwner(tdb, 'wf1', { type: 'team', id: teamId });

    await expect(assertWorkflowAccess(tdb, { id: BOB }, 'wf1')).resolves.toBeTruthy();
    await expect(assertWorkflowAccess(tdb, { id: EVE }, 'wf1')).rejects.toThrow(NotFoundError);

    const bobList = await listWorkflows(tdb, BOB);
    expect(bobList.results.map((w: { id: string }) => w.id)).toContain('wf1');
    expect((await listWorkflows(tdb, EVE)).results).toHaveLength(0);

    // The db fetch layer admits members too (routes re-fetch after assert).
    expect(await getWorkflowByIdOrSlug(tdb, BOB, 'wf1')).toBeTruthy();
    expect(await getWorkflowByIdOrSlug(tdb, EVE, 'wf1')).toBeUndefined();
  });

  it('membership revocation removes access at query time', async () => {
    const { setWorkflowOwner } = await import('./db/workflows.js');
    await setWorkflowOwner(tdb, 'wf1', { type: 'team', id: teamId });
    sqlite.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, BOB);
    await expect(assertWorkflowAccess(tdb, { id: BOB }, 'wf1')).rejects.toThrow(NotFoundError);
  });
});
