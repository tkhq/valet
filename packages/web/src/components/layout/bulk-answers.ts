/**
 * Bulk "Approve all" / "Deny all" for the notification bell. This module
 * decides which listed requests one bulk answer may cover, builds the same
 * request bodies the per-item buttons send, and runs them with limited
 * concurrency. Server authorization is unchanged: every answer goes through
 * the per-item endpoint.
 */
import type {
  ListNotificationDecisionsResponse,
  ResolveDecisionRequest,
  ResolveWorkflowApprovalRequest,
  WorkflowActionRequiredItem,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { errorText } from "~/lib/error-text";

export type BulkDecision = "approve" | "deny";

/** The engine's built-in approval gate actions. A gate qualifies only when
 * the server marks it `oneShot`: a tool approval whose "approve" allows that
 * one call. Other approval gates also use these ids (`ask_approval`,
 * `sec_start`), but their approval can cover later work. The policy resolver
 * adds `approve_session` and `always_allow` (`api/src/policies/service.ts`);
 * both write a lasting grant, so a bulk answer never sends them. */
const ONE_TIME_APPROVE = "approve";
const DENY = "deny";

/** At most this many answers are in flight at one time. */
const CONCURRENCY = 4;

type DecisionItem = ListNotificationDecisionsResponse["items"][number];

export interface DecisionTarget { kind: "decision"; key: string; title: string; context?: string; sessionId: string; gateId: string }
export interface WorkflowTarget { kind: "workflow"; key: string; title: string; context?: string; runId: string; nodeId: string; iteration?: number; policy: boolean }
export type BulkTarget = DecisionTarget | WorkflowTarget;

export type SkipReason = "needs_answer" | "needs_credential" | "waiting_on_other" | "shares_your_account" | "not_one_shot" | "policy_check_failed" | "high_risk" | "not_pending";

export interface SkippedItem { key: string; title: string; reason: SkipReason }

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  needs_answer: "Needs a typed answer.",
  needs_credential: "Needs a credential.",
  waiting_on_other: "Waits on another member.",
  shares_your_account: "Lends your shared account. Answer it on its own.",
  not_one_shot: "Its approval can cover more than this one call. Answer it on its own.",
  policy_check_failed: "Policy check failed. Answer it on its own.",
  high_risk: "High-risk action. Answer it on its own.",
  not_pending: "Is no longer pending.",
};

/** A gate that names an approver lends that member's shared account, and its
 * approval also covers later calls in the thread or run. That is not a
 * one-time answer, so a bulk answer skips it whoever the approver is. */
function approverReason(approver: { userId: string } | undefined, meId: string | undefined): SkipReason | undefined {
  if (!approver) return undefined;
  return approver.userId === meId ? "shares_your_account" : "waiting_on_other";
}

function decisionSkipReason({ gate }: DecisionItem, meId: string | undefined): SkipReason | undefined {
  if (gate.status !== "pending") return "not_pending";
  if (gate.type !== "approval") return gate.type === "credential_request" ? "needs_credential" : "needs_answer";
  const approver = approverReason(gate.approver, meId);
  if (approver) return approver;
  // The per-item card warns that the policy may have denied this action.
  if (gate.provenance?.source === "resolver_error") return "policy_check_failed";
  const ids = new Set(gate.actions.map(a => a.id));
  if (gate.oneShot !== true || !ids.has(ONE_TIME_APPROVE) || !ids.has(DENY)) return "not_one_shot";
  return undefined;
}

/** The per-item policy card shows a failed policy check and the risk level.
 * The bulk dialog lists titles only, so it leaves these gates to that card. */
function policyWarning(gate: WorkflowActionRequiredItem["gate"]): SkipReason | undefined {
  if (gate.kind !== "policy_gate") return undefined;
  if (gate.provenance === "resolver_error") return "policy_check_failed";
  if (gate.riskLevel === "high" || gate.riskLevel === "critical") return "high_risk";
  return undefined;
}

function workflowTitle(item: WorkflowActionRequiredItem): string {
  const { gate } = item;
  const action = gate.kind === "policy_gate" && gate.service && gate.action ? `${gate.service}.${gate.action}` : gate.prompt ?? gate.nodeId;
  return `${item.workflowName}: ${action}`;
}

/** Splits the LISTED items into what one bulk answer covers and what it
 * skips, with a reason for each skip. It never looks past the loaded page. */
