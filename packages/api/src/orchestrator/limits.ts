/**
 * Phase 4 decision 21 — normative ceilings for orchestrator-spawned work.
 * Instance-level defaults; per-org configuration is a later phase (see the
 * workflow batch-fan-out design).
 */

/** Unsettled `child_watches` rows a single orchestrator may hold at once. */
export const MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR = 10;

const DEFAULT_ORG_ACTIVE_SESSION_CEILING = 100;

/**
 * Resolves the org active-session ceiling from `VALET_ORG_SESSION_CEILING`.
 * Unset or empty → the default (100). Anything that is not a positive
 * integer throws — a silently defaulted limit hides a misconfigured deploy.
 */
export function resolveOrgSessionCeiling(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_ORG_SESSION_CEILING;
  if (raw === undefined || raw === "") return DEFAULT_ORG_ACTIVE_SESSION_CEILING;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid VALET_ORG_SESSION_CEILING value "${raw}". ` +
        `Set VALET_ORG_SESSION_CEILING to a positive integer, or unset it ` +
        `to use the default (${DEFAULT_ORG_ACTIVE_SESSION_CEILING}).`,
    );
  }
  return n;
}

/**
 * Org-wide aggregate cap that workflow-spawned and orchestrator-spawned
 * sessions both count against. Counted (decision 21, amended 2026-08-19)
 * as: unsettled `child_watches` rows for the org + non-child
 * `agent_sessions` rows for the org with status `active`. A child counts
 * through its watch row only — once while running, zero once settled; its
 * `agent_sessions` row outlives settlement and must not hold the slot.
 * `hibernated` and `archived` sessions don't count: they consume no
 * compute, and on backends without hibernation an `active`-forever row is
 * no worse than the old `!= deleted` filter, which turned the ceiling into
 * a lifetime session counter. Workflow-spawned sessions still bypass this
 * count (no `agent_sessions` row) — closing that is part of the
 * batch-fan-out work.
 *
 * Tunable per instance via `VALET_ORG_SESSION_CEILING` (read once at boot).
 */
export const ORG_ACTIVE_SESSION_CEILING = resolveOrgSessionCeiling(process.env);

// Re-exported for callers that want every Phase 4 limit constant from one
// module — the engine owns the canonical definitions (decisions 4/5) since
// it's the component that actually enforces them at admission time.
export { SIGNAL_HOP_BUDGET, MAX_PENDING_PER_THREAD } from "@valet/engine";
