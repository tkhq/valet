import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { POLICY_CONTEXTS } from "./builder/contexts.js";
import {
  API_ROUTE_DESCRIPTOR_SEEDS_V1,
  API_ROUTE_REGISTRY_V1,
  RESOURCE_ACCESS_REGISTRY,
  ROUTE_BOUNDARY_EXCLUSIONS_V1,
  WS_OPERATION_DESCRIPTOR_SEEDS_V1,
  buildApiRouteRegistry,
  mergeApiRouteDescriptorMapsV1,
  resolveRouteDescriptor,
} from "./route-resource-policy.js";

function assemblyProviders(withAuthorization = true): never {
  const service = withAuthorization ? { authorize: async () => { throw new Error("not called during assembly"); } } : undefined;
  return new Proxy({ canonicalAuthorizationService: service, resourceAuthorizationPort: service }, {
    get: (target, key) => key in target ? target[key as keyof typeof target]
      : key === "plugins" ? [] : key === "actionPluginByService" ? new Map() : {},
  }) as never;
}

describe("route and resource policy registries", () => {
  it("matches the actual mounted protected route inventory", () => {
    const { app } = createApp(assemblyProviders());
    expect(app.routes.length).toBeGreaterThan(Object.keys(API_ROUTE_DESCRIPTOR_SEEDS_V1).length);
    expect(Object.keys(API_ROUTE_DESCRIPTOR_SEEDS_V1)).toContain("POST /api/workflows/:id/runs");
    expect(ROUTE_BOUNDARY_EXCLUSIONS_V1).toContainEqual(expect.objectContaining({ key: "POST /api/sandbox-secrets/resolve", classification: "pr12_owned" }));
  });

  it("rejects missing and unknown mounted protected routes", () => {
    expect(() => buildApiRouteRegistry([{ method: "GET", path: "/api/private" }])).toThrow(/inventory mismatch/i);
  });

  it("deduplicates identical maps and rejects conflicting descriptors", () => {
    const one = { "GET /api/example": ["api_example", "api_example.get_example", "read", "low"] } as const;
    expect(mergeApiRouteDescriptorMapsV1(one, one)).toEqual(one);
    expect(() => mergeApiRouteDescriptorMapsV1(one, {
      "GET /api/example": ["api_example", "api_example.get_example", "delete", "high"],
    })).toThrow(/conflicting api route descriptor/i);
  });

  it("requires the canonical authorization service during assembly", () => {
    expect(() => createApp(assemblyProviders(false))).toThrow(/canonical authorization service is required/i);
  });

  it("selects the most specific mounted route descriptor", () => {
    const base = { schemaVersion: 1, method: "GET", service: "api_admin", operation: "list", riskLevel: "low", approvalSupported: false, safeProjection: { kind: "unsupported" }, replayStatuses: [], obligations: [], audit: { group: "admin" } } as const;
    const registry = [
      { ...base, template: "/api/admin/*", actionId: "api_admin.get_admin_item" },
      { ...base, template: "/api/admin/submissions", actionId: "api_admin.get_admin_submissions" },
    ];
    expect(resolveRouteDescriptor(registry, "GET", "/api/admin/submissions")?.descriptor.actionId).toBe("api_admin.get_admin_submissions");
    expect(resolveRouteDescriptor(registry, "GET", "/api/admin/other")?.descriptor.actionId).toBe("api_admin.get_admin_item");
  });

  it("keeps builder approval support equal to redeemable runtime support", () => {
    const routeOptions = new Map(POLICY_CONTEXTS["api.route"].targets.map((target) => [target.actionId, target.approvalSupported]));
    expect(routeOptions.size).toBe(API_ROUTE_REGISTRY_V1.length);
    for (const route of API_ROUTE_REGISTRY_V1) {
      expect(routeOptions.get(route.actionId)).toBe(route.approvalSupported);
      expect(route.approvalSupported).toBe(route.safeProjection.kind !== "unsupported");
    }
    expect(POLICY_CONTEXTS["resource.access"].targets).toHaveLength(RESOURCE_ACCESS_REGISTRY.length);
    expect(POLICY_CONTEXTS["resource.access"].targets.every((target) => !target.approvalSupported)).toBe(true);
    expect(new Set(RESOURCE_ACCESS_REGISTRY.map((entry) => entry.resourceKind)).size).toBe(8);
  });

  it("registers explicit WebSocket and enforced resource operations", () => {
    expect(Object.keys(WS_OPERATION_DESCRIPTOR_SEEDS_V1).sort()).toEqual([
      "session.stream.connect", "session.stream.pong", "session.stream.subscribe",
    ]);
    const pairs = new Set(RESOURCE_ACCESS_REGISTRY.map((entry) => `${entry.resourceKind}.${entry.operation}`));
    for (const pair of ["repository.import", "secret.update", "policy.publish", "workflow.execute", "artifact.share"]) expect(pairs.has(pair)).toBe(true);
    for (const unsupported of ["secret.use", "workflow.approve", "session.execute", "assistant.read", "team.approve"]) expect(pairs.has(unsupported)).toBe(false);
    expect(pairs.size).toBe(RESOURCE_ACCESS_REGISTRY.length);
  });
});
