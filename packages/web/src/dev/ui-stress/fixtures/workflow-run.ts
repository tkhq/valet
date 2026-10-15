/** A parked workflow run with 25 pending gates (`GET /api/workflows/runs/:id`)
 * and a workflow agent session's own decision gates. */
import type {
  ListDecisionsResponse,
  WorkflowPendingGate,
  WorkflowRunCheckpoint,
  WorkflowRunDetail,
  WorkflowStepCost,
} from "@valet/api/wire";
import type { WorkflowDefinition, WorkflowNode } from "@valet/workflow";
import {
  DAY, HEX_300, HOUR, LONG_ACTION, LONG_SERVICE, MINUTE, NOW, STRING_2000, TITLE_400, URL_300,
  deepJson, memberId, stressMe, unbroken,
} from "./common";
import { decisionGate, longNodeId, stressTitle } from "./approvals";

/** Run ids allow only `[A-Za-z0-9_-]`; workflow agent session ids embed one. */
export const STRESS_RUN_ID = `wfrun_${unbroken("0123456789abcdef", 96)}`;

const FOREACH_ID = `notify_each_${unbroken("customer_account_owner_", 70)}`;
const FOREACH_BODY_ID = `${FOREACH_ID}_send`;

export const APPROVAL_GATE_COUNT = 10;
export const FOREACH_GATE_COUNT = 10;
export const TOOL_GATE_COUNT = 5;

/** Approval nodes are top level; their ids are unique, because the run page
 * keys approval cards by node id. */
function approvalNodeId(i: number): string {
  return i % 2 === 0 ? `${longNodeId(i)}_${i}` : `approve_step_${i}`;
}

const approvalGates: WorkflowPendingGate[] = Array.from({ length: APPROVAL_GATE_COUNT }, (_, i) => ({
  kind: "approval",
  nodeId: approvalNodeId(i),
  // Every fourth gate has no prompt, so the card falls back to the definition.
  prompt: i % 4 === 3 ? undefined : stressTitle(i),
  summary: i % 2 === 0 ? `${TITLE_400}\n\n${URL_300}` : undefined,
  details: [deepJson(5), STRING_2000, { Commit: HEX_300, Diff: STRING_2000 }, undefined][i % 4],
  waitingSince: NOW - i * 3 * HOUR,
  timeoutAt: NOW + i * DAY,
}));

/** A foreach over a tool node parks one policy gate per item. Item 0 has no
 * iteration; items 1 and up carry it. */
const foreachGates: WorkflowPendingGate[] = Array.from({ length: FOREACH_GATE_COUNT }, (_, i) => ({
  kind: "policy_gate",
  nodeId: FOREACH_BODY_ID,
  iteration: i === 0 ? undefined : i,
  service: LONG_SERVICE,
  action: LONG_ACTION,
  riskLevel: ["low", "medium", "high", "critical"][i % 4],
  provenance: i === 4 ? "resolver_error" : "org_policy",
  gateParams: { customer: `customer-${i}`, message: i % 3 === 0 ? STRING_2000 : "Your order shipped.", meta: deepJson(i % 5 + 2) },
  gateParamsTruncated: i % 3 === 0,
  gateItem: { index: i, id: `customer-${HEX_300.slice(0, 64)}-${i}` },
  onDeny: "skip",
  waitingSince: NOW - i * MINUTE,
}));

const toolGates: WorkflowPendingGate[] = Array.from({ length: TOOL_GATE_COUNT }, (_, i) => ({
  kind: "policy_gate",
  nodeId: `tool_${unbroken("call_external_system_", 60)}_${i}`,
  service: i % 2 === 0 ? LONG_SERVICE : "github",
  action: i % 2 === 0 ? LONG_ACTION : "merge_pull_request",
  riskLevel: i === 0 ? undefined : "critical",
  provenance: "org_policy",
  gateParams: deepJson(10),
  // One step would use another member's shared account; one uses the viewer's.
  approver: i === 1 ? { userId: memberId(9), name: `member-09 ${unbroken("SharedDeployAccount", 60)}` }
    : i === 2 ? { userId: stressMe.id, name: stressMe.name }
    : undefined,
  timeoutAt: NOW + HOUR,
  onDeny: "fail",
  waitingSince: NOW - i * DAY,
}));

