/**
 * Cron sweep: reclaim concurrency slots held by executions whose
 * Cloudflare Workflow instance is never going to finish them.
 *
 * A workflow_executions row occupies a per-user concurrency slot for as
 * long as its status is one of ACTIVE_EXECUTION_STATUSES, and the only
 * code that writes a terminal status runs inside the Workflow instance
 * itself (workflows/execution-status.ts) or on the cancel path
 * (workflows/cancel-cleanup.ts). When an instance dies without getting
 * there — evicted, killed by a redeploy mid-run, or erroring at a moment
 * when D1 was unreachable so the interpreter's own catch could not write
 * either — nothing else ever finalizes the row. It holds its slot
 * forever, and the user's effective concurrency limit ratchets down by
 * one with each occurrence until they cannot start any work at all.
 *
 * The interpreter's catch (workflows/interpreter.ts) is the primary fix
 * and covers the failures the instance can still observe and write for.
 * This sweep is the backstop for the cases where no code of ours gets to
 * run again — including the ones where that catch itself could not write.
 *
 * The sweep does NOT guess from elapsed time. Age only bounds the query;
 * the Cloudflare instance status decides. That distinction matters,
 * because legitimate runs park for a long time — a session node waiting
 * on an idle agent defaults to a 24-hour wait — and a time-based reaper
 * would kill live work. An instance reporting running/waiting/queued/
 * paused is left completely alone regardless of age.
 *
 * Known gap, accepted deliberately: an instance an operator pauses from
 * the Cloudflare dashboard, or one reporting 'unknown', is never
 * reclaimed here. Both are indistinguishable from a live run, and the
 * cost of guessing wrong on a live run is the run itself.
 *
 * Rows that are unreachable through the cancel API land here too: an
 * execution whose workflow row was deleted has workflow_id NULL (ON
 * DELETE SET NULL), and the cancel endpoint 404s on it, so this sweep is
 * the only mechanism that can ever reclaim its slot.
 */

