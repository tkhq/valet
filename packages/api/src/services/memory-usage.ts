/**
 * Memory usage (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`,
 * "Usage"). Records how agents use each memory file, so a person can see
 * which files are used and trim the ones that are not.
 *
 * Three kinds of use stay apart, because they mean different things:
 *
 *   - `read`: the agent chose to open the file (`mem_read`, an MCP or CLI
 *     read). A search hit counts only when the agent then opens it.
 *   - `inject`: the memory snapshot put the file, or a principle's index
 *     line, in a prompt. The agent did not choose it.
 *   - `cite`: a turn's answer or plan named the principle.
 *
 * Writes stay off the read path. A hit goes into an in-process buffer, and
 * one batched upsert per flush adds the buffered counts. The buffer is
 * bounded: when it is full and a flush is still running, the hit is dropped
 * and counted in `dropped`. A crash loses at most one flush interval of
 * hits. Usage is a signal for trimming, not an audit log.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { memoryFileUsage, memoryUsageTracking, type MemoryFileUsageRow } from "../schema/index.js";
import type { MemoryFileKey, MemoryScope } from "./memory.js";

export type { MemoryFileKey };

export type MemoryUseKind = "read" | "inject" | "cite";

export interface MemoryUsageRecorderOptions {
  /** How often the timer flushes. 0 turns the timer off (tests flush by hand). */
  flushIntervalMs?: number;
  /** Distinct files the buffer holds before a hit starts a flush. */
  maxBufferedFiles?: number;
}

export const MEMORY_USAGE_FLUSH_MS = 10_000;
export const MEMORY_USAGE_MAX_BUFFERED_FILES = 1_000;
/** Rows per upsert statement, to keep each statement's parameter count small. */
const FLUSH_CHUNK_ROWS = 200;

interface PendingUsage extends MemoryFileKey {
  reads: number;
  lastReadAt: number | null;
  injects: number;
  lastInjectedAt: number | null;
  cites: number;
  lastCitedAt: number | null;
}

function bufferKey(file: MemoryFileKey): string {
  return JSON.stringify([file.ownerType, file.ownerId, file.namespace, file.path]);
}

function later(a: number | null, b: number): number {
  return a === null || b > a ? b : a;
}

export class MemoryUsageRecorder {
  private buffer = new Map<string, PendingUsage>();
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedHits = 0;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedFiles: number;

  constructor(
    private readonly db: AppDb,
    opts: MemoryUsageRecorderOptions = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? MEMORY_USAGE_FLUSH_MS;
    this.maxBufferedFiles = opts.maxBufferedFiles ?? MEMORY_USAGE_MAX_BUFFERED_FILES;
  }

  /** Hits dropped because the buffer was full while a flush ran. */
  get dropped(): number {
    return this.droppedHits;
  }

  /** Buffers one use. Never waits on the database. */
  record(file: MemoryFileKey, kind: MemoryUseKind, at: number = Date.now()): void {
    const k = bufferKey(file);
    let pending = this.buffer.get(k);
    if (!pending) {
      if (this.buffer.size >= this.maxBufferedFiles) {
        if (this.inflight) {
          this.droppedHits++;
          return;
        }
        void this.flush();
      }
      pending = { ...file, reads: 0, lastReadAt: null, injects: 0, lastInjectedAt: null, cites: 0, lastCitedAt: null };
      this.buffer.set(k, pending);
    }
    if (kind === "read") {
      pending.reads++;
      pending.lastReadAt = later(pending.lastReadAt, at);
    } else if (kind === "inject") {
      pending.injects++;
      pending.lastInjectedAt = later(pending.lastInjectedAt, at);
    } else {
      pending.cites++;
      pending.lastCitedAt = later(pending.lastCitedAt, at);
    }
    this.ensureTimer();
  }

