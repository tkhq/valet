/**
 * Phase 4 decision 21 — normative ceilings for orchestrator-spawned work.
 * Defaults only; per-org configuration is a later phase.
 */

/** Unsettled `child_watches` rows a single orchestrator may hold at once. */
export const MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR = 10;

/**
 * Org-wide aggregate cap that workflow-spawned and orchestrator-spawned
 * sessions both count against. Approximated (decision 21) as: unsettled
 * `child_watches` rows for the org + `agent_sessions` rows for the org that
 * aren't `deleted`. Workflow-spawned sessions don't exist yet (Phase 5+),
 * so today this is effectively (unsettled children) + (live interactive +
 * orchestrator sessions).
 */
export const ORG_ACTIVE_SESSION_CEILING = 25;

// Re-exported for callers that want every Phase 4 limit constant from one
// module — the engine owns the canonical definitions (decisions 4/5) since
// it's the component that actually enforces them at admission time.
export { SIGNAL_HOP_BUDGET, MAX_PENDING_PER_THREAD } from "@valet/engine";
