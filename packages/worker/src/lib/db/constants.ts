/**
 * Constants and utility helpers shared across db service modules.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  collaborator: 1,
  owner: 2,
};

export const ACTIVE_SESSION_STATUSES = ['initializing', 'running', 'idle', 'restoring'];
export const DEFAULT_MAX_ACTIVE_SESSIONS = 10;
export const MEMORY_CAP = 200;

// ─── Workflow execution status sets + concurrency caps ─────────────────────
// Single source of truth — every consumer (concurrency pre-check,
// createExecution authoritative check, cancellation cleanup CAS,
// status-transition guards) MUST import from here. Drift between
// files is what caused round-2/round-3 regressions.
//
// `cancelling` is intentionally excluded from ACTIVE so a user who just
// cancelled can immediately start new work — the cron sweep finalizes
// asynchronously. CLEANUP_CAS includes cancelling so the second step of
// the cancel pipeline can move the row past the transient state.

export const ACTIVE_EXECUTION_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_time',
] as const satisfies readonly string[];

export const CANCEL_CAS_PRIOR_STATUSES = ACTIVE_EXECUTION_STATUSES;

export const CLEANUP_CAS_PRIOR_STATUSES = [
  ...ACTIVE_EXECUTION_STATUSES,
  'cancelling',
] as const satisfies readonly string[];

/**
 * Default per-user concurrency cap (spec §"Retry, Concurrency, And Quota").
 * A user row may raise its own ceiling via `users.max_workflow_executions`;
 * resolveWorkflowConcurrencyLimits() in lib/db/executions.ts is the only
 * place that reads the override, and every caller goes through it.
 */
export const PER_USER_EXECUTION_CONCURRENCY_CAP = 30;

/**
 * Per-worker global cap. Sized at ~5x the per-user default so a handful of
 * tenants can run at their full per-user ceiling concurrently. This bounds
 * D1 write pressure more than it bounds Cloudflare Workflows instances:
 * every node transition writes a workflow_execution_nodes row, and D1
 * serializes writes per binding.
 */
export const GLOBAL_EXECUTION_CONCURRENCY_CAP = 150;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function generateShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeNotificationEventType(eventType?: string | null): string {
  const trimmed = eventType?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '*';
}
