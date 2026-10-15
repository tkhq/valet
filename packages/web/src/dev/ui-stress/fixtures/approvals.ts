/**
 * The notification bell's "Needs action" list: workflow approvals and
 * policy gates (`GET /api/workflows/action-required`) beside decision gates
 * (`GET /api/notifications/decisions`), 40 on the first page plus a second
 * page behind the cursor.
 */
import type {
  DecisionAction,
  DecisionGate,
  DecisionGateProvenance,
  ListNotificationDecisionsResponse,
  ListWorkflowActionRequiredResponse,
  WorkflowActionRequiredItem,
  WorkflowPendingGate,
} from "@valet/api/wire";
import {
  DAY, EMOJI, HEX_300, HOUR, LONG_ACTION, LONG_SERVICE, MINUTE, NOW, RTL_ARABIC, RTL_HEBREW, STRING_2000, TITLE_400,
  UI_STRESS_MARKER, URL_300, deepJson, memberId, stressMe, teamId, unbroken,
} from "./common";

type DecisionItem = ListNotificationDecisionsResponse["items"][number];

/** Titles from one word to 400 characters, unbroken tokens, emoji, and
 * right-to-left text. Fixtures cycle through it. */
export const STRESS_TITLES: readonly string[] = [
  "Deploy",
  TITLE_400,
  `Publish build ${URL_300}`,
  `Verify artifact checksum ${HEX_300}`,
  `${EMOJI} Ship the release ${EMOJI}`,
  RTL_ARABIC,
  `${RTL_HEBREW} — mixed with English words and ${EMOJI}`,
  `Approve ${UI_STRESS_MARKER}`,
  "Rotate credentials for the payments sandbox",
  unbroken("Supercalifragilistic", 140),
];

export function stressTitle(i: number): string {
  return STRESS_TITLES[i % STRESS_TITLES.length]!;
}

const TRIGGERS: WorkflowActionRequiredItem["trigger"][] = [
  { type: "manual" },
  { type: "schedule", triggerId: `schedule-${unbroken("nightly", 64)}` },
  { type: "webhook", triggerId: `webhook-${HEX_300.slice(0, 120)}` },
  { type: "event", triggerId: "event-github-pull-request-opened" },
  { type: "workflow", triggerId: "workflow-parent-run" },
  { type: "unknown" },
];

/** A long node id as a generated or nested workflow names it. */
export function longNodeId(i: number): string {
  return `approve_${unbroken("deployment_to_production_cluster_", 90)}_${i}`;
}

function approvalGate(i: number): WorkflowPendingGate {
  const details: unknown[] = [
    deepJson(6),
    STRING_2000,
    { Repository: URL_300, Commit: HEX_300, Summary: TITLE_400, Nested: deepJson(3) },
    ["first", "second", { third: deepJson(2) }],
  ];
  return {
    kind: "approval",
    nodeId: i % 2 === 0 ? longNodeId(i) : `approve_${i}`,
    prompt: stressTitle(i + 3),
    summary: i % 3 === 0 ? `${TITLE_400}\n\nSecond paragraph: ${URL_300}\n${HEX_300}` : "Review the generated release notes.",
    details: details[i % details.length],
    iteration: i % 4 === 0 ? i * 3 : undefined,
    waitingSince: NOW - i * 7 * HOUR,
  };
}

const RISKS = ["low", "medium", "high", "critical"] as const;

function policyGate(i: number): WorkflowPendingGate {
  return {
    kind: "policy_gate",
    nodeId: longNodeId(i),
    service: i % 3 === 0 ? LONG_SERVICE : "github",
    action: i % 3 === 0 ? LONG_ACTION : "create_pull_request",
    riskLevel: RISKS[i % RISKS.length],
    provenance: i % 5 === 0 ? "resolver_error" : "org_policy",
    gateParams: deepJson(8),
    gateParamsTruncated: i % 2 === 0,
    timeoutAt: NOW + (i + 1) * DAY,
    onDeny: i % 2 === 0 ? "skip" : "fail",
    iteration: i % 4 === 1 ? i : undefined,
    waitingSince: NOW - i * 40 * MINUTE,
    // One shared-account gate waits on another member, one on the viewer.
    approver: i === 3 ? { userId: memberId(7), name: "member-07 (Team Alpha shared release account)" }
      : i === 7 ? { userId: stressMe.id, name: stressMe.name }
      : undefined,
  };
}

function workflowItem(i: number): WorkflowActionRequiredItem {
  const owner: WorkflowActionRequiredItem["owner"] = i % 6 === 5 ? { type: "user", id: stressMe.id }
    : i === 11 ? { type: "org", id: "org-stress" }
    : { type: "team", id: teamId(i) };
  return {
    id: `wf-item-${i}`,
    runId: `run-${unbroken("0123456789abcdef", 32)}-${i}`,
    workflowId: `workflow-${i}`,
    workflowName: stressTitle(i),
    runCreatedAt: NOW - i * 3 * HOUR,
    owner,
    trigger: TRIGGERS[i % TRIGGERS.length]!,
    canReadRun: i === 9 ? false : undefined,
    gate: i % 2 === 0 ? policyGate(i) : approvalGate(i),
  };
}

