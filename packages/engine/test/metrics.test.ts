import { describe, expect, it, vi } from "vitest";

interface ObservableResultLike {
  observe(value: number, attributes?: Record<string, unknown>): void;
}

const metricState = vi.hoisted(() => ({
  descriptions: new Map<string, string>(),
  points: [] as Array<{ name: string; value: number; attributes?: Record<string, unknown> }>,
  gaugeCallbacks: [] as Array<{
    name: string;
    callback: (result: { observe(value: number, attributes?: Record<string, unknown>): void }) => void;
  }>,
  // Fires every registered observable-gauge callback and records what it
  // observes. The mocked meter has no real collection cycle, so tests call
  // this after a record* to see the gauge's current last-set value.
  collect(): void {
    for (const { name, callback } of metricState.gaugeCallbacks) {
      callback({
        observe: (value: number, attributes?: Record<string, unknown>) => {
          metricState.points.push({ name, value, attributes });
        },
      });
    }
  },
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
      createObservableGauge: (name: string, options?: { description?: string }) => {
        if (options?.description) metricState.descriptions.set(name, options.description);
        return {
          addCallback: (callback: (result: ObservableResultLike) => void) => {
            metricState.gaugeCallbacks.push({ name, callback });
          },
        };
      },
    }),
  },
}));

import {
  recordChildSettleOverDeadline,
  recordCompactionCoverageGap,
  recordLeaseOrphanReleased,
  recordWakeupBadRow,
  recordDockerJobOutputDropped,
  recordJobLogsPruned,
  recordWakeupSweepFailed,
  recordWakeupSweepOk,
  recordLeaseNodeSeconds,
  recordLeasesActive,
  recordLeasesOverDeadline,
  recordLeasesUnannotated,
  recordSandboxWorkspaceGrow,
  recordScratchRefused,
  recordScratchRequested,
  recordWakeupEnded,
  recordWakeupsActive,
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
});

describe("wakeup metrics", () => {
  it("counts a wakeup that ended, by kind and cause", () => {
    recordWakeupEnded("process", "exit");

    expect(metricState.points).toContainEqual({
      name: "valet.wakeups.total",
      value: 1,
      attributes: { kind: "process", cause: "exit" },
    });
  });

  it("reports the active wakeup gauge by kind", () => {
    recordWakeupsActive("watch", 3);
    metricState.collect();

    expect(metricState.points).toContainEqual({
      name: "valet.wakeups.active",
      value: 3,
      attributes: { kind: "watch" },
    });
  });

  it("reports two kinds as independent label sets on the same gauge", () => {
    recordWakeupsActive("process", 2);
    recordWakeupsActive("timer", 5);

    const before = metricState.points.length;
    metricState.collect();
    const added = metricState.points.slice(before);

    expect(added).toContainEqual({
      name: "valet.wakeups.active",
      value: 2,
      attributes: { kind: "process" },
    });
    expect(added).toContainEqual({
      name: "valet.wakeups.active",
      value: 5,
      attributes: { kind: "timer" },
    });
  });
});

describe("lease metrics", () => {
  it("reports the active lease gauge by owner kind", () => {
    recordLeasesActive("hold", 2);
    metricState.collect();

    expect(metricState.points).toContainEqual({
      name: "valet.leases.active",
      value: 2,
      attributes: { owner_kind: "hold" },
    });
  });

  it("keeps only the last-set value for a given label set", () => {
    recordLeasesActive("hold", 3);
    recordLeasesActive("hold", 1);

    const before = metricState.points.length;
    metricState.collect();
    const added = metricState.points.slice(before);
    const holdPoints = added.filter(
      (point) => point.name === "valet.leases.active" && point.attributes?.owner_kind === "hold",
    );

    expect(holdPoints).toEqual([
      { name: "valet.leases.active", value: 1, attributes: { owner_kind: "hold" } },
    ]);
  });

  it("counts node-seconds consumed by a lease, by owner kind", () => {
    recordLeaseNodeSeconds("process", 45);

    expect(metricState.points).toContainEqual({
      name: "valet.leases.node_seconds",
      value: 45,
      attributes: { owner_kind: "process" },
    });
  });

  it("flags a lease still active past its deadline, the WakeWatcher alert signal", () => {
    recordLeasesOverDeadline(1);
    metricState.collect();

    expect(metricState.descriptions.get("valet.leases.over_deadline")).toContain(
      "alert-don't-auto-repair",
    );
    expect(metricState.points).toContainEqual({
      name: "valet.leases.over_deadline",
      value: 1,
      attributes: {},
    });
  });

  it("keeps reporting a zero count instead of dropping the series", () => {
    recordLeasesOverDeadline(2);
    recordLeasesOverDeadline(0);

    const before = metricState.points.length;
    metricState.collect();
    const added = metricState.points.slice(before);

    expect(added).toContainEqual({
      name: "valet.leases.over_deadline",
      value: 0,
      attributes: {},
    });
  });

  it("flags a lease with no owning wakeup or hold", () => {
    recordLeasesUnannotated(2);
    metricState.collect();

    expect(metricState.points).toContainEqual({
      name: "valet.leases.unannotated",
      value: 2,
      attributes: {},
    });
  });
});

