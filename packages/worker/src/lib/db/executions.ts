import type { D1Database } from '@cloudflare/workers-types';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { users, workflowExecutions } from '../schema/index.js';

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function parseNullableJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Trigger-data resolver for execution rows. The runtime writes the
 * validated trigger.data map to the legacy `inputs` column; this helper
 * parses it for read paths while the public API exposes `triggerData`.
 */
export function parseExecutionTriggerData(
  row: { inputs?: string | null },
): Record<string, unknown> | null {
  const raw = row.inputs ?? null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const parseExecutionInputs = parseExecutionTriggerData;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Data Access ─────────────────────────────────────────────────────────────

export async function listExecutions(
  db: D1Database,
  userId: string,
  opts: { limit?: number; offset?: number; status?: string; workflowId?: string } = {}
) {
  // Dynamic WHERE + LEFT JOIN — keep as raw SQL
  let query = `
    SELECT e.*, w.name as workflow_name
    FROM workflow_executions e
    LEFT JOIN workflows w ON e.workflow_id = w.id
    WHERE e.user_id = ?
  `;
  const params: unknown[] = [userId];

  if (opts.status) {
    query += ' AND e.status = ?';
    params.push(opts.status);
  }

  if (opts.workflowId) {
    query += ' AND e.workflow_id = ?';
    params.push(opts.workflowId);
  }

  query += ' ORDER BY e.started_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);

  return db.prepare(query).bind(...params).all();
}

export async function getExecution(db: D1Database, executionId: string, userId: string) {
  // Multi-table LEFT JOIN — keep as raw SQL
  return db.prepare(`
    SELECT e.*, w.name as workflow_name, t.name as trigger_name
    FROM workflow_executions e
    LEFT JOIN workflows w ON e.workflow_id = w.id
    LEFT JOIN triggers t ON e.trigger_id = t.id
    WHERE e.id = ? AND e.user_id = ?
  `).bind(executionId, userId).first();
}

export async function checkIdempotencyKey(
  db: D1Database,
  workflowId: string,
  userId: string,
  idempotencyKey: string,
) {
  // user_id is part of the lookup so two tenants can independently use
  // the same delivery/idempotency value without colliding. Defense in
  // depth on top of trigger/workflow auth scoping at the route level.
  return db.prepare(`
    SELECT id, status
    FROM workflow_executions
    WHERE workflow_id = ? AND user_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(workflowId, userId, idempotencyKey).first();
}

// ─── Concurrency ────────────────────────────────────────────────────────────
// ACTIVE_EXECUTION_STATUSES lives in lib/db/constants.ts as the single
// source of truth — see the rationale there.

import {
  ACTIVE_EXECUTION_STATUSES,
  GLOBAL_EXECUTION_CONCURRENCY_CAP,
  PER_USER_EXECUTION_CONCURRENCY_CAP,
} from './constants.js';

export interface WorkflowConcurrencyLimits {
  perUser: number;
  global: number;
}

/**
 * Resolve the effective concurrency ceilings for a user. `users.
 * max_workflow_executions` is a per-user override (NULL = default),
 * mirroring `users.max_active_sessions`.
 *
 * Only the per-user ceiling is overridable; the global cap is a property
 * of the worker, not of the tenant, so a large per-user grant still can't
 * consume more than the worker allows.
 *
 * Callers must not read the column directly — routing every path through
 * here is what keeps the immediate check in startWorkflowExecution and the
 * pre-dispatch check in checkWorkflowConcurrency from drifting apart.
 */
export async function resolveWorkflowConcurrencyLimits(
  db: AppDb,
  userId: string,
): Promise<WorkflowConcurrencyLimits> {
  const row = await db
    .select({ maxWorkflowExecutions: users.maxWorkflowExecutions })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  // Guard against a 0 or negative override silently wedging the user out of
  // running anything; treat those as "unset" rather than "blocked".
  const override = row?.maxWorkflowExecutions;
  const perUser = typeof override === 'number' && override > 0
    ? override
    : PER_USER_EXECUTION_CONCURRENCY_CAP;
  return { perUser, global: GLOBAL_EXECUTION_CONCURRENCY_CAP };
}

export async function countActiveExecutions(db: AppDb, userId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(workflowExecutions)
    .where(and(
      eq(workflowExecutions.userId, userId),
      inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]),
    ))
    .get();
  return row?.count ?? 0;
}

export async function countActiveExecutionsGlobal(db: AppDb): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]))
    .get();
  return row?.count ?? 0;
}
