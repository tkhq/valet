import type { Attributes } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { recordBakeHealth } from "./metrics.js";

type Health = Parameters<typeof recordBakeHealth>[1];
const recorded = vi.hoisted(() => ({
  points: [] as Array<{ name: string; value: number; attributes?: Attributes }>,
}));

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: vi.fn(() => ({
      createGauge: vi.fn((name: string) => ({
        record: vi.fn((value: number, attributes?: Attributes) => {
          recorded.points.push({ name, value, attributes });
        }),
      })),
    })),
  },
}));

function healthy(): Health {
  return {
    checkedAt: 1000,
    cache: {
      bytesUsed: 2e9, cacheBudgetGb: 6, budgetBytes: 6e9,
      unknownSizeCount: 0, overBudget: false, over_budget_all_protected: false,
    },
    registry: {
      status: "healthy", capacityBytes: 20e9, usedBytes: 2e9,
      availableBytes: 18e9, reserveBytes: 5e9,
    },
    canAcceptBakes: true,
    recentPushFailures: { count: 0, windowMs: 3_600_000 },
  };
}

function points(name: string) {
  return recorded.points.filter((point) => point.name === name)
    .map(({ value, attributes }) => ({ value, attributes }));
}

beforeEach(() => {
  recorded.points.length = 0;
  vi.resetModules();
});

describe("bake health metrics", () => {
  it("records pressure and clears alert gauges after recovery", async () => {
    const { recordBakeHealth } = await import("./metrics.js");
    const initial = healthy();
    recordBakeHealth("org-a", initial);
    recordBakeHealth("org-a", {
      ...initial,
      cache: { ...initial.cache, bytesUsed: 8e9, overBudget: true, over_budget_all_protected: true },
      registry: { ...initial.registry, status: "full", usedBytes: 18e9, availableBytes: 2e9 },
      canAcceptBakes: false,
      recentPushFailures: { ...initial.recentPushFailures, count: 3 },
    });
    recordBakeHealth("org-a", initial);

    const orgPoints = (values: number[]) => values.map((value) => ({ value, attributes: { orgId: "org-a" } }));
    const globalPoints = (values: number[]) => values.map((value) => ({ value, attributes: undefined }));
    expect(points("valet.bake.cache.bytes")).toEqual(orgPoints([2e9, 8e9, 2e9]));
    expect(points("valet.bake.cache.budget.bytes")).toEqual(orgPoints([6e9, 6e9, 6e9]));
    expect(points("valet.bake.cache.over_budget_all_protected")).toEqual(orgPoints([0, 1, 0]));
    expect(points("valet.bake.push_failures.recent")).toEqual(orgPoints([0, 3, 0]));
    expect(points("valet.registry.full")).toEqual(globalPoints([0, 1, 0]));
    expect(points("valet.registry.capacity_unknown")).toEqual(globalPoints([0, 0, 0]));
    expect(points("valet.registry.capacity.bytes")).toEqual(globalPoints([20e9, 20e9, 20e9]));
    expect(points("valet.registry.available.bytes")).toEqual(globalPoints([18e9, 2e9, 18e9]));
    expect(points("valet.registry.reserve.bytes")).toEqual(globalPoints([5e9, 5e9, 5e9]));
  });

  it("reports unknown capacity without recording missing bytes as zero", async () => {
    const { recordBakeHealth } = await import("./metrics.js");
    for (const status of ["unknown", "unconfigured"] as const) {
      recordBakeHealth("org-a", {
        ...healthy(),
        registry: { status, capacityBytes: null, usedBytes: null, availableBytes: null, reserveBytes: null },
      });
    }
    recordBakeHealth("org-a", healthy());
    expect(points("valet.registry.capacity_unknown").map((point) => point.value)).toEqual([1, 1, 0]);
    expect(points("valet.registry.capacity.bytes").map((point) => point.value)).toEqual([20e9]);
    expect(points("valet.registry.available.bytes").map((point) => point.value)).toEqual([18e9]);
    expect(points("valet.registry.reserve.bytes").map((point) => point.value)).toEqual([5e9]);
  });

  it("labels logical cache and recent failures by organization", async () => {
    const { recordBakeHealth } = await import("./metrics.js");
    recordBakeHealth("org-a", healthy());
    recordBakeHealth("org-b", {
      ...healthy(), recentPushFailures: { count: 7, windowMs: 3_600_000 },
    });
    expect(points("valet.bake.push_failures.recent")).toEqual([
      { value: 0, attributes: { orgId: "org-a" } },
      { value: 7, attributes: { orgId: "org-b" } },
    ]);
    expect(points("valet.bake.cache.bytes").map((point) => point.attributes)).toEqual([
      { orgId: "org-a" }, { orgId: "org-b" },
    ]);
  });
});