describe("fix wave 2 wakeup and lease metrics", () => {
  it("counts an orphan lease release by owner kind and reason (B2, fix wave 3 M2)", () => {
    recordLeaseOrphanReleased("process", "deadline");
    expect(metricState.descriptions.get("valet.leases.orphan_released")).toContain("crash");
    expect(metricState.points).toContainEqual({
      name: "valet.leases.orphan_released",
      value: 1,
      attributes: { owner_kind: "process", reason: "deadline" },
    });
  });

  it("counts a wakeup a session delete ended under its own cause (fix wave 3, UX L7)", () => {
    recordWakeupEnded("timer", "session_deleted");
    expect(metricState.points).toContainEqual({
      name: "valet.wakeups.total",
      value: 1,
      attributes: { kind: "timer", cause: "session_deleted" },
    });
  });

  it("counts pruned job file sets and dropped docker buffers (fix wave 3, k8s M-B, security L4)", () => {
    recordJobLogsPruned(3);
    recordDockerJobOutputDropped();
    expect(metricState.points).toContainEqual({ name: "valet.jobs.logs_pruned", value: 3, attributes: undefined });
    expect(metricState.points).toContainEqual({ name: "valet.jobs.docker_output_dropped", value: 1, attributes: undefined });
  });

  it("names the exported sweep_ok_at series in its description (fix wave 3, data L3)", () => {
    recordWakeupSweepOk(1);
    expect(metricState.descriptions.get("valet.wakeups.sweep_ok_at")).toContain("valet_wakeups_sweep_ok_at_seconds");
  });

  it("counts a skipped bad row by table (M5)", () => {
    recordWakeupBadRow("engine_leases");
    expect(metricState.points).toContainEqual({
      name: "valet.wakeups.bad_rows",
      value: 1,
      attributes: { table: "engine_leases" },
    });
  });

  it("reports the last successful sweep time and counts failed sweeps (M5)", () => {
    recordWakeupSweepOk(1_700_000_000);
    recordWakeupSweepFailed();
    metricState.collect();
    expect(metricState.points).toContainEqual({ name: "valet.wakeups.sweep_ok_at", value: 1_700_000_000, attributes: {} });
    expect(metricState.points).toContainEqual({ name: "valet.wakeups.sweep_failed", value: 1, attributes: undefined });
  });

  it("counts a child settled past its leases' deadline (B2)", () => {
    recordChildSettleOverDeadline();
    expect(metricState.points).toContainEqual({ name: "valet.leases.settle_over_deadline", value: 1, attributes: undefined });
  });
});

describe("scratch volume metrics", () => {
  it("reports the requested scratch size gauge by session class", () => {
    recordScratchRequested("default", 1024);
    metricState.collect();

    expect(metricState.points).toContainEqual({
      name: "valet.sandbox.scratch.requested_bytes",
      value: 1024,
      attributes: { session_class: "default" },
    });
  });

  it("counts a refused scratch request, by source and reason", () => {
    recordScratchRefused("grow", "quota_exceeded");

    expect(metricState.points).toContainEqual({
      name: "valet.sandbox.scratch.refused",
      value: 1,
      attributes: { source: "grow", reason: "quota_exceeded" },
    });
  });
});