export function planBulkAnswers(
  workflows: readonly WorkflowActionRequiredItem[],
  decisions: readonly DecisionItem[],
  meId: string | undefined,
): { targets: BulkTarget[]; skipped: SkippedItem[] } {
  const targets: BulkTarget[] = [];
  const skipped: SkippedItem[] = [];
  for (const item of workflows) {
    const key = `workflow:${item.id}`;
    const title = workflowTitle(item);
    const reason = approverReason(item.gate.approver, meId) ?? policyWarning(item.gate);
    if (reason) { skipped.push({ key, title, reason }); continue; }
    targets.push({ kind: "workflow", key, title, runId: item.runId, nodeId: item.gate.nodeId, iteration: item.gate.iteration, policy: item.gate.kind === "policy_gate" });
  }
  for (const item of decisions) {
    const key = `decision:${item.gate.id}`;
    const reason = decisionSkipReason(item, meId);
    if (reason) { skipped.push({ key, title: item.gate.title, reason }); continue; }
    targets.push({ kind: "decision", key, title: item.gate.title, context: item.title, sessionId: item.sessionId, gateId: item.gate.id });
  }
  return { targets, skipped };
}

export function decisionRequest(decision: BulkDecision): ResolveDecisionRequest {
  return { actionId: decision === "approve" ? ONE_TIME_APPROVE : DENY };
}

/** Approval nodes take no scope. A policy gate approval is "once" only: it
 * never writes a run or workflow grant. A denial needs no scope. */
export function workflowRequest(target: WorkflowTarget, decision: BulkDecision): ResolveWorkflowApprovalRequest {
  if (decision === "deny") return { approved: false, iteration: target.iteration };
  return target.policy ? { approved: true, scope: "once", iteration: target.iteration } : { approved: true, iteration: target.iteration };
}

export interface BulkOutcome {
  done: BulkTarget[];
  /** 404 or 409: answered elsewhere, expired, or no longer visible to the
   * caller. Not counted as answered by this run. */
  gone: BulkTarget[];
  /** Answered or gone, but the refetched lists still show it waiting. */
  stillWaiting: BulkTarget[];
  failed: Array<{ target: BulkTarget; error: string }>;
}

/** 404 means the gate is not pending for this caller any more (answered,
 * removed, or access lost), and 409 means another answer or a timeout
 * settled it first. Neither proves this run answered it. */
function gone(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409);
}

/** Answers every target. One failure does not stop the others. `onProgress`
 * receives the number of settled answers. */
export async function answerAll(
  targets: readonly BulkTarget[],
  answer: (target: BulkTarget) => Promise<unknown>,
  onProgress: (settled: number) => void,
): Promise<BulkOutcome> {
  const results: Array<{ ok: true } | { ok: false; err: unknown }> = new Array(targets.length);
  let next = 0;
  let settled = 0;
  async function worker() {
    while (next < targets.length) {
      const index = next++;
      try { await answer(targets[index]!); results[index] = { ok: true }; }
      catch (err) { results[index] = { ok: false, err }; }
      onProgress(++settled);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const outcome: BulkOutcome = { done: [], gone: [], stillWaiting: [], failed: [] };
  targets.forEach((target, index) => {
    const result = results[index]!;
    if (result.ok) outcome.done.push(target);
    else if (gone(result.err)) outcome.gone.push(target);
    else outcome.failed.push({ target, error: errorText(result.err) });
  });
  return outcome;
}

/** The keys `planBulkAnswers` gives the items in these lists. */
export function listedKeys(workflows: readonly WorkflowActionRequiredItem[], decisions: readonly DecisionItem[]): Set<string> {
  return new Set([...workflows.map(item => `workflow:${item.id}`), ...decisions.map(item => `decision:${item.gate.id}`)]);
}

/** A target that the refetched lists still show is not answered, whatever
 * its response said. `listed` is undefined when the refetch failed. */
export function reconcileBulkAnswers(outcome: BulkOutcome, listed: ReadonlySet<string> | undefined): BulkOutcome {
  if (!listed) return outcome;
  const waiting = (t: BulkTarget) => listed.has(t.key);
  return {
    done: outcome.done.filter(t => !waiting(t)),
    gone: outcome.gone.filter(t => !waiting(t)),
    stillWaiting: [...outcome.stillWaiting, ...outcome.done.filter(waiting), ...outcome.gone.filter(waiting)],
    failed: outcome.failed,
  };
}

export function summarizeBulkAnswers(decision: BulkDecision, { done, gone, stillWaiting, failed }: BulkOutcome): string {
  const parts = [`${decision === "approve" ? "Approved" : "Denied"} ${done.length}.`];
  if (gone.length) parts.push(`${gone.length} ${gone.length === 1 ? "was" : "were"} no longer waiting.`);
  if (stillWaiting.length) parts.push(`${stillWaiting.length} still waiting: ${stillWaiting.map(t => t.title).join(", ")}`);
  if (failed.length) parts.push(`${failed.length} failed: ${failed.map(f => `${f.target.title}: ${f.error}`).join(" ")}`);
  return parts.join(" ");
}
