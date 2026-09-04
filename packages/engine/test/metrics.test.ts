import { describe, expect, it, vi } from "vitest";

const metricState = vi.hoisted(() => ({
  descriptions: new Map<string, string>(),
  points: [] as Array<{ name: string; value: number; attributes?: Record<string, unknown> }>,
}));

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => ({
      createCounter: (name: string, options?: { description?: string }) => {
        if (options?.description) metricState.descriptions.set(name, options.description);
        return {
          add: (value: number, attributes?: Record<string, unknown>) => {
            metricState.points.push({ name, value, attributes });
          },
        };
      },
      createHistogram: () => ({ record: () => {} }),
    }),
  },
}));

import { recordSandboxWorkspaceGrow } from "../src/metrics.js";

describe("workspace grow metrics", () => {
  it("uses pending for a requested resize that has not landed", () => {
    recordSandboxWorkspaceGrow("pending");

    expect(metricState.descriptions.get("valet.sandbox.workspace_grow")).toContain(
      "grown/refused/pending/error",
    );
    expect(metricState.points).toContainEqual({
      name: "valet.sandbox.workspace_grow",
      value: 1,
      attributes: { outcome: "pending" },
    });
  });
});
