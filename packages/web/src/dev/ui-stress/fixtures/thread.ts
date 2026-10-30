/** One thread's transcript with running gate tool calls, and the decision
 * gates that the thread view shows below it. */
import type { DecisionGate, Message, ThreadPlan } from "@valet/api/wire";
import { THREAD_PLAN_MAX_ITEMS, THREAD_PLAN_MAX_TEXT } from "@valet/shared";
import {
  EMOJI, HEX_300, LONG_ACTION, LONG_SERVICE, MINUTE, NOW, RTL_ARABIC, STRING_2000, TITLE_400, URL_300,
  deepJson, memberId, stressMe, unbroken,
} from "./common";
import { QUESTION_OPTIONS, TOOL_APPROVAL_ACTIONS, decisionGate } from "./approvals";
import { meetingMemoryWidget } from "./widgets";

export const THREAD_SESSION_ID = "session-thread-stress";
export const THREAD_ID = "thread-stress";

/** The largest plan `update_plan` accepts: every item at the length limit,
 * and the current item an unbroken hash. */
export const stressThreadPlan: ThreadPlan = {
  items: Array.from({ length: THREAD_PLAN_MAX_ITEMS }, (_, i) => ({
    text: i === 7 ? HEX_300.slice(0, THREAD_PLAN_MAX_TEXT) : TITLE_400.slice(0, THREAD_PLAN_MAX_TEXT).trimEnd(),
    status: i < 7 ? "done" : i === 7 ? "in_progress" : "pending",
  })),
  updatedAt: NOW,
};

function message(i: number, fields: Pick<Message, "role" | "content" | "parts"> & Partial<Message>): Message {
  return {
    id: `message-${i}`,
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    createdAt: NOW - (20 - i) * MINUTE,
    completed: true,
    stopReason: "end_turn",
    ...fields,
  };
}

/** A finished turn as the engine writes it: one message per agent step,
 * most of them tool calls only, so the transcript folds them into one work
 * line. It has reasoning, plugin calls with the agent's own purpose line,
 * an agent it started and messaged, a failed push, and a reply. */
function turnMessage(i: number, fields: Pick<Message, "role" | "content" | "parts"> & Partial<Message>): Message {
  return { ...message(i, fields), id: `turn-${i}`, createdAt: NOW - (40 - i) * MINUTE };
}
const done = "completed" as const;

/** Two columns: short titles, then long prose. The prose column should take
 * most of the width and wrap, with no side scroll. */
const PROSE_TABLE = [
  "| Key result | What we have |",
  "| --- | --- |",
  "| KR1: Complete the revenue, cost and staffing baseline by October 9 | Your figures show about $24K each month in known maintenance costs and about $31K in recurring revenue, but two contracts have no end date yet, so the baseline is still open. |",
  "| KR2: Sign $30K of new committed contract value by October 31 | You confirmed one new signed deal at $22K total value. Two more proposals are out, and neither has a decision date. |",
  "| KR3: Establish a credible path to $50K each month starting January | You expect the two largest clients to continue at least until January. Renewal terms after that are not agreed. |",
  "| KR4: Allocate every new engagement without overbooking | One client takes full-time capacity and another takes 30 hours each week, which leaves about 10 hours for new work. |",
].join("\n");

/** Six columns, one an unbroken commit hash in code. Some side scroll is
 * expected at phone width, never past the table's own box. */
const WIDE_TABLE = [
  "| PR | Title | Author | Status | Commit | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  `| #1102 | Follow Slack threads after a reply | member-1 | Ready | \`${HEX_300.slice(0, 40)}\` | Needs one more review before it can land on the base branch. |`,
  `| #1109 | Code review research notes | member-2 | Draft | \`${HEX_300.slice(40, 80)}\` | Waiting on the benchmark run. |`,
  `| #1110 | Tool parity spec | member-3 | Changes requested | \`${HEX_300.slice(80, 120)}\` | Two comments open about the approval card copy and one about naming. |`,
].join("\n");

export const workTurnMessages: Message[] = [
  turnMessage(0, { role: "user", content: "What did Teammate say about pricing, and is the retry fix ready?", parts: [], author: { id: stressMe.id, name: stressMe.name } }),
  turnMessage(1, { role: "assistant", content: "", parts: [
    { kind: "thinking", text: "", startedAt: NOW - 39 * MINUTE, durationMs: 2400 },
    { kind: "tool_call", callId: "turn-ff", toolName: "call_tool", status: done, args: { tool_id: "fireflies.fireflies_search", summary: "Find last week's pricing calls", params: { query: "pricing" } }, result: { text: "2 meetings" } },
  ] }),
  turnMessage(2, { role: "assistant", content: "", parts: [
    { kind: "tool_call", callId: "turn-gh", toolName: "call_tool", status: done, args: { tool_id: "github.read_repo_file", summary: "Read the retry tests", params: { path: "packages/engine/test/transient-turn-retry.test.ts" } }, result: { text: "describe(\"retry\")" } },
    { kind: "tool_call", callId: "turn-notion", toolName: "call_tool", status: done, args: { tool_id: "notion.notion-fetch", params: { id: "pricing-page" } }, result: { text: "# Pricing" } },
  ] }),
  turnMessage(3, { role: "assistant", content: "", parts: [
    { kind: "tool_call", callId: "turn-test", toolName: "bash", status: done, args: { command: "pnpm --filter @valet/engine test retry" }, result: { text: "41 passed" } },
    { kind: "tool_call", callId: "turn-task", toolName: "task", status: done, args: { title: "Review retry coverage", prompt: "Review the retry tests." }, result: { text: "Started." } },
    { kind: "tool_call", callId: "turn-send", toolName: "child_send", status: done, args: { child_session_id: "child-review", message: "Focus on the cooldown." }, result: { text: "Sent." } },
  ] }),
  turnMessage(4, { role: "assistant", content: "", parts: [
    { kind: "tool_call", callId: "turn-push", toolName: "bash", status: "error", args: { command: "git push origin fix/provider-retry-hints" }, error: "remote: Permission to tkhq/valet.git denied (403)" },
  ] }),
  turnMessage(6, { role: "assistant", content: "", parts: [
    { kind: "tool_call", callId: "turn-widget", toolName: "show_widget", status: done, args: { title: "Meeting memory", spec: meetingMemoryWidget }, result: { text: "The card is in the thread." } },
  ] }),
  turnMessage(7, { role: "assistant", content: "", parts: [
    { kind: "text", text: "Teammate wants the starter plan generous and paid tiers to win on collaboration. The retry fix passes its tests, but the push failed: I don't have write access to the branch." },
  ] }),
  turnMessage(8, { role: "assistant", content: "", parts: [
    { kind: "text", text: `Here is where each goal stands.\n\n${PROSE_TABLE}\n\nAnd the open pull requests:\n\n${WIDE_TABLE}` },
  ] }),
];

