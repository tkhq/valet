import { describe, expect, it } from "vitest";
import { adaptApiRoute, adaptResourceAccess, buildRouteResourceObligationPlan, canonicalAuthorizationJson, composeRouteResourceObligations } from "../src/authorization/index.js";

const common = { schemaVersion: 1 as const, organizationId: "org-1", actorUserId: "user-1", principal: { type: "user" as const, id: "user-1" }, requestId: "request-1", operationId: "delivery-1", evaluationTimeMs: 10 };

describe("canonical route and resource adapters", () => {
  it("projects only registered route metadata", () => {
    const result = adaptApiRoute({ ...common, descriptor: { schemaVersion: 1, service: "api_workflows", actionId: "api_workflows.post_runs", method: "POST", routeTemplate: "/api/workflows/:id/runs", riskLevel: "medium" }, safeMetadata: { ownerType: "team", version: 4 } });
    expect(result.request).toMatchObject({ kind: "api.route", action: { id: "api_workflows.post_runs", parameters: { method: "POST", template: "/api/workflows/:id/runs", metadata: { ownerType: "team", version: 4 } } } });
    expect(result.request.subject.invocation.type).toBe("route");
  });

  it("keeps body, secret, token, URL, and content canaries out", () => {
    const result = adaptResourceAccess({ ...common, descriptor: { schemaVersion: 1, service: "resource_artifact", actionId: "resource_artifact.read", resourceKind: "artifact", operation: "read", riskLevel: "low" }, resource: { id: "artifact-1", ownerType: "team", ownerId: "team-1" }, safeMetadata: { version: 2 } });
    const bytes = canonicalAuthorizationJson(result.request);
    for (const canary of ["BODY-CANARY", "SECRET-CANARY", "TOKEN-CANARY", "https://private.example/path", "CONTENT-CANARY"]) expect(bytes).not.toContain(canary);
    expect(result.request.resource).toEqual({ type: "artifact", id: "artifact-1", ownerType: "team", ownerId: "team-1" });
  });

  it("composes route and resource obligations by the strictest result", () => {
    const decision = (obligations: Parameters<typeof buildRouteResourceObligationPlan>[0]["obligations"]) => ({ effect: "allow" as const, reasonCode: "test", matchedRuleIds: [], obligations, redactions: [] });
    const route = buildRouteResourceObligationPlan(decision([{ type: "result_limit", maximum: 100 }, { type: "field_mask", fields: ["id", "title"] }]));
    const resource = buildRouteResourceObligationPlan(decision([{ type: "result_limit", maximum: 20 }, { type: "field_mask", fields: ["id"] }, { type: "read_only", required: true }]));
    expect(composeRouteResourceObligations(route, resource)).toMatchObject({ resultLimit: 20, fieldMask: ["id"], readOnly: true });
    expect(() => composeRouteResourceObligations(route, buildRouteResourceObligationPlan(decision([{ type: "field_mask", fields: ["owner"] }])))).toThrow();
  });

  it("rejects malformed descriptors and unsafe identities", () => {
    expect(() => adaptApiRoute({ ...common, descriptor: { schemaVersion: 1, service: "api", actionId: "other.read", method: "GET", routeTemplate: "/api/x", riskLevel: "low" } })).toThrow(/invalid_descriptor/);
    expect(() => adaptResourceAccess({ ...common, descriptor: { schemaVersion: 1, service: "resource_secret", actionId: "resource_secret.use", resourceKind: "secret", operation: "use", riskLevel: "high" }, resource: { ownerType: "team" } })).toThrow(/invalid_identity/);
  });
});
