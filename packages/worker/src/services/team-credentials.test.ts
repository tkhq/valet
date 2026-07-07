import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { createTeam } from '../lib/db/teams.js';
import { getCredentialRow, upsertCredential } from '../lib/db/credentials.js';
import {
  breakTeamCredentialsSourcedFrom,
  listTeamCredentials,
  shareCredentialToTeam,
  unshareTeamCredential,
} from './team-credentials.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';

describe('team sourced credentials', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let teamId: string;

  beforeEach(async () => {
    ({ db, sqlite } = createTestDb());
    for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob']] as const) {
      sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'member')").run(id, `${id}@x.com`, name);
    }
    teamId = (await createTeam(db, { name: 'Platform', createdBy: ALICE })).id;

    await upsertCredential(db, {
      id: 'cred-alice-gh',
      ownerType: 'user',
      ownerId: ALICE,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'enc-alice',
    });
  });

  it('sharing stores a reference (not a token copy) with sourcing provenance', async () => {
    await shareCredentialToTeam(db, teamId, ALICE, 'github');

    const teamRow = await getCredentialRow(db, 'team', teamId, 'github');
    // Reference row: no token copy — encrypted_data is an unused placeholder,
    // resolution delegates to the sourcing member's live credential.
    expect(teamRow?.encryptedData).toBe('');
    expect(teamRow?.sourcedFromUserId).toBe(ALICE);

    const listed = await listTeamCredentials(db, teamId);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('active');
    expect(listed[0].sourcedFromName).toBe('Alice');
  });

  it('sharing an unconnected provider is a 404', async () => {
    await expect(shareCredentialToTeam(db, teamId, ALICE, 'linear')).rejects.toThrow(/not found/i);
  });

  it('breaking flips status; broken rows never resolve; re-sourcing repairs', async () => {
    await shareCredentialToTeam(db, teamId, ALICE, 'github');

    await breakTeamCredentialsSourcedFrom(db, ALICE, { teamId });
    expect((await listTeamCredentials(db, teamId))[0].status).toBe('broken');
    // Resolution skips broken rows — the team session fails visibly instead
    // of silently borrowing anyone's personal token.
    expect(await getCredentialRow(db, 'team', teamId, 'github')).toBeNull();

    // Bob re-sources with his own connection.
    await upsertCredential(db, {
      id: 'cred-bob-gh',
      ownerType: 'user',
      ownerId: BOB,
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'enc-bob',
    });
    await shareCredentialToTeam(db, teamId, BOB, 'github');

    const repaired = await getCredentialRow(db, 'team', teamId, 'github');
    expect(repaired?.sourcedFromUserId).toBe(BOB);
    expect((await listTeamCredentials(db, teamId))[0].status).toBe('active');
  });

  it('provider-scoped break (personal disconnect) only hits matching rows', async () => {
    await upsertCredential(db, {
      id: 'cred-alice-op',
      ownerType: 'user',
      ownerId: ALICE,
      provider: '1password',
      credentialType: 'api_key',
      encryptedData: 'enc-op',
    });
    await shareCredentialToTeam(db, teamId, ALICE, 'github');
    await shareCredentialToTeam(db, teamId, ALICE, '1password');

    await breakTeamCredentialsSourcedFrom(db, ALICE, { provider: 'github' });
    const byProvider = Object.fromEntries((await listTeamCredentials(db, teamId)).map((c) => [c.provider, c.status]));
    expect(byProvider).toEqual({ '1password': 'active', github: 'broken' });
  });

  it('unshare deletes the team row without touching the personal one', async () => {
    await shareCredentialToTeam(db, teamId, ALICE, 'github');
    expect(await unshareTeamCredential(db, teamId, 'github')).toBe(1);
    expect(await listTeamCredentials(db, teamId)).toHaveLength(0);
    expect(await getCredentialRow(db, 'user', ALICE, 'github')).not.toBeNull();
  });
});
