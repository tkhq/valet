/** One thread's transcript with running gate tool calls, and the decision
 * gates that the thread view shows below it. */
import type { DecisionGate, Message } from "@valet/api/wire";
import {
  EMOJI, HEX_300, LONG_ACTION, LONG_SERVICE, MINUTE, NOW, RTL_ARABIC, STRING_2000, TITLE_400, URL_300,
  deepJson, memberId, stressMe,
} from "./common";
import { QUESTION_OPTIONS, TOOL_APPROVAL_ACTIONS, decisionGate } from "./approvals";

export const THREAD_SESSION_ID = "session-thread-stress";
export const THREAD_ID = "thread-stress";

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

/** The gates under the transcript: a tool approval with Always allow, an
 * ask_question gate with eight long options, a credential request, and a
 * shared-account gate that waits on another member. */
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