import { and, inArray, lt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { ACTIVE_EXECUTION_STATUSES } from '../lib/db/constants.js';
import { finalizeAbandonedExecution } from './execution-status.js';

/**
 * Instance states meaning the instance will never write another status,
 * mapped to the execution outcome each one actually represents.
 *
 * `complete` maps to 'completed', not 'failed'. An instance that ran to
 * completion while its row stayed active did succeed — that is precisely
 * the shape the widened terminal CAS now prevents, and the backlog this
 * sweep drains on first deploy is full of it. Recording those as failures
 * would terminate their spawned sessions with reason `workflow_failed`,
 * count successes as failures in analytics, and invite a user to re-run a
 * non-idempotent workflow that already did its work.
 */
const DEAD_INSTANCE_OUTCOMES: Record<string, 'completed' | 'failed' | 'cancelled'> = {
  complete: 'completed',
  terminated: 'cancelled',
  errored: 'failed',
};

/**
 * How long a row must have existed before the sweep will consider it.
 * createExecution inserts the row and only then creates the instance, so
 * a freshly inserted row legitimately has no instance yet and would look
 * "gone" to the probe below. This window has to comfortably exceed that
 * gap; it is not a staleness judgement.
 */
const DEFAULT_MIN_AGE_MS = 10 * 60_000;

/** Bounds the per-tick D1 scan and the number of Workflows API probes. */
const DEFAULT_LIMIT = 100;

export interface SweepStaleExecutionsResult {
  /** Rows examined (age-eligible and in an active status). */
  examined: number;
  /** Rows driven to a terminal status by this sweep. */
  reclaimed: number;
  /** Rows left alone because the instance state could not be established. */
  skipped: number;
}

export async function sweepStaleExecutions(
  env: Env,
  options: { minAgeMs?: number; limit?: number } = {},
): Promise<SweepStaleExecutionsResult> {
  if (!env.DB) return { examined: 0, reclaimed: 0, skipped: 0 };
  const db = getDb(env.DB);
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();

  const candidates = await db.select({
    id: workflowExecutions.id,
    status: workflowExecutions.status,
  })
    .from(workflowExecutions)
    .where(and(
      inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]),
      lt(workflowExecutions.startedAt, cutoff),
    ))
    // Oldest first, and deterministic. Without an explicit order the row
    // order is unspecified, so a backlog larger than `limit` could keep
    // re-examining the same slice every tick and never reach the rest.
    .orderBy(workflowExecutions.startedAt)
    .limit(limit)
    .all();

  let reclaimed = 0;
  let skipped = 0;
  for (const row of candidates) {
    try {
      const verdict = await probeInstance(env, row.id);
      if (!verdict.dead) continue;
      const landed = await finalizeAbandonedExecution(env, row.id, {
        status: verdict.outcome,
        error: verdict.error,
      });
      if (landed) {
        reclaimed++;
        // One line per reclaim, so a wrong verdict is traceable to the
        // execution and the instance state that authorised it — not just
        // visible as an aggregate after someone complains.
        console.log(`[stale-execution-sweep] reclaimed ${row.id} as ${verdict.outcome} (was ${row.status})`);
      }
    } catch (err) {
      // Reaching here means we could not establish that the instance is
      // dead, so the row is left alone and retried next tick. One bad row
      // must never stop the sweep — the next row may be the one actually
      // blocking someone. The message is logged verbatim because it is
      // how we learn the real shape of an unrecognised platform error.
      skipped++;
      console.warn(
        `[stale-execution-sweep] skipped execution ${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (skipped > 0) {
    console.warn(`[stale-execution-sweep] skipped ${skipped} of ${candidates.length} executions with an indeterminate instance state`);
  }

  return { examined: candidates.length, reclaimed, skipped };
}

type Probe =
  | { dead: false }
  | { dead: true; outcome: 'completed' | 'failed' | 'cancelled'; error?: string };

/**
 * Asks Cloudflare whether the instance behind this execution can still
 * make progress.
 *
 * Fails CLOSED. Only two things authorise the destructive write that
 * follows: a status the platform reports as terminal, or an error that
 * positively identifies the instance as missing. Every other failure —
 * a Workflows-service blip, an RPC timeout, a throttle — throws, and the
 * caller leaves the row for the next tick.
 *
 * That asymmetry is deliberate and it is not symmetric in cost. Being
 * wrong in the cautious direction holds a concurrency slot for one more
 * minute. Being wrong in the other direction destroys a live run: the
 * instance keeps executing while its row reads terminal, its real
 * terminal write no-ops against the CAS so the outcome is lost, the
 * spawned-session sweep tears down its sandboxes, and cancel refuses the
 * row as already terminal. cancel-cleanup.ts treats the same call the
 * same way, returning false rather than assuming the instance is gone.
 */
async function probeInstance(env: Env, executionId: string): Promise<Probe> {
  let instance: WorkflowInstance;
  try {
    instance = await env.WORKFLOW_INTERPRETER.get(executionId);
  } catch (err) {
    if (isInstanceNotFound(err)) {
      // Never created, or aged past Cloudflare's instance retention. No
      // code will ever finalize this row, and its true outcome is not
      // recoverable from anywhere.
      return { dead: true, outcome: 'failed', error: 'workflow instance no longer exists; reclaimed by the stale-execution sweep' };
    }
    throw err;
  }

  const { status, error } = await instance.status();
  const outcome = DEAD_INSTANCE_OUTCOMES[status];
  if (!outcome) return { dead: false };
  const detail = describeInstanceError(error);
  return {
    dead: true,
    outcome,
    error: outcome === 'completed'
      ? undefined
      : `workflow instance ${status}${detail ? `: ${detail}` : ''}; reclaimed by the stale-execution sweep`,
  };
}

/**
 * Renders the optional `error` on an InstanceStatus for the row's error
 * column. The declared type is `{ name, message }`, but this is untrusted
 * data crossing a platform boundary — reading `.message` off whatever
 * arrives would silently drop the context if it were ever a string or a
 * differently-shaped object, and a lost diagnostic is the failure mode
 * this sweep exists to stop repeating.
 */
function describeInstanceError(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

/**
 * Whether an error from `WORKFLOW_INTERPRETER.get` means "no such
 * instance" as opposed to "could not reach the service". Cloudflare
 * surfaces this as a `WorkflowError` carrying code 1001, and that code
 * is the only thing accepted here.
 *
 * Matching on message text was considered and rejected. A substring like
 * "not found" appears in generic fetch failures, D1 errors about a
 * missing row, and third-party middleware messages, none of which say
 * anything about the instance — and a false positive authorises the
 * destructive write this whole module is built to avoid. An error whose
 * code is absent is precisely an error we cannot attribute, so it is
 * transient by default: the caller leaves the row and logs the message
 * verbatim, which is how the real shape becomes visible in production
 * instead of being guessed at here.
 */
function isInstanceNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 1001;
}
