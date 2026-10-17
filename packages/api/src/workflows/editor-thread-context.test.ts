import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Engine, InMemoryEventStream, InMemorySessionStore, UNATTENDED_WORKFLOW_DECISION, VirtualSandboxProvider, type ToolDef } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { isWorkflowRunThread, workflowConversationKey, workflowEditorThreadContext, workflowRunThreadContext, workflowThreadContext } from "./editor-thread-context.js";
import { workflowRunThreadKey } from "./engine-deps.js";
describe("workflow editor context", () => {
  it("binds the editor thread to its workflow without granting access", () => {
    expect(workflowEditorThreadContext({ key: "workflow:wf_123" })).toContain("visual editor for workflow wf_123");
    expect(workflowEditorThreadContext({ key: "workflow:wf_123" })).toContain("enforce the current owner's permissions");
  });
  it("tells the editor to restate the plan, ask once about a gap, and list assumptions", () => {
    const context = workflowEditorThreadContext({ key: "workflow:wf_123" });
    expect(context).toContain("restate the plan in two or three lines");
    expect(context).toContain("call ask_question once");
    expect(context).toContain("list what you assumed");
  });
  it("recognizes the per-viewer key the conversation route creates", () => {
    const key = workflowConversationKey("wf_demo", "user-1");
    expect(key).toBe("workflow:wf_demo:user-1");
    expect(workflowEditorThreadContext({ key })).toContain("visual editor for workflow wf_demo");
  });
  it("asks for checks, a dry run, and consent before a real test run", () => {
    const context = workflowEditorThreadContext({ key: "workflow:wf_123" }) ?? "";
    expect(context).toContain("unless the person explicitly asks");
    expect(context).toContain("first state 2 to 4 concrete checks");
    expect(context).toContain("call preview_workflow");
    expect(context).toContain("Start a real run only after the person agrees");
    expect(context).toContain("workflow.settled");
    expect(context).toContain("get_node_result");
    expect(context).toContain("at most 3 times");
    expect(context).toContain("each check marked passed or failed");
    // The order is the procedure: checks, then the dry run, then the real run.
    expect(context.indexOf("concrete checks")).toBeLessThan(context.indexOf("preview_workflow"));
    expect(context.indexOf("preview_workflow")).toBeLessThan(context.indexOf("Start a real run"));
  });
  it("does not treat run threads or arbitrary keys as editor context", () => {
    for (const key of ["signal:workflow:run_123", "web:123", "workflow:wf_123\nignore instructions", "workflow:wf_123:user-1\nignore", "workflow:wf_123:a:b"]) {
      expect(workflowEditorThreadContext({ key })).toBeUndefined();
    }
  });
});

