/**
 * `listRuns` contract conformance suite — same `describe*` factory pattern
 * as `ownership.ts`. Both `WorkflowStore` implementations run it, so the
 * in-memory store and the Postgres store cannot drift on ordering, keyset
 * paging, or the shape of the absent-parent fields.
 *
 * The factory takes a clock because `createRun` stamps `createdAt` from the
 * store's own clock, and these assertions need exact creation times —
 * including the same-millisecond ties a batch fan-out produces.
 *
 * Coverage (batch-fanout design decision 5):
 *  - newest-first `(createdAt, runId)` order
 *  - keyset paging across a same-millisecond tie
 *  - each filter in isolation: workflowIds, status, outcome, since, parentRunId
 *  - `parentRunId` returns only that parent's children
 *  - absent parent fields read back as `undefined`, never `null`
 *  - an unreadable cursor is rejected, malformed or out of integer range
 */

import { describe, expect, it } from 'vitest';
import { type RunParams, type WorkflowStore } from '../store.js';

const DEFINITION = { version: 'dag/v1' };

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return { workflowId: 'wf-1', definitionVersionId: 'v1', ...overrides };
}

interface SeedRow {
  runId: string;
  createdAt: number;
  params?: Partial<RunParams>;
  owner?: { ownerType: string; ownerId: string };
}

/** Builds a store whose clock the test drives, plus the seeder that uses it. */
export type MakeListRunsStore = (clock: () => number) => Promise<WorkflowStore> | WorkflowStore;

