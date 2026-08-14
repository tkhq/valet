/**
 * Pure helpers for `/workflows/runs/$runId` (engine v2 Phase 5 decision 19).
 * Extracted from the route component so the "which wait condition is a
 * pending approval" and "what prompt does this node show" logic is testable
 * without rendering React — `RunWaitCondition`/`WorkflowNode` cross the wire
 * as `unknown` (see `GetWorkflowRunResponse.run.waitingOn`/`definition` in
 * `packages/api/src/wire/types.ts`), so these narrow at runtime rather than
 * casting.
 */

export interface PendingApproval {
  nodeId: string;
  signalType: string;
}

/**
 * A parked run's `waitingOn` entry for an approval node is
 * `{ kind: 'signal', nodeId, signalType: 'approval:{nodeId}' }`
 * (`packages/workflow/src/store.ts` `RunWaitCondition`, `nodes/approval.ts`).
 * Returns the first one found, or `undefined` if the run isn't parked on an
 * approval (e.g. parked on a timer/submission instead).
 */
export function findPendingApproval(waitingOn: unknown[]): PendingApproval | undefined {
  for (const w of waitingOn) {
    if (typeof w !== "object" || w === null) continue;
    const obj = w as Record<string, unknown>;
    if (
      obj.kind === "signal" &&
      typeof obj.nodeId === "string" &&
      typeof obj.signalType === "string" &&
      obj.signalType.startsWith("approval:")
    ) {
      return { nodeId: obj.nodeId, signalType: obj.signalType };
    }
  }
  return undefined;
}

/**
 * The run's `definition` is the snapshot the run was started against
 * (`WorkflowRun.definition` — a `dag/v1` `WorkflowDefinition`). Looks up an
 * `approval` node's `prompt` field by id for display; returns `undefined` if
 * the definition doesn't parse as expected or the node isn't an approval.
 */
export function findApprovalPrompt(definition: unknown, nodeId: string): string | undefined {
  if (typeof definition !== "object" || definition === null) return undefined;
  const nodes = (definition as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const n of nodes) {
    if (typeof n !== "object" || n === null) continue;
    const obj = n as Record<string, unknown>;
    if (obj.id === nodeId && obj.type === "approval" && typeof obj.prompt === "string") {
      return obj.prompt;
    }
  }
  return undefined;
}

// ─── run → canvas status mapping ─────────────────────────────────────────────

import type { NodeRunStatus } from "./editor/flow-node";

export interface RunCheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
}

export interface RunLike {
  status: string;
  waitingOn?: unknown;
}

export interface RunNodeStatuses {
  status: Record<string, NodeRunStatus>;
  /** Per-node progress badge for multi-iteration (foreach body) nodes, e.g. "3/12". */
  badges: Record<string, string>;
}

/**
 * Collapses a run's checkpoints (+ park state) into per-node canvas
 * statuses. Multi-iteration nodes (foreach bodies) aggregate: any failed →
 * failed, any in-flight → running, else succeeded/skipped; they also get a
 * "done/total" badge. Nodes the run is parked on (`waitingOn` entries with a
 * `nodeId`) show as `waiting`. Nodes with no checkpoint stay undecorated
 * (pending) — the preview renders them as plain cards.
 */
export function statusByNodeId(run: RunLike, checkpoints: RunCheckpointLike[]): RunNodeStatuses {
  const byNode = new Map<string, RunCheckpointLike[]>();
  for (const cp of checkpoints) {
    const list = byNode.get(cp.nodeId);
    if (list) list.push(cp);
    else byNode.set(cp.nodeId, [cp]);
  }

  const status: Record<string, NodeRunStatus> = {};
  const badges: Record<string, string> = {};

  for (const [nodeId, cps] of byNode) {
    const total = cps.length;
    const done = cps.filter((c) => c.status === "completed").length;
    if (cps.some((c) => c.status === "failed")) status[nodeId] = "failed";
    else if (cps.some((c) => c.status === "intent")) status[nodeId] = "running";
    else if (cps.every((c) => c.status === "skipped")) status[nodeId] = "skipped";
    else status[nodeId] = "succeeded";
    if (total > 1) badges[nodeId] = `${done}/${total}`;
  }

  if (run.status === "parked" && Array.isArray(run.waitingOn)) {
    for (const w of run.waitingOn) {
      if (typeof w !== "object" || w === null) continue;
      const nodeId = (w as Record<string, unknown>).nodeId;
      if (typeof nodeId === "string") status[nodeId] = "waiting";
    }
  }

  return { status, badges };
}

// ─── pending-gate helpers ─────────────────────────────────────────────────────

import type { WorkflowPendingGate } from "@valet/api/wire";

/**
 * Re-export so consumers importing from this module can use the wire type
 * without a second import path.
 */
export type { WorkflowPendingGate };
export type PendingGateLike = WorkflowPendingGate;

/**
 * Returns true only when the run is parked AND at least one pending gate
 * exists (meaning human action is required before the run can continue).
 */
export function runNeedsApproval(
  run: { status: string },
  pendingGates: WorkflowPendingGate[] | undefined,
): boolean {
  return run.status === "parked" && Array.isArray(pendingGates) && pendingGates.length > 0;
}

/** Truncated JSON preview for a checkpoint's `result`, mono-block friendly. */
export function jsonPreview(value: unknown, max = 400): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
