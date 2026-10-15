import { describe, expect, it } from "vitest";
import { actionInScope, toolInScope } from "@valet/shared";
import { workflowToolFocus } from "./tool-focus.js";

describe("workflow tool focus", () => {
  it("lets diagnosis inspect evidence without editing or executing integrations", () => {
    const scope = workflowToolFocus("diagnose");
    expect(actionInScope(scope, "workflows.get_node_diagnostics")).toBe(true);
    expect(actionInScope(scope, "workflows.patch_workflow")).toBe(false);
    expect(actionInScope(scope, "slack.post_message")).toBe(false);
    expect(toolInScope(scope, "bash")).toBe(false);
  });
  it("adds editing and preview for repair without starting runs", () => {
    const scope = workflowToolFocus("repair");
    expect(actionInScope(scope, "workflows.patch_workflow")).toBe(true);
    expect(actionInScope(scope, "workflows.preview_workflow")).toBe(true);
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