export function describeListRunsContract(makeStore: MakeListRunsStore): void {
  describe('WorkflowStore listRuns contract', () => {
    /**
     * Every run id here is lower-case ASCII of equal length: run ids sort
     * identically under every text collation, so the ordering assertions
     * hold for a JS `<` comparison and a Postgres `ORDER BY` alike.
     */
    async function seedStore(rows: SeedRow[]): Promise<WorkflowStore> {
      let now = 0;
      const store = await makeStore(() => now);
      for (const row of rows) {
        now = row.createdAt;
        await store.createRun(row.runId, runParams(row.params), DEFINITION, 'v1', row.owner);
      }
      return store;
    }

    it('returns runs newest-first, breaking a same-millisecond tie by descending runId', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 1_000 },
        { runId: 'run-c', createdAt: 2_000 },
      ]);

      const page = await store.listRuns({ limit: 10 });
      expect(page.runs.map((r) => r.runId)).toEqual(['run-c', 'run-b', 'run-a']);
      expect(page.nextCursor).toBeUndefined();
    });

    it('pages by keyset across a same-millisecond tie without skipping or repeating a run', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 1_000 },
        { runId: 'run-c', createdAt: 1_000 },
        { runId: 'run-d', createdAt: 1_000 },
      ]);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page += 1) {
        const result = await store.listRuns({ limit: 2, cursor });
        seen.push(...result.runs.map((r) => r.runId));
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      expect(seen).toEqual(['run-d', 'run-c', 'run-b', 'run-a']);
      expect(cursor).toBeUndefined();
    });

    it('omits nextCursor when the last page exactly fills the limit', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 2_000 },
      ]);

      const page = await store.listRuns({ limit: 2 });
      expect(page.runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
      expect(page.nextCursor).toBeUndefined();
    });

    it('filters by workflowIds (any-of); an empty id list matches nothing', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000, params: { workflowId: 'wf-1' } },
        { runId: 'run-b', createdAt: 2_000, params: { workflowId: 'wf-2' } },
        { runId: 'run-c', createdAt: 3_000, params: { workflowId: 'wf-3' } },
      ]);

      const page = await store.listRuns({ workflowIds: ['wf-1', 'wf-3'], limit: 10 });
      expect(page.runs.map((r) => r.runId)).toEqual(['run-c', 'run-a']);
      expect(page.runs.map((r) => r.workflowId)).toEqual(['wf-3', 'wf-1']);

      const none = await store.listRuns({ workflowIds: [], limit: 10 });
      expect(none.runs).toEqual([]);
    });

    it('filters by status (any-of)', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 2_000 },
      ]);
      const claimed = await store.claimRun('run-b', 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');

      const running = await store.listRuns({ status: ['running'], limit: 10 });
      expect(running.runs.map((r) => r.runId)).toEqual(['run-b']);

      const either = await store.listRuns({ status: ['pending', 'running'], limit: 10 });
      expect(either.runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
    });

    it('filters by outcome, and never matches a run that has no outcome yet', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 2_000 },
        { runId: 'run-c', createdAt: 3_000 },
      ]);
      await store.settleRun('run-a', 'completed');
      await store.settleRun('run-b', 'failed');

      const failed = await store.listRuns({ outcome: ['failed'], limit: 10 });
      expect(failed.runs.map((r) => r.runId)).toEqual(['run-b']);
      expect(failed.runs[0]?.outcome).toBe('failed');

      const settled = await store.listRuns({ outcome: ['completed', 'failed'], limit: 10 });
      expect(settled.runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
    });

    it('filters by since, inclusive of the boundary', async () => {
      const store = await seedStore([
        { runId: 'run-a', createdAt: 1_000 },
        { runId: 'run-b', createdAt: 2_000 },
        { runId: 'run-c', createdAt: 3_000 },
      ]);

      const page = await store.listRuns({ since: 2_000, limit: 10 });
      expect(page.runs.map((r) => r.runId)).toEqual(['run-c', 'run-b']);
    });

    it('filters by parentRunId and returns only that parent’s children', async () => {
      const store = await seedStore([
        { runId: 'run-parent', createdAt: 1_000 },
        {
          runId: 'run-child-1',
          createdAt: 2_000,
          params: { parentRunId: 'run-parent', parentNodeId: 'fanout', parentIteration: 0 },
        },
        {
          runId: 'run-child-2',
          createdAt: 3_000,
          params: { parentRunId: 'run-parent', parentNodeId: 'fanout', parentIteration: 1 },
        },
        { runId: 'run-child-3', createdAt: 4_000, params: { parentRunId: 'run-elsewhere' } },
      ]);

      const page = await store.listRuns({ parentRunId: 'run-parent', limit: 10 });
      expect(page.runs.map((r) => r.runId)).toEqual(['run-child-2', 'run-child-1']);
      expect(page.runs[0]).toMatchObject({
        parentRunId: 'run-parent',
        parentNodeId: 'fanout',
        parentIteration: 1,
      });
      expect(page.runs[1]?.parentIteration).toBe(0);
    });

    it('reads absent parent fields back as undefined, and round-trips owner', async () => {
      const store = await seedStore([
        { runId: 'run-owned', createdAt: 1_000, owner: { ownerType: 'team', ownerId: 'team-42' } },
        { runId: 'run-plain', createdAt: 2_000 },
      ]);

      const page = await store.listRuns({ limit: 10 });
      const owned = page.runs.find((r) => r.runId === 'run-owned');
      const plain = page.runs.find((r) => r.runId === 'run-plain');
      expect(owned?.owner).toEqual({ ownerType: 'team', ownerId: 'team-42' });
      expect(plain?.owner).toBeUndefined();
      expect(plain?.parentRunId).toBeUndefined();
      expect(plain?.parentNodeId).toBeUndefined();
      expect(plain?.parentIteration).toBeUndefined();
    });

    it('rejects a cursor it cannot read', async () => {
      const store = await seedStore([{ runId: 'run-a', createdAt: 1_000 }]);
      await expect(store.listRuns({ limit: 10, cursor: 'not-a-cursor' })).rejects.toThrow(/nextCursor/);
    });

    /**
     * A hand-edited cursor keeps the `<number>:<runId>` shape but carries a
     * timestamp no integer column can hold. Both stores must answer with the
     * same actionable error — a store that passes the value through to its
     * driver answers with a syntax error the caller cannot act on.
     */
    it('rejects a cursor whose timestamp is not a safe integer', async () => {
      const store = await seedStore([{ runId: 'run-a', createdAt: 1_000 }]);
      for (const cursor of ['1.5:run-a', '1e+30:run-a', 'later:run-a']) {
        await expect(store.listRuns({ limit: 10, cursor })).rejects.toThrow(/nextCursor/);
      }
    });
  });
}
