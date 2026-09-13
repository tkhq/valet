import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { adaptWorkflowInvocation } from "./action-invoker-authorization.js";

const action = { id: "create_issue", name: "Create", description: "Create issue", riskLevel: "high" as const, parameters: Type.Object({ title: Type.String() }), execute: async () => ({ success: true }) };

describe("workflow action authorization fixture bridge", () => {
  it("uses the current request, principal, action, and qualified id shapes", () => {
    const out = adaptWorkflowInvocation({ request: { service: "github", action: "create_issue", params: { title: "safe" }, invocationId: "invocation-1" }, context: { userId: "user-1", orgId: "org-1", owner: { type: "team", id: "team-1" }, workflowExecutionId: "execution-1" }, action, projection: { schemaVersion: 1, mode: "all_safe" }, workflowDefinitionId: "workflow-1", workflowVersion: "version-1", nodeId: "node-1", requestId: "request-1", evaluationTimeMs: 10, dynamicFacts: {} });
    expect(out.request).toMatchObject({ kind: "workflow.action", action: { id: "github.create_issue", service: "github", parameters: { title: "safe" } }, subject: { principal: { type: "team", id: "team-1" }, workflowExecutionId: "execution-1" }, context: { appliesIn: "workflow" } });
  });

  it("rejects a missing execution identity", () => {
    expect(() => adaptWorkflowInvocation({ request: { service: "github", action: "create_issue", params: {}, invocationId: "invocation-1" }, context: { userId: "user-1", orgId: "org-1", owner: { type: "user", id: "user-1" } }, action, projection: { schemaVersion: 1, mode: "none" }, workflowDefinitionId: "workflow-1", workflowVersion: "version-1", nodeId: "node-1", requestId: "request-1", evaluationTimeMs: 10, dynamicFacts: {} })).toThrowError(expect.objectContaining({ code: "invalid_identity" }));
  });
});
