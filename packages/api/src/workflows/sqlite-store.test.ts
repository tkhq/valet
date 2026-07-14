import Database from 'better-sqlite3';
import {
  describeCheckpointContract,
  describeOwnershipContract,
  describeRunHostContract,
  describeSignalContract,
  makeRunHostFixtureEngine,
} from '@valet/workflow/conformance';
import { LocalRunHost } from '@valet/workflow';
import type { RunHostFixture, RunHostFixtureOptions } from '@valet/workflow/conformance';
import { applyAppMigrations, buildAppDb, type AppDb } from '../lib/drizzle.js';
import { SqliteWorkflowStore } from './sqlite-store.js';

/** Fresh temp-file-equivalent (`:memory:`) sqlite DB per call, migrated the same way the app boots one. */
function makeSqliteStore(clock?: () => number): SqliteWorkflowStore {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  applyAppMigrations(sqlite);
  const db = buildAppDb(sqlite) as AppDb & { $client: Database.Database };
  return new SqliteWorkflowStore(db, clock);
}

describeCheckpointContract(() => makeSqliteStore());
describeSignalContract(() => makeSqliteStore());
describeOwnershipContract(() => makeSqliteStore());

// ─── RunHost conformance against LocalRunHost + SqliteWorkflowStore ─────────
//
// Same fixture shape as `packages/workflow/src/local-host.test.ts`'s
// in-memory wiring, swapping only the store. The suite's timing knobs are
// all driven off the injected fake clock plus LocalRunHost's real
// (short, ms-scale) `setInterval`/`setTimeout` polling — the sqlite store
// itself is clock-agnostic (it stamps `created_at`/`updated_at`/lease times
// via whatever `clock` it's constructed with), so this is a drop-in swap.

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describeRunHostContract(
  (opts: RunHostFixtureOptions = {}): RunHostFixture => {
    const clock = makeClock();
    const store = makeSqliteStore(clock.now);
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