export const stressThreadMessages: Message[] = [
  message(0, {
    role: "user",
    content: `Check ${URL_300} and the hash ${HEX_300}, then ask me before you deploy. ${EMOJI} ${RTL_ARABIC}`,
    parts: [],
    author: { id: stressMe.id, name: stressMe.name },
  }),
  message(1, {
    role: "assistant",
    content: "",
    completed: false,
    stopReason: undefined,
    parts: [
      { kind: "thinking", text: STRING_2000 },
      { kind: "text", text: `I found ${HEX_300}. ${TITLE_400}` },
      {
        kind: "tool_call", callId: "call-question", toolName: "ask_question", status: "running",
        args: { question: TITLE_400, detail: STRING_2000, options: QUESTION_OPTIONS.map((option) => option.label) },
      },
      {
        kind: "tool_call", callId: "call-approval", toolName: "call_tool", status: "running",
        args: { tool_id: `${LONG_SERVICE}.${LONG_ACTION}`, params: deepJson(8) },
      },
      {
        kind: "tool_call", callId: "call-failed", toolName: "call_tool", status: "error",
        args: { tool_id: "github.create_pull_request", params: { title: TITLE_400, body: STRING_2000 } },
        error: `403 from ${URL_300}: ${STRING_2000.slice(0, 500)}`,
      },
    ],
  }),
];

/** A Slack post with a long channel id and message, as the engine writes it. */
const SLACK_ARGS = {
  channel: `C${unbroken("0123456789ABCDEF", 120)}`,
  text: `**Release notes** for ${URL_300}\n\n${STRING_2000}\n\n${EMOJI} ${RTL_ARABIC}`,
  thread_ts: "1780887543.189519",
};

/** The gates under the transcript: a tool approval with Always allow, an
 * ask_question gate with eight long options, a credential request, a Slack
 * post with a payload preview, and a shared-account gate that waits on
 * another member. */
export const stressThreadGates: DecisionGate[] = [
  decisionGate(1, {
    id: "thread-gate-approval",
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    type: "approval",
    title: `Run ${LONG_SERVICE}.${LONG_ACTION}? ${TITLE_400}`,
    body: JSON.stringify({ tool: `${LONG_SERVICE}.${LONG_ACTION}`, params: deepJson(8) }, null, 2),
    actions: TOOL_APPROVAL_ACTIONS,
    provenance: { baseMode: "require_approval", source: "org_policy", matchedPolicyId: `policy-${HEX_300.slice(0, 40)}` },
    riskLevel: "high",
    oneShot: true,
    approver: undefined,
  }),
  decisionGate(2, {
    id: "thread-gate-question",
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    type: "question",
    title: TITLE_400,
    body: STRING_2000,
    actions: QUESTION_OPTIONS,
    provenance: undefined,
    approver: undefined,
  }),
  decisionGate(4, {
    id: "thread-gate-credential",
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    type: "credential_request",
    title: `Connect ${LONG_SERVICE} to continue`,
    body: `Valet needs an account for ${URL_300}.`,
    actions: [{ id: "provide", label: `Connect ${LONG_SERVICE}`, style: "primary" }, { id: "deny", label: "Skip" }],
    approver: undefined,
  }),
  decisionGate(5, {
    id: "thread-gate-slack-preview",
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    type: "approval",
    title: "Approve Send Message?",
    body: `Post the release notes ${TITLE_400}\n\ntool_id=slack.send_message\nargs=${JSON.stringify(SLACK_ARGS, null, 2)}`,
    tool: { id: "slack.send_message", args: SLACK_ARGS },
    actions: TOOL_APPROVAL_ACTIONS,
    riskLevel: "high",
    oneShot: true,
    approver: undefined,
  }),
  decisionGate(3, {
    id: "thread-gate-shared",
    sessionId: THREAD_SESSION_ID,
    threadId: THREAD_ID,
    type: "approval",
    title: "Use the shared deploy account",
    actions: TOOL_APPROVAL_ACTIONS,
    approver: { userId: memberId(11), name: `member-11 ${EMOJI} ${TITLE_400.slice(0, 120)}` },
  }),
];