  /** Writes the buffered hits. A flush already running finishes first, so
   * the returned promise covers every hit recorded before the call. */
  async flush(): Promise<void> {
    if (this.inflight) await this.inflight;
    if (this.buffer.size === 0) return;
    // Swap before the first await, so a hit recorded during the write
    // lands in the next batch rather than in this one.
    const batch = [...this.buffer.values()];
    this.buffer = new Map();
    const run = this.write(batch).catch((err: unknown) => {
      // Usage is a trimming signal. A failed write loses this batch and
      // does not retry, so a database outage cannot grow the buffer.
      console.warn(`[memory-usage] could not record ${batch.length} memory file use(s). Check database availability.`, err);
    });
    this.inflight = run;
    try {
      await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  /** Stops the timer and writes what is buffered. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  private ensureTimer(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // The timer must never hold the process open on its own.
    this.timer.unref?.();
  }

  private async write(batch: PendingUsage[]): Promise<void> {
    for (let i = 0; i < batch.length; i += FLUSH_CHUNK_ROWS) {
      const rows = batch.slice(i, i + FLUSH_CHUNK_ROWS).map((u) => sql`(
        ${u.ownerType}::text, ${u.ownerId}::text, ${u.namespace}::text, ${u.path}::text,
        ${u.reads}::integer, ${u.lastReadAt}::bigint, ${u.injects}::integer, ${u.lastInjectedAt}::bigint,
        ${u.cites}::integer, ${u.lastCitedAt}::bigint)`);
      // The join keeps the table to files that exist: a hit buffered before
      // a delete or a move adds no row for the old path.
      await this.db.execute(sql`
        INSERT INTO memory_file_usage AS u (owner_type, owner_id, namespace, path,
          read_count, last_read_at, inject_count, last_injected_at, cite_count, last_cited_at)
        SELECT v.owner_type, v.owner_id, v.namespace, v.path,
          v.read_count, v.last_read_at, v.inject_count, v.last_injected_at, v.cite_count, v.last_cited_at
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(owner_type, owner_id, namespace, path,
          read_count, last_read_at, inject_count, last_injected_at, cite_count, last_cited_at)
        JOIN memory_files f ON f.owner_type = v.owner_type AND f.owner_id = v.owner_id
          AND f.namespace = v.namespace AND f.path = v.path
        ON CONFLICT (owner_type, owner_id, namespace, path) DO UPDATE SET
          read_count = u.read_count + excluded.read_count,
          last_read_at = GREATEST(u.last_read_at, excluded.last_read_at),
          inject_count = u.inject_count + excluded.inject_count,
          last_injected_at = GREATEST(u.last_injected_at, excluded.last_injected_at),
          cite_count = u.cite_count + excluded.cite_count,
          last_cited_at = GREATEST(u.last_cited_at, excluded.last_cited_at)`);
    }
  }
}

const recorders = new WeakMap<AppDb, MemoryUsageRecorder>();

/** The process's recorder for `db`. Routes, the snapshot and the citation
 * subscriber share it, so their hits batch together. */
export function memoryUsageRecorder(db: AppDb): MemoryUsageRecorder {
  let recorder = recorders.get(db);
  if (!recorder) {
    recorder = new MemoryUsageRecorder(db);
    recorders.set(db, recorder);
  }
  return recorder;
}

/** Usage for one owner scope's own files, by stored path. A file with no
 * row has never been used. */
export async function readMemoryUsage(db: AppDb, scope: MemoryScope): Promise<Map<string, MemoryFileUsageRow>> {
  const rows = await db
    .select()
    .from(memoryFileUsage)
    .where(and(
      eq(memoryFileUsage.ownerType, scope.owner.type),
      eq(memoryFileUsage.ownerId, scope.owner.id),
      eq(memoryFileUsage.namespace, scope.namespace ?? ""),
    ));
  return new Map(rows.map((row) => [row.path, row]));
}

/** When usage tracking started, in ms epoch. A missing row reads as now,
 * so a damaged table can make no file look stale. */
export async function memoryUsageSince(db: AppDb): Promise<number> {
  const [row] = await db.select({ startedAt: memoryUsageTracking.startedAt }).from(memoryUsageTracking).limit(1);
  return row?.startedAt ?? Date.now();
}
