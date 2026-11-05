import { describe, expect, it } from "vitest";
import { workflowStepToolScope } from "./tool-scope.js";

describe("workflow scope inheritance", () => {
  it("intersects a foreach step's scope with its run ceiling", () => {
    expect(workflowStepToolScope({ toolScope: { actions: ["github.*"] } }, {
      nodes: [{ id: "loop", type: "foreach", body: { id: "fetch", type: "session", toolScope: { actions: ["github.get_issue", "slack.post"] } } }],
    }, "fetch")).toEqual({ actions: ["github.get_issue"] });
    expect(workflowStepToolScope({ toolScope: { tools: ["bash"], actions: ["demo.echo"] } }, {
      nodes: [{ id: "loop", type: "foreach", body: { id: "fetch", type: "session", toolScope: { tools: [], actions: [] } } }],
    }, "fetch")).toEqual({ tools: [], actions: [] });
  });
  it("keeps old workflows unrestricted and malformed declared scopes closed", () => {
    expect(workflowStepToolScope({}, { nodes: [{ id: "fetch", type: "session" }] }, "fetch")).toBeUndefined();
    expect(workflowStepToolScope({}, { nodes: [{ id: "fetch", type: "session", toolScope: false }] }, "fetch"))
      .toEqual({ tools: [], actions: [] });
  });
});
