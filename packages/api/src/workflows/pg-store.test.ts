import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { afterAll, describe } from 'vitest';
import {
  describeCheckpointContract,
  describeListRunsContract,
  describeOwnershipContract,
  describeRunHostContract,
  describeSignalContract,
  makeRunHostFixtureEngine,
} from '@valet/workflow/conformance';
import { LocalRunHost } from '@valet/workflow';
import type { RunHostFixture, RunHostFixtureOptions } from '@valet/workflow/conformance';
import { pgDbFromPglite, pgDbFromPool, type PgDb } from '@valet/store-postgres';
import { applyAppMigrations } from '../lib/drizzle.js';
import { PgWorkflowStore } from './pg-store.js';

// Tables `PgWorkflowStore` touches, in a harmless truncate order (none of
// these carry FKs to each other). Truncating between contract tests gives
// each one the same blank-slate guarantee a fresh `:memory:` sqlite db gave
// the old `SqliteWorkflowStore` suite.
const DATA_TABLES = ['workflow_signals', 'workflow_checkpoints', 'workflow_runs'];

async function truncateAll(db: PgDb): Promise<void> {
  await db.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Builds a `makeStore()` factory that reuses ONE underlying `PgDb` for every
 * test wired against it (decision 11 of
 * docs/specs/2026-07-15-postgres-backend-design.md — PGlite's wasm heap
 * isn't reliably released on `close()`, so this file must not spin up a
 * fresh PGlite per test). The app's full migration set runs once per `db`;
 * every subsequent call truncates the workflow data tables instead.
 */
function makeStoreFactory(db: PgDb, migrated: { done: boolean }, clock?: () => number): () => Promise<PgWorkflowStore> {
  return async () => {
    if (!migrated.done) {
      await applyAppMigrations(db);
      migrated.done = true;
    } else {
      await truncateAll(db);
    }
    return new PgWorkflowStore(db, clock);
  };
}

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function wireContracts(label: string, db: PgDb): void {
  describe(label, () => {
    afterAll(async () => {
      await db.close();
    });

    const migrated = { done: false };
    const factory = makeStoreFactory(db, migrated);
    describeCheckpointContract(() => factory());
    describeSignalContract(() => factory());
    describeOwnershipContract(() => factory());
    // `listRuns` assertions need exact `createdAt` values (same-millisecond
    // ties), so this suite builds its store with its own clock.
    describeListRunsContract((clock) => makeStoreFactory(db, migrated, clock)());

    // ─── RunHost conformance against LocalRunHost + PgWorkflowStore ─────────
    //
    // Same fixture shape as `packages/workflow/src/local-host.test.ts`'s
    // in-memory wiring and the old sqlite suite, swapping only the store.
    // The suite's timing knobs are all driven off the injected fake clock
    // plus LocalRunHost's real (short, ms-scale) `setInterval`/`setTimeout`
    // polling — the pg store itself is clock-agnostic (it stamps
    // `created_at`/`updated_at`/lease times via whatever `clock` it's
    // constructed with), so this is a drop-in swap.
    describeRunHostContract(
      async (opts: RunHostFixtureOptions = {}): Promise<RunHostFixture> => {
        const clock = makeClock();
        const runHostFactory = makeStoreFactory(db, migrated, clock.now);
        const store = await runHostFactory();
        const engine = makeRunHostFixtureEngine();
        const host = new LocalRunHost({
          store,
          engine,
          clock: clock.now,
          concurrency: opts.concurrency ?? 4,
          pollMs: opts.pollMs ?? 10,
          leaseMs: opts.leaseMs ?? 2_000,
          heartbeatMs: opts.heartbeatMs ?? 300,
          sweepMs: opts.sweepMs ?? 20,
          executors: opts.executors,
        });
        return { host, store, engine, clock };
      },
    );
  });
}

{
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  wireContracts('PgWorkflowStore (PGlite)', db);
}

if (process.env.TEST_DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  wireContracts('PgWorkflowStore (docker-pg)', db);
}
