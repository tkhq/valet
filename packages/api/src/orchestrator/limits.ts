/**
 * Phase 4 decision 21 — normative ceilings for orchestrator-spawned work.
 * Defaults only; per-org configuration is a later phase.
 */

/** Unsettled `child_watches` rows a single orchestrator may hold at once. */
export const MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR = 10;

/**
 * Org-wide aggregate cap that workflow-spawned and orchestrator-spawned
 * sessions both count against. Counted (decision 21) as: unsettled
 * `child_watches` rows for the org + non-child `agent_sessions` rows for
 * the org that aren't `deleted`. A child counts through its watch row only
 * — once while running, zero once settled; its `agent_sessions` row
 * outlives settlement and must not hold the slot. Workflow-spawned
 * sessions still bypass this count (no `agent_sessions` row) — closing
 * that is part of the batch-fan-out work.
 */
export const ORG_ACTIVE_SESSION_CEILING = 25;

// Re-exported for callers that want every Phase 4 limit constant from one
// module — the engine owns the canonical definitions (decisions 4/5) since
// it's the component that actually enforces them at admission time.
export { SIGNAL_HOP_BUDGET, MAX_PENDING_PER_THREAD } from "@valet/engine";
