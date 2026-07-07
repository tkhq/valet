import { describe, it, expect, beforeEach } from 'vitest';
import { userPrincipal } from '@valet/shared';
import type { Principal } from '@valet/shared';
import { createTestDb } from '../test-utils/db.js';
import { writeMemoryFile, readMemoryFile } from '../lib/db/memory-files.js';
import { addTeamMember, createTeam } from '../lib/db/teams.js';
import { memRead, memSearch, memWrite, type SessionMemoryContext } from './session-memory.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';

function makeD1Adapter(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          async first() { return sqlite.prepare(sql).get(...args) ?? null; },
          async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
        }),
      };
    },
    async batch(stmts: any[]) {
      return sqlite.transaction(() => stmts.map((s: any) => sqlite.prepare(s.sql).run(...s.args)))();
    },
  } as any;
}

describe('owner-scoped session memory', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let rawDb: any;
  let teamA: string;
  let teamB: string;

  beforeEach(async () => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    for (const id of [ALICE, BOB]) {
      sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@test.com`);
    }
    teamA = (await createTeam(db, { name: 'Alpha', createdBy: ALICE })).id;
    teamB = (await createTeam(db, { name: 'Beta', createdBy: ALICE })).id;
  });

  const teamP = (id: string): Principal => ({ type: 'team', id });

  it('same path in two teams by the same creator does not collide', async () => {
    await writeMemoryFile(rawDb, teamP(teamA), 'MEMORY.md', '# Alpha memory', true, ALICE);
    await writeMemoryFile(rawDb, teamP(teamB), 'MEMORY.md', '# Beta memory', true, ALICE);

    const a = await readMemoryFile(db, teamP(teamA), 'MEMORY.md');
    const b = await readMemoryFile(db, teamP(teamB), 'MEMORY.md');
    expect(a?.content).toBe('# Alpha memory');
    expect(b?.content).toBe('# Beta memory');
  });

  it('team writes require an actor', async () => {
    await expect(writeMemoryFile(rawDb, teamP(teamA), 'x.md', 'x')).rejects.toThrow(/actorUserId/);
  });

  it('personal reads are unioned with member teams, tagged with team prefix', async () => {
    await writeMemoryFile(rawDb, userPrincipal(ALICE), 'notes/personal.md', '# My private cloudflare notes');
    await writeMemoryFile(rawDb, teamP(teamA), 'notes/shared.md', '# Team cloudflare runbook', true, ALICE);

    const ctx: SessionMemoryContext = { owner: userPrincipal(ALICE), actorUserId: ALICE };
    const search = await memSearch(rawDb, db, ctx, 'cloudflare');
    const paths = (search.results ?? []).map((r) => r.path).sort();
    expect(paths).toEqual(['notes/personal.md', `team:${teamA}/notes/shared.md`]);

    const listing = await memRead(db, ctx, '');
    const listedPaths = (listing.files ?? []).map((f) => f.path);
    expect(listedPaths).toContain('notes/personal.md');
    expect(listedPaths).toContain(`team:${teamA}/notes/shared.md`);
  });

  it('team-prefixed reads verify membership', async () => {
    await writeMemoryFile(rawDb, teamP(teamA), 'runbook.md', '# Runbook', true, ALICE);

    const aliceCtx: SessionMemoryContext = { owner: userPrincipal(ALICE), actorUserId: ALICE };
    const read = await memRead(db, aliceCtx, `team:${teamA}/runbook.md`);
    expect(read.file?.content).toBe('# Runbook');

    // Bob is not a member — the team's memory does not exist for him.
    const bobCtx: SessionMemoryContext = { owner: userPrincipal(BOB), actorUserId: BOB };
    const denied = await memRead(db, bobCtx, `team:${teamA}/runbook.md`);
    expect(denied.error).toMatch(/not a member/i);

    // Membership grants access instantly (query-time resolution).
    await addTeamMember(db, teamA, BOB, 'member', ALICE);
    const granted = await memRead(db, bobCtx, `team:${teamA}/runbook.md`);
    expect(granted.file?.content).toBe('# Runbook');
  });

  it('writes never cross scopes — team-prefixed writes are rejected', async () => {
    const ctx: SessionMemoryContext = { owner: userPrincipal(ALICE), actorUserId: ALICE };
    const result = await memWrite(rawDb, ctx, `team:${teamA}/hack.md`, 'nope');
    expect(result.error).toMatch(/never cross scopes/i);
    expect(await readMemoryFile(db, teamP(teamA), 'hack.md')).toBeNull();
  });

  it('the team orchestrator context stays inside its own scope', async () => {
    await writeMemoryFile(rawDb, userPrincipal(ALICE), 'secret.md', '# personal secret zebra');
    await writeMemoryFile(rawDb, teamP(teamA), 'team-doc.md', '# team zebra doc', true, ALICE);

    const teamCtx: SessionMemoryContext = { owner: teamP(teamA), actorUserId: ALICE };
    const search = await memSearch(rawDb, db, teamCtx, 'zebra');
    expect((search.results ?? []).map((r) => r.path)).toEqual(['team-doc.md']);
  });
});
