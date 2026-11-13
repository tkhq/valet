import type { DecisionAction, GatePromptRef } from "@valet/engine";
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { mayResolveWorkflowApproval, resolveWorkflowApproval, type ResolveApprovalOutcome, type WorkflowServiceDeps } from "../workflows/service.js";

/**
 * A workflow step that waits for approval: a `tool` node held by policy, or
 * an `approval` node. It is a checkpoint on the run, not an engine decision
 * gate, so its channel card answers through `resolveWorkflowApproval`, the
 * function the run page's buttons call.
 */
export interface WorkflowGateTarget {
  runId: string;
  nodeId: string;
  iteration: number;
  /** The gate occurrence. A stale card for an earlier occurrence is refused. */
  gateId?: string;
}

/**
 * The run page's checks, given to the channel host as a port. `providers`
 * wires both calls to `workflows/service.ts`; the host never decides access
 * itself.
 */
export interface WorkflowApprovalPort {
  /** True when this person may answer the step, so the card gets buttons. */
  mayResolve(person: { userId: string; orgId: string }, gate: WorkflowGateTarget, signal?: AbortSignal): Promise<boolean>;
  resolve(person: { userId: string; orgId: string }, gate: WorkflowGateTarget, approved: boolean): Promise<ResolveApprovalOutcome>;
}

/** The port over `workflows/service.ts`. `deps` is read per call: the run
 * host is built after the channel host. A clicker acts as themselves. */
export function workflowApprovalPort(deps: () => WorkflowServiceDeps | null): WorkflowApprovalPort {
  const ready = (): WorkflowServiceDeps => {
    const current = deps();
    if (!current) throw new Error("Workflow services are not ready. Answer the step on the run page in Valet.");
    return current;
  };
  const owner = (person: { userId: string; orgId: string }) => ({ ...person, principal: { type: "user" as const, id: person.userId } });
  return {
    mayResolve: async (person, gate) => mayResolveWorkflowApproval(ready(), owner(person), gate),
    resolve: async (person, gate, approved) => resolveWorkflowApproval(ready(), owner(person), {
      ...gate, approved, scope: "once", via: "channel",
    }),
  };
}

/** The run page's two main answers. Scoped choices stay on the run page. */
export const WORKFLOW_GATE_ACTIONS: DecisionAction[] = [
  { id: "approve", label: "Approve once", style: "primary" },
  { id: "deny", label: "Deny", style: "danger" },
];

const KEY_PREFIX = "wfgate:";

/**
 * The prompt key for a workflow step's cards. It names the occurrence, so it
 * is unique per gate, and it holds no "|" (the Slack button value splits on
 * it). The saved callback reference stores this key as its gate id, so a
 * restarted host can rebuild the target from the row alone.
 */
export function workflowGateKey(gate: WorkflowGateTarget): string {
  return `${KEY_PREFIX}${encodeURIComponent(JSON.stringify([gate.runId, gate.nodeId, gate.iteration, gate.gateId ?? null]))}`;
}

export function parseWorkflowGateKey(key: string): WorkflowGateTarget | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  let parts: unknown;
  try { parts = JSON.parse(decodeURIComponent(key.slice(KEY_PREFIX.length))); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 4) return null;
  const [runId, nodeId, iteration, gateId] = parts;
  if (typeof runId !== "string" || typeof nodeId !== "string" || typeof iteration !== "number") return null;
  if (gateId !== null && typeof gateId !== "string") return null;
  return { runId, nodeId, iteration, ...(gateId !== null ? { gateId } : {}) };
}

/** Saved workflow step cards, for a restarted host. Rows share the engine's
 * callback reference table with decision gates (`gate-prompts.ts`). */
export async function savedWorkflowGatePrompts(db: AppDb): Promise<Array<{ key: string; gate: WorkflowGateTarget; ref: GatePromptRef }>> {
  const rows = await db.select({ gateId: sql<string>`gate_id`, ref: sql<string>`ref` })
    .from(sql`engine_decision_gate_refs`)
    .where(sql`gate_id LIKE ${`${KEY_PREFIX}%`}`);
  const prompts: Array<{ key: string; gate: WorkflowGateTarget; ref: GatePromptRef }> = [];
  for (const row of rows) {
    const gate = parseWorkflowGateKey(row.gateId);
    let ref: unknown;
    try { ref = JSON.parse(row.ref); } catch { continue; }
    if (!gate || typeof ref !== "object" || ref === null || !("channelId" in ref) || !("messageId" in ref)
      || typeof ref.channelId !== "string" || typeof ref.messageId !== "string") continue;
    prompts.push({ key: row.gateId, gate, ref: { conversationKey: ref.channelId, messageId: ref.messageId } });
  }
  return prompts;
}

/**
 * What a click tells the person, and whether the card is finished. Every
 * refusal names what to do next. `settle` is the outcome line the card keeps
 * once its buttons go; it is absent when the gate still waits.
 */
export function workflowGateClickAnswer(
  outcome: ResolveApprovalOutcome,
  approved: boolean,
  name: string | undefined,
): { reply?: string; settle?: string } {
  const by = name !== undefined ? ` by ${name}` : "";
  switch (outcome) {
    case "ok": return { settle: approved ? `✅ Approved once${by}` : `❌ Denied${by}` };
    case "already_resolved": return { reply: "This step was already answered. Open the run in Valet to see the outcome.", settle: "☑️ Answered in Valet" };
    case "not_parked": return { reply: "This step no longer waits for approval. Open the run in Valet to see where it is.", settle: "☑️ No longer waiting" };
    case "stale_gate": return { reply: "This approval changed. Open the run in Valet and answer its current approval.", settle: "☑️ Replaced by a newer approval" };
    case "timed_out": return { reply: "This approval timed out. Start the run again in Valet.", settle: "⏳ Timed out" };
    case "not_approver": return { reply: "This step would use another member's shared account. Only that member can answer it." };
    case "not_found":
    case "org_mismatch": return { reply: "You cannot answer this step. Ask the workflow's owner or a team member to answer it in Valet." };
    case "human_only":
    case "forbidden_always":
    case "forbidden_workflow":
    case "stale_workflow": return { reply: "Answer this step on the run page in Valet." };
  }
}