export const stressPendingGates: WorkflowPendingGate[] = [...approvalGates, ...foreachGates, ...toolGates];

function signalType(gate: WorkflowPendingGate): string {
  return gate.iteration ? `approval:${gate.nodeId}:${gate.iteration}` : `approval:${gate.nodeId}`;
}

const nodes: WorkflowNode[] = [
  { id: "fetch_inputs", type: "llm", model: "model-1", prompt: TITLE_400 },
  ...approvalGates.map((gate): WorkflowNode => ({ id: gate.nodeId, type: "approval", prompt: `Definition prompt for ${gate.nodeId}: ${TITLE_400}` })),
  {
    id: FOREACH_ID,
    type: "foreach",
    items: "{{ nodes.fetch_inputs.output.customers }}",
    body: { id: FOREACH_BODY_ID, type: "tool", service: LONG_SERVICE, action: LONG_ACTION, params: { message: "{{ item.message }}" } },
  },
  ...toolGates.map((gate): WorkflowNode => ({ id: gate.nodeId, type: "tool", service: gate.service ?? "", action: gate.action ?? "", params: {} })),
];

const definition: WorkflowDefinition = {
  version: "dag/v1",
  nodes,
  edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })),
};

/** One checkpoint per node and iteration, as the run snapshot holds them. */
const checkpoints: WorkflowRunCheckpoint[] = Array.from({ length: 30 }, (_, i) => ({
  nodeId: i === 0 ? "fetch_inputs" : i % 3 === 0 ? `${longNodeId(i)}_${i}` : i % 3 === 1 ? FOREACH_BODY_ID : `step_${i}`,
  iteration: i % 3 === 1 ? i : 0,
  status: (["completed", "failed", "skipped", "intent"] as const)[i % 4]!,
  result: i % 4 === 0 ? { output: deepJson(4), text: STRING_2000 } : undefined,
  error: i % 4 === 1 ? `Request to ${URL_300} failed: ${STRING_2000.slice(0, 600)}` : undefined,
  createdAt: NOW - (30 - i) * 7 * MINUTE,
  schemaError: i === 8 ? `Expected object at ${unbroken("$.path.to.field", 120)}` : undefined,
  repairAttempted: i === 8 ? true : undefined,
}));

const stepCosts: WorkflowStepCost[] = Array.from({ length: 12 }, (_, i) => ({
  nodeId: i % 2 === 0 ? FOREACH_BODY_ID : `${longNodeId(i)}_${i}`,
  iteration: i,
  costUsd: i * 12.345,
  turns: i * 3,
  unpricedTurns: i % 4 === 0 ? 1 : 0,
  totalTokens: i * 123_456,
  models: i % 3 === 0 ? [`openrouter/${unbroken("provider-preview-model-", 60)}`, "model-2"] : ["model-1"],
}));

export const stressRunDetail: WorkflowRunDetail = {
  conversations: [],
  stepCosts,
  owner: { type: "user", id: stressMe.id },
  run: {
    runId: STRESS_RUN_ID,
    workflowId: `workflow-${unbroken("nightly-release-train-", 80)}`,
    status: "parked",
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - MINUTE,
    needsApproval: true,
    waitingOn: stressPendingGates.map((gate) => ({ kind: "signal", nodeId: gate.nodeId, signalType: signalType(gate) })),
    definition,
    params: { release: TITLE_400, nested: deepJson(3) },
  },
  checkpoints,
  signals: [],
  pendingGates: stressPendingGates,
};

/** A workflow agent session id: `wf:{runId}:{nodeId}`. */
export const STRESS_AGENT_SESSION_ID = `wf:${STRESS_RUN_ID}:${FOREACH_ID}`;

/** The agent session's own gates. The page lists only pending ones. */
export const stressAgentDecisions: ListDecisionsResponse = {
  gates: Array.from({ length: 10 }, (_, i) => decisionGate(i, {
    sessionId: STRESS_AGENT_SESSION_ID,
    status: i === 8 ? "resolved" : i === 9 ? "expired" : "pending",
  })),
};