export const WORKFLOW_APPROVAL_COUNT = 20;

const workflowItems = Array.from({ length: WORKFLOW_APPROVAL_COUNT }, (_, i) => workflowItem(i));

export const stressWorkflowActionRequired: ListWorkflowActionRequiredResponse = {
  items: workflowItems,
  count: workflowItems.length,
};

/** The actions the policy resolver offers on a tool approval gate. */
export const TOOL_APPROVAL_ACTIONS: DecisionAction[] = [
  { id: "approve", label: "Approve once", style: "primary" },
  { id: "approve_session", label: "Allow for this thread" },
  { id: "always_allow", label: "Always allow" },
  { id: "deny", label: "Deny", style: "danger" },
];

/** Eight long options for an `ask_question` gate. */
export const QUESTION_OPTIONS: DecisionAction[] = Array.from({ length: 8 }, (_, i) => ({
  id: `option-${i}`,
  label: i === 2 ? URL_300 : i === 5 ? `${RTL_ARABIC} ${EMOJI}` : `Option ${i + 1}: ${TITLE_400.slice(0, 60 + i * 30)}`,
}));

const PROVENANCE: Array<DecisionGateProvenance | undefined> = [
  { baseMode: "require_approval", source: "org_policy", matchedPolicyId: `policy-${HEX_300.slice(0, 40)}` },
  { baseMode: "require_approval", source: "team_policy" },
  { baseMode: "require_approval", source: "risk_default" },
  { baseMode: "allow", source: "resolver_error" },
  { baseMode: "require_approval", source: "plugin_default" },
  undefined,
  { baseMode: "require_approval", source: `custom_source_${unbroken("rung", 40)}` },
];

const GATE_TYPES: DecisionGate["type"][] = ["approval", "approval", "question", "approval", "credential_request"];

/** One decision gate. `status` and `approver` vary by index. */
export function decisionGate(i: number, overrides: Partial<DecisionGate> = {}): DecisionGate {
  const type = GATE_TYPES[i % GATE_TYPES.length]!;
  const actions = type === "question" ? QUESTION_OPTIONS
    : type === "credential_request" ? [{ id: "provide", label: "Connect account", style: "primary" as const }, { id: "deny", label: "Skip" }]
    : TOOL_APPROVAL_ACTIONS;
  const bodies = [
    JSON.stringify({ tool: `${LONG_SERVICE}.${LONG_ACTION}`, params: deepJson(7) }, null, 2),
    `Fetch ${URL_300} and compare it with ${HEX_300}.`,
    STRING_2000,
    undefined,
  ];
  return {
    id: `gate-${i}`,
    sessionId: `session-${teamId(i % 30)}`,
    threadId: `thread-${i}`,
    type,
    title: stressTitle(i + 1),
    body: bodies[i % bodies.length],
    actions,
    expiresAt: NOW + (i - 5) * HOUR,
    status: "pending",
    createdAt: NOW - i * 11 * MINUTE,
    updatedAt: NOW - i * 5 * MINUTE,
    provenance: type === "approval" ? PROVENANCE[i % PROVENANCE.length] : undefined,
    approver: i === 4 ? { userId: memberId(12), name: `member-12 ${unbroken("SharedAccount", 50)}` }
      : i === 9 ? { userId: memberId(3) }
      : i === 14 ? { userId: stressMe.id, name: stressMe.name }
      : undefined,
    oneShot: type === "approval" && i % 3 !== 0 ? true : undefined,
    riskLevel: type === "approval" ? RISKS[i % RISKS.length] : undefined,
    ...overrides,
  };
}

function decisionItem(i: number, overrides: Partial<DecisionGate> = {}): DecisionItem {
  return {
    sessionId: `session-${teamId(i % 30)}`,
    // The item title names the conversation the gate came from.
    title: i % 4 === 0 ? `Thread in ${stressTitle(i + 5)}` : `Workspace ${teamId(i % 30)} · ${stressTitle(i + 2)}`,
    gate: decisionGate(i, overrides),
    canOpenThread: i % 7 === 6 ? false : undefined,
  };
}

export const DECISION_FIRST_PAGE_COUNT = 20;
export const DECISION_NEXT_CURSOR = "cursor-page-2";

/** First page: 20 gates, most pending, one expired and one resolved. */
export const stressDecisionsFirstPage: ListNotificationDecisionsResponse = {
  nextCursor: DECISION_NEXT_CURSOR,
  items: Array.from({ length: DECISION_FIRST_PAGE_COUNT }, (_, i) =>
    decisionItem(i, i === 17 ? { status: "expired", expiresAt: NOW - DAY } : i === 18 ? { status: "resolved" } : {})),
};

/** Second page, behind "Next approvals": expired, resolved, and withdrawn. */
export const stressDecisionsSecondPage: ListNotificationDecisionsResponse = {
  nextCursor: null,
  items: [
    decisionItem(20, { status: "expired", expiresAt: NOW - 3 * DAY }),
    decisionItem(21, { status: "resolved" }),
    decisionItem(22, { status: "withdrawn" }),
    decisionItem(23),
    decisionItem(24, { title: `Second page ${TITLE_400}` }),
  ],
};
