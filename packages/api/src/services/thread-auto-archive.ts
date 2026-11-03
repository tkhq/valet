/**
 * Idle thread auto-archive. A thread that nobody used for
 * `VALET_THREAD_ARCHIVE_DAYS` days (default 7, 0 turns it off) leaves the
 * default sidebar list and the Home Tasks panel. It is the same display-only
 * archive a person can apply: `session_threads.archived_at`, with
 * `archived_by = 'system'`. Search still finds it, and the next message in it
 * brings it back (`services/thread-activity.ts`).
 *
 * "Used" means the later of the newest engine entry on the thread
 * (`engine_threads.updated_at` moves with each entry: a message from anyone,
 * a turn, a tool run) and the last user action
 * (`session_threads.last_user_activity_at`). These threads are never
 * archived here, because archiving would hide work that someone still has
 * to see or answer:
 *   - a running or queued turn (an unsettled queue item);
 *   - a pending approval or decision;
 *   - a pending or running wakeup (schedules, background commands, child
 *     subscriptions), or an unfinished child task (`child_watches`);
 *   - a thread anyone pinned in their sidebar;
 *   - the Home thread;
 *   - a team conversation's governing thread: its execution session's thread
 *     carries the activity, and deliveries read the governing thread's
 *     archive state too.
 *
 * Replicas: every API process runs the sweep. Each batch takes a
 * transaction-scoped advisory lock and skips when another process holds it,
 * and the write only touches rows that are still unarchived, so two passes
 * never archive the same thread twice.
 */
import { metrics } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { HOME_THREAD_KEY } from "../home/context.js";

/** Days without use before a thread is archived when `VALET_THREAD_ARCHIVE_DAYS` is unset. */
export const DEFAULT_THREAD_ARCHIVE_DAYS = 7;
/** The `archived_by` value that marks an archive the sweep made. */
export const SYSTEM_ARCHIVER = "system";

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Threads archived per statement. A pass repeats until a batch comes back short. */
const BATCH = 500;
/** Advisory lock key for one batch: hashtext('valet.thread-auto-archive') is computed in SQL. */
const LOCK_NAME = "valet.thread-auto-archive";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let archivedCounter: Counter | undefined;

/**
 * Reads `VALET_THREAD_ARCHIVE_DAYS`: whole days, 0 turns auto-archive off.
 * Unset or blank means 7. An invalid value throws at boot, naming the variable.
 */
export function parseThreadArchiveDays(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_THREAD_ARCHIVE_DAYS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_THREAD_ARCHIVE_DAYS;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`VALET_THREAD_ARCHIVE_DAYS is "${env.VALET_THREAD_ARCHIVE_DAYS}". Set a whole number of days (0 turns auto-archive off), or remove it to use ${DEFAULT_THREAD_ARCHIVE_DAYS}.`);
  }
  return Number(raw);
}

let configuredDays: number | undefined;
/** This process's `VALET_THREAD_ARCHIVE_DAYS`, read once. */
export function threadArchiveDays(): number {
  configuredDays ??= parseThreadArchiveDays(process.env);
  return configuredDays;
}

/** Archive one batch of idle threads. Returns the number archived, or null when another process holds the lock. */
async function archiveIdleBatch(db: AppDb, days: number, now: number): Promise<number | null> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_NAME})) AS got`) as { rows: Array<{ got: boolean }> };
    if (!lock.rows[0]?.got) return null;
    const result = await tx.execute(sql`
      WITH pinned AS (
        SELECT DISTINCT jsonb_array_elements_text(p.doc->'value'->'pinned') AS id FROM plugin_store p
        WHERE p.plugin = 'valet' AND p.collection = 'thread-projects'
      ), idle AS (
        SELECT t.id, t.session_id, t.created_at
        FROM engine_threads t
        JOIN agent_sessions s ON s.id = t.session_id
        LEFT JOIN session_threads m ON m.id = t.id
        WHERE s.status IN ('active', 'hibernated')
          AND t.key <> ${HOME_THREAD_KEY}
          AND m.archived_at IS NULL
          AND GREATEST(t.updated_at, COALESCE(m.last_user_activity_at, 0)) < ${now - days * DAY_MS}
          AND t.id NOT IN (SELECT id FROM pinned)
          AND NOT EXISTS (SELECT 1 FROM assistant_executions x WHERE x.governing_thread_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM engine_decision_gates g
            WHERE g.session_id = t.session_id AND g.thread_id = t.id AND g.status = 'pending')
          AND NOT EXISTS (SELECT 1 FROM engine_queue_items q
            WHERE q.session_id = t.session_id AND q.thread_id = t.id AND q.status <> 'settled')
          AND NOT EXISTS (SELECT 1 FROM engine_wakeups w
            WHERE w.session_id = t.session_id AND w.thread_id = t.id AND w.status IN ('pending', 'running'))
          AND NOT EXISTS (SELECT 1 FROM child_watches c
            WHERE c.parent_session_id = t.session_id AND c.parent_thread_id = t.id AND (NOT c.settled OR c.delivery_active))
        LIMIT ${BATCH}
      )
      INSERT INTO session_threads (id, session_id, created_at, archived_at, archived_by)
      SELECT id, session_id, created_at, ${now}, ${SYSTEM_ARCHIVER} FROM idle
      ON CONFLICT (id) DO UPDATE SET archived_at = EXCLUDED.archived_at, archived_by = EXCLUDED.archived_by
        WHERE session_threads.archived_at IS NULL
      RETURNING id`) as { rows: Array<{ id: string }> };
    return result.rows.length;
  });
}

/**
 * Archive every idle thread. Returns the number archived. Returns 0 when
 * `days` is 0, or when another process is sweeping.
 */
export async function archiveIdleThreads(db: AppDb, days: number, now = Date.now()): Promise<number> {
  if (days <= 0) return 0;
  let total = 0;
  for (;;) {
    const archived = await archiveIdleBatch(db, days, now);
    if (archived === null) return total;
    total += archived;
    if (archived < BATCH) return total;
  }
}

/** Starts the hourly pass. Logs and counts each pass. Stop drains a pass in flight. */
export function startThreadAutoArchiveSweep(db: AppDb, days: number, intervalMs = SWEEP_INTERVAL_MS): SweepTimer {
  return startSweepTimer("ThreadAutoArchive", intervalMs, async () => {
    const started = Date.now();
    const archived = await archiveIdleThreads(db, days, started);
    archivedCounter ??= metrics.getMeter("@valet/api").createCounter("valet.threads.auto_archived", {
      description: "Threads the idle sweep archived",
    });
    archivedCounter.add(archived);
    console.log(`ThreadAutoArchive: archived ${archived} thread(s) idle for ${days}+ days in ${Date.now() - started}ms`);
  });
}
