import { describe, expect, it } from "vitest";
import { detectNewModels, modelDiscoveryKey } from "../src/model-registry.js";

describe("detectNewModels", () => {
  it("returns only unknown upstream models without changing existing records", () => {
    const bundled = new Set([modelDiscoveryKey("anthropic", "existing")]);
    const discovered = new Set([modelDiscoveryKey("anthropic", "reviewed")]);
    const upstream = [
      { providerId: "anthropic", modelId: "existing", metadata: { name: "Existing" } },
      { providerId: "anthropic", modelId: "reviewed", metadata: { name: "Reviewed" } },
      { providerId: "anthropic", modelId: "new", metadata: { name: "New" } },
    ];

    expect(detectNewModels(upstream, bundled, discovered, 123)).toEqual([
      { providerId: "anthropic", modelId: "new", metadata: { name: "New" }, discoveredAt: 123 },
    ]);
    expect(upstream).toHaveLength(3);
  });
});
