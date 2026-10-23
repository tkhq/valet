import { describe, expect, it } from "vitest";
import { actionInScope, toolInScope } from "@valet/shared";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "@valet/engine/test-helpers";
import { Engine, InMemoryEventStream, InMemorySessionStore, pluginCatalogTools, VirtualSandboxProvider, type ActionPlugin } from "@valet/engine";
import { workflowToolFocus } from "./tool-focus.js";

describe("workflow tool focus", () => {
  it.each(["diagnose", "repair", "validate"] as const)("delivers source-bound replies and previews in %s without permitting unrelated posts", async (phase) => {
    const faux = registerFauxProvider({ provider: `workflow-focus-delivery-${phase}` });
    try {
      const calls: string[] = [];
      const plugin = (service: string, names: string[]): ActionPlugin => ({ service, actions: names.map((name) => ({
        id: `${service}.${name}`, name, description: name, riskLevel: "low", parameters: Type.Object({}),
        execute: async () => { calls.push(`${service}.${name}`); return { success: true, data: { delivered: name } }; },
      })) });
      const tools = pluginCatalogTools({ plugins: [
        plugin("slack", ["reply_to_origin", "react_to_origin", "reply_file_to_origin", "send_message"]),
        plugin("telegram", ["reply_to_origin"]),
        plugin("workflows", ["preview_workflow", "propose_schedule", "propose_trigger"]),
      ], pins: [{ actionId: "slack.reply_to_origin" }] });
      const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({ userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], tools, initialToolFocus: () => workflowToolFocus(phase) });
      const call = (tool_id: string) => fauxToolCall("call_tool", { tool_id, params: {}, summary: "Scope regression" });
      const attempts = [fauxToolCall("slack__reply_to_origin", {}), call("slack.react_to_origin"), call("slack.reply_file_to_origin"), call("telegram.reply_to_origin"), call("slack.send_message"), call("workflows.preview_workflow")];
      if (phase === "repair") attempts.push(call("workflows.propose_schedule"), call("workflows.propose_trigger"));
      faux.setResponses([fauxAssistantMessage(attempts, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      const receipt = await session.prompt("Report the result and prepare the workflow");
      await session.thread().awaitResult(receipt.queueItemId);
      expect(calls).toEqual(expect.arrayContaining(["slack.reply_to_origin", "slack.react_to_origin", "slack.reply_file_to_origin", "telegram.reply_to_origin", "workflows.preview_workflow"]));
      if (phase === "repair") expect(calls).toEqual(expect.arrayContaining(["workflows.propose_schedule", "workflows.propose_trigger"]));
      expect(calls).not.toContain("slack.send_message");
      // Source replies remain subject to an inherited ceiling.
      session.options.toolScope = { actions: ["workflows.preview_workflow"] };
      calls.length = 0;
      faux.setResponses([fauxAssistantMessage([fauxToolCall("slack__reply_to_origin", {}), call("telegram.reply_to_origin"), call("workflows.preview_workflow")], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      const limited = await session.prompt("Inspect without sending a reply");
      await session.thread().awaitResult(limited.queueItemId);
      expect(calls).toEqual(["workflows.preview_workflow"]);
    } finally { faux.unregister(); }
  });

  it("lets diagnosis inspect evidence without editing or executing integrations", () => {
    const scope = workflowToolFocus("diagnose");
    expect(actionInScope(scope, "workflows.get_node_diagnostics")).toBe(true);
    expect(actionInScope(scope, "workflows.patch_workflow")).toBe(false);
    expect(actionInScope(scope, "slack.post_message")).toBe(false);
    expect(toolInScope(scope, "bash")).toBe(false);
    expect(toolInScope(scope, "update_plan")).toBe(true);
  });
  it("adds editing and preview for repair without starting runs", () => {
    const scope = workflowToolFocus("repair");
    expect(actionInScope(scope, "workflows.patch_workflow")).toBe(true);
    expect(actionInScope(scope, "workflows.preview_workflow")).toBe(true);
    expect(actionInScope(scope, "workflows.validate_definition")).toBe(true);
    expect(actionInScope(scope, "workflows.start_run")).toBe(false);
  });
  it("limits validation to named integration actions and run controls", () => {
    const scope = workflowToolFocus("validate", ["slack.search_messages"]);
    expect(actionInScope(scope, "workflows.start_run")).toBe(true);
    expect(actionInScope(scope, "slack.search_messages")).toBe(true);
    expect(actionInScope(scope, "slack.post_message")).toBe(false);
    expect(actionInScope(scope, "workflows.patch_workflow")).toBe(false);
  });
});
