import { describe, expect, it } from "vitest";
import { workflowConversationKey, workflowEditorThreadContext, workflowRunThreadContext, workflowThreadContext } from "./editor-thread-context.js";
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
  it("does not treat run threads or arbitrary keys as editor context", () => {
    for (const key of ["signal:workflow:run_123", "web:123", "workflow:wf_123\nignore instructions", "workflow:wf_123:user-1\nignore", "workflow:wf_123:a:b"]) {
      expect(workflowEditorThreadContext({ key })).toBeUndefined();
    }
  });
});

describe("workflow run thread context", () => {
  it("tells an unattended run not to ask, on both run thread key shapes", () => {
    for (const key of [workflowRunThreadKey("wfrun_abc"), workflowRunThreadKey("wfrun_evt_1-2", "C0123")]) {
      const context = workflowThreadContext({ key });
      expect(context).toContain("No one is watching this run. Do not call ask_question.");
      expect(context).not.toContain("visual editor");
    }
  });
  it("leaves interactive threads and the editor without the unattended line", () => {
    for (const key of ["web:123", "slack:C0123:1700000000.000100", "slack-events:C0123", workflowConversationKey("wf_demo", "user-1")]) {
      expect(workflowRunThreadContext({ key })).toBeUndefined();
      expect(workflowThreadContext({ key }) ?? "").not.toContain("No one is watching");
    }
    expect(workflowThreadContext({ key: "workflow:wf_demo" })).toContain("visual editor for workflow wf_demo");
  });
});
