/**
 * The rule that decides whether a tool call in the assistant panel's
 * transcript changed the open workflow. Getting this wrong is expensive in
 * both directions: too loose and the canvas reloads under the user on every
 * lookup, too tight and a real edit stays invisible until a reload.
 */
import { describe, expect, it } from "vitest";
import type { MessagePart } from "@valet/api/wire";
import { definitionWriteCallIds } from "./use-workflow-patch-watch";
import type { StreamMessage } from "~/stores/stream";

/** The engine ships a successful action's `data` as JSON text. */
function successResult(workflowId: string): unknown {
  return { text: JSON.stringify({ workflowId, name: "Nightly digest", nodes: 4, edges: 3 }) };
}

function toolCall(overrides: Partial<Extract<MessagePart, { kind: "tool_call" }>>): MessagePart {
  return {
    kind: "tool_call",
    callId: "call_1",
    toolName: "call_tool",
    status: "completed",
    args: { tool_id: "workflows.patch_workflow", params: { workflow_id: "wf_1" } },
    result: successResult("wf_1"),
    ...overrides,
  };
}

function message(parts: MessagePart[], threadId: string | null = "th_1"): StreamMessage {
  return {
    id: `m_${parts.length}_${threadId ?? "none"}`,
    sessionId: "s_1",
    threadId,
    role: "assistant",
    content: "",
    parts,
    createdAt: 1,
  };
}

describe("definitionWriteCallIds", () => {
  it("reports a completed patch that wrote this workflow", () => {
    const messages = [message([toolCall({})])];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual(["call_1"]);
  });

  it("reports save_workflow as well as patch_workflow", () => {
    const messages = [
      message([
        toolCall({
          callId: "call_save",
          args: { tool_id: "workflows.save_workflow", params: { workflow_id: "wf_1" } },
        }),
      ]),
    ];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual(["call_save"]);
  });

  it("ignores reads, which return the same workflowId as a write", () => {
    const messages = [
      message([
        toolCall({
          args: { tool_id: "workflows.get_workflow", params: { workflow_id: "wf_1" } },
        }),
      ]),
    ];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("ignores a patch the linter rejected — the failure text is not JSON, so nothing was written", () => {
    const rejected = {
      text: "workflow definition failed validation (fix these and retry):\n- unknown edge target: b",
    };
    const messages = [message([toolCall({ result: rejected })])];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("ignores a patch aimed at a different workflow", () => {
    const messages = [message([toolCall({ result: successResult("wf_other") })])];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("ignores a call that has not finished yet", () => {
    const messages = [message([toolCall({ status: "running", result: undefined })])];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("ignores writes made in another thread of the same session", () => {
    const messages = [message([toolCall({})], "th_other")];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("ignores non-workflow tools", () => {
    const messages = [
      message([
        toolCall({ args: { tool_id: "slack.send_message", params: { workflow_id: "wf_1" } } }),
      ]),
    ];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual([]);
  });

  it("returns every write in order, so a second patch is seen as new", () => {
    const messages = [
      message([toolCall({ callId: "call_1" })]),
      message([toolCall({ callId: "call_2" })]),
    ];
    expect(definitionWriteCallIds(messages, "th_1", "wf_1")).toEqual(["call_1", "call_2"]);
  });

  it("is empty before any messages arrive", () => {
    expect(definitionWriteCallIds(undefined, "th_1", "wf_1")).toEqual([]);
  });
});
