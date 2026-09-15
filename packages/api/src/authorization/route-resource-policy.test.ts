import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  API_ROUTE_DESCRIPTOR_SEEDS_V1,
  RESOURCE_ACCESS_REGISTRY,
  ROUTE_BOUNDARY_EXCLUSIONS_V1,
  WS_OPERATION_DESCRIPTOR_SEEDS_V1,
  buildApiRouteRegistry,
  mergeApiRouteDescriptorMapsV1,
} from "./route-resource-policy.js";

function assemblyProviders(withAuthorization = true): never {
  const service = withAuthorization ? { authorize: async () => { throw new Error("not called during assembly"); } } : undefined;
  return new Proxy({ canonicalAuthorizationService: service }, {
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

  it("registers explicit WebSocket and resource operations", () => {
    expect(Object.keys(WS_OPERATION_DESCRIPTOR_SEEDS_V1).sort()).toEqual([
      "session.stream.connect", "session.stream.pong", "session.stream.subscribe",
    ]);
    const pairs = new Set(RESOURCE_ACCESS_REGISTRY.map((entry) => `${entry.resourceKind}.${entry.operation}`));
    for (const pair of ["repository.import", "secret.use", "policy.publish", "workflow.approve", "artifact.share", "session.execute", "assistant.update", "team.approve"]) expect(pairs.has(pair)).toBe(true);
    expect(pairs.size).toBe(RESOURCE_ACCESS_REGISTRY.length);
  });
});
