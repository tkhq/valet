import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { getAdoptionMetrics } from './sessions.js';
import { users } from '../schema/users.js';
import { sessions, sessionGitState } from '../schema/sessions.js';

/**
 * Regression: totalPrsMerged counted rows on prState='merged' alone, with no
 * pr_number gate. A session sharing a merged PR's head branch but not linked to
 * it (pr_number IS NULL) carries prState='merged', so it inflated the merged
 * count without adding to the created count (which does gate on pr_number),
 * pushing mergeRate past 100%. Both counts must gate on pr_number consistently.
 */
describe('getAdoptionMetrics — merged count gates on pr_number', () => {
  const REPO = 'octo/valet';

  function seed() {
    const { db, sqlite } = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'u1@example.com' }).onConflictDoNothing().run();
    for (const id of ['s1', 's2', 's3']) {
      db.insert(sessions).values({ id, userId: 'u1', workspace: '/tmp/x', status: 'terminated' }).run();
    }
    return { db, sqlite };
  }

  function seedGit(
    db: ReturnType<typeof createTestDb>['db'],
    sessionId: string,
    git: Record<string, unknown>,
  ) {
    db.insert(sessionGitState)
      .values({ id: `sgs-${sessionId}`, sessionId, sourceRepoFullName: REPO, ...git })
      .run();
  }

  it('excludes merged rows that have no pr_number and keeps mergeRate <= 100%', async () => {
    const { db } = seed();
    // s1: a real authored+merged PR — counts as created AND merged.
    seedGit(db, 's1', { prNumber: 1, prState: 'merged' });
    // s2: a co-branch session sharing s1's merged branch, never linked to the PR
    // (pr_number null) but marked merged — must NOT count as a merged PR.
    seedGit(db, 's2', { prNumber: null, prState: 'merged' });
    // s3: an authored PR still open — counts as created only.
    seedGit(db, 's3', { prNumber: 2, prState: 'open' });

    const m = await getAdoptionMetrics(db, 30);

    expect(m.totalPRsCreated).toBe(2); // s1, s3
    expect(m.totalPRsMerged).toBe(1); // s1 only (s2 excluded for lacking pr_number)
    expect(m.mergeRate).toBe(50); // 1 / 2
  });
});
