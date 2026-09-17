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

import {
  recordCompactionCoverageGap,
  recordCompactionHeadUnread,
  recordSandboxWorkspaceGrow,
} from "../src/metrics.js";

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

describe("compaction coverage metrics", () => {
  it("counts a pass that could not cover its head at all, by mode", () => {
    recordCompactionCoverageGap("reactive");

    expect(metricState.descriptions.get("valet.compaction.coverage_gap")).toContain(
      "invariant violation",
    );
    expect(metricState.points).toContainEqual({
      name: "valet.compaction.coverage_gap",
      value: 1,
      attributes: { mode: "reactive" },
    });
  });

  it("counts the head entries a written checkpoint covered but left unread", () => {
    recordCompactionHeadUnread("proactive", 7);

    expect(metricState.descriptions.get("valet.compaction.head_entries_unread")).toContain(
      "do not ignore",
    );
    expect(metricState.points).toContainEqual({
      name: "valet.compaction.head_entries_unread",
      value: 7,
      attributes: { mode: "proactive" },
    });
  });
});
