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