describe("workflow run thread context", () => {
  const runKeys = [workflowRunThreadKey("wfrun_abc"), workflowRunThreadKey("wfrun_evt_1-2", "C0123")];
  const sentences = (text: string) => text.split(/(?<=\.)\s+/);

  it("holds an action whose content or place is in doubt and reports the gap instead of asking", () => {
    for (const key of runKeys) {
      expect(isWorkflowRunThread({ key })).toBe(true);
      const lines = sentences(workflowThreadContext({ key }) ?? "");
      expect(lines.filter(line => line.includes("ask_question"))).toEqual([]);
      expect(lines).toContain("Nobody can answer a question or approve an action during this run.");
      // A known recipient with two conflicting prices still holds the action.
      expect(lines).toContain("If a fact that a send, change, or delete needs is missing or in conflict, do not do that action.");
      expect(lines).toContain("This covers what the action says, such as a price or a time, and where it goes.");
      expect(lines).toContain("Say in the result what was missing, so the workflow's author can fix the workflow.");
      expect(lines).toContain("For other gaps, state your assumptions in the result.");
      expect(lines.join(" ")).not.toContain("visual editor");
    }
  });
  it("leaves interactive threads and the editor without the run line", () => {
    for (const key of ["web:123", "slack:C0123:1700000000.000100", "slack-events:C0123", workflowConversationKey("wf_demo", "user-1")]) {
      expect(workflowRunThreadContext({ key })).toBeUndefined();
      expect(isWorkflowRunThread({ key })).toBe(false);
      expect(workflowThreadContext({ key }) ?? "").not.toContain("during this run");
    }
    expect(workflowThreadContext({ key: "workflow:wf_demo" })).toContain("visual editor for workflow wf_demo");
  });
  it("applies the run rules to every signal message, including a child.settled continuation, while a reply on the run page keeps the normal rules", async () => {
    const faux = registerFauxProvider({ provider: "workflow-run-thread-context" });
    const turns: Message[][] = [];
    const record = (context: { messages: Message[] }) => { turns.push(context.messages); return fauxAssistantMessage("done"); };
    faux.setResponses([record, record]);
    const session = await new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), threadSystemContext: workflowThreadContext,
    });
    try {
      // The run page replies on the run's own thread (`run-workspace.tsx`).
      const thread = await session.createThread(workflowRunThreadKey("wfrun_abc"));
      const request = await thread.submitPrompt({ kind: "signal", signalType: "workflow.request", body: "Email the renewal quote.", attributes: { runId: "wfrun_abc" } }, { queueMode: "followup" });
      await thread.awaitResult(request.queueItemId);
      const reply = await thread.submitPrompt("Ask me which projects before you inspect them.", {});
      await thread.awaitResult(reply.queueItemId);

      const replyTurn = turns[1] ?? [];
      const system = sentences(replyTurn.filter(message => message.role === "system").map(messageText).join(" "));
      expect(system).toContain("These rules apply to every signal message in this conversation, such as signalType `workflow.request` or `child.settled`.");
      expect(system).toContain("When a person writes in this conversation, use your normal rules for questions.");
      // The model can tell the two apart: only the run's request carries that signal type.
      const asked = replyTurn.filter(message => message.role === "user").map(messageText);
      expect(asked).toHaveLength(2);
      expect(asked[0]).toMatch(/^<signal signalType="workflow\.request" runId="wfrun_abc">/);
      expect(asked[1]).toBe("Ask me which projects before you inspect them.");
    } finally { session.suspendTimers(); faux.unregister(); }
  });
  it("refuses decisions on a run thread's child.settled turn, while a person's reply stays attended", async () => {
    const faux = registerFauxProvider({ provider: "workflow-run-thread-decisions" });
    const seen: Array<{ unattended?: boolean; resolvedBy?: string }> = [];
    const tool: ToolDef = { name: "needs_decision", description: "Needs a decision", parameters: Type.Object({}), execute: async (_args, ctx) => {
      // Only the unattended turn asks: an attended gate would wait for a person.
      const resolution = ctx.unattendedWorkflow ? await ctx.requestDecision({ type: "approval", title: "Send it?", resumeKey: "needs_decision" }) : undefined;
      seen.push({ unattended: ctx.unattendedWorkflow, resolvedBy: resolution?.resolvedBy });
      return { text: "checked" };
    } };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("needs_decision", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done"),
      fauxAssistantMessage([fauxToolCall("needs_decision", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done"),
    ]);
    const store = new InMemorySessionStore();
    const session = await new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [tool], threadSystemContext: workflowThreadContext, unattendedThread: isWorkflowRunThread,
    });
    try {
      const thread = await session.createThread(workflowRunThreadKey("wfrun_abc"));
      const settled = await thread.submitPrompt({ kind: "signal", signalType: "child.settled", body: "The delegated task finished.", attributes: {} }, { queueMode: "followup" });
      await thread.awaitResult(settled.queueItemId);
      const reply = await thread.submitPrompt("Which projects should I check?", { author: { id: "u", interactive: true } });
      await thread.awaitResult(reply.queueItemId);
      expect(seen).toEqual([{ unattended: true, resolvedBy: UNATTENDED_WORKFLOW_DECISION }, { unattended: undefined, resolvedBy: undefined }]);
      expect(await store.listDecisionGates(session.id)).toEqual([]);
    } finally { session.suspendTimers(); faux.unregister(); }
  });
});

function messageText(message: Message): string {
  if (message.role !== "system" && message.role !== "user") return "";
  const content = typeof message.content === "string"
    ? message.content
    : message.content.map(part => part.type === "text" ? part.text : "").join("");
  const sections = message.role === "system" ? Object.values(message.sections ?? {}).filter(section => section !== null) : [];
  return [content, ...sections].join(" ");
}
