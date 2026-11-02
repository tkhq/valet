import { describe, expect, it } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import {
  SANDBOX_COUNTS_OPERATOR_ONLY, apiNamespaceRbac, podHealthApiAdapter, podRead, readPodHealth, summarizeApiNamespace, summarizeSandboxNamespace, type PodRead,
} from "./pod-health.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

function pod(name: string, node: string, containers: PodRead["containers"]): PodRead {
  return { name, node, containers };
}

describe("podRead", () => {
  it("keeps restarts, state, and the last termination of every container", () => {
    const v1: k8s.V1Pod = {
      metadata: { name: "valet-api-7d9" },
      spec: { nodeName: "platform-1", containers: [] },
      status: {
        phase: "Running",
        startTime: new Date(NOW - 60_000),
        containerStatuses: [{
          name: "api", image: "valet", imageID: "", ready: true, restartCount: 3,
          state: { running: { startedAt: new Date(NOW - 30_000) } },
          lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date(NOW - 31_000) } },
        }],
      },
    };
    expect(podRead(v1)).toEqual({
      name: "valet-api-7d9", phase: "Running", node: "platform-1", startedAt: NOW - 60_000,
      containers: [{ name: "api", ready: true, restarts: 3, state: "running", lastTermination: { reason: "OOMKilled", exitCode: 137, finishedAt: NOW - 31_000 } }],
    });
  });
});

describe("podHealthApiAdapter", () => {
  it("asks for Warning events on pods only and trims their messages", async () => {
    let selector = "";
    const api = podHealthApiAdapter({
      listNamespacedPod: async () => ({ items: [] }),
      listNamespacedEvent: async (request) => {
        selector = request.fieldSelector ?? "";
        return { items: [{ metadata: {}, involvedObject: { name: "valet-api-7d9" }, reason: "Unhealthy",
          message: `Liveness probe failed:\n${"x".repeat(400)}`, count: 4, lastTimestamp: new Date(NOW) }] };
      },
    });
    const [warning] = await api.listPodWarnings("valet");
    expect(selector).toBe("type=Warning,involvedObject.kind=Pod");
    expect(warning).toMatchObject({ pod: "valet-api-7d9", reason: "Unhealthy", count: 4, lastAt: NOW });
    expect(warning?.message?.length).toBe(200);
  });
});

describe("summaries", () => {
  it("lists restarted API pods first with the last hour's warnings", () => {
    const summary = summarizeApiNamespace([
      pod("valet-pg-1", "platform-2", [{ name: "postgres", ready: true, restarts: 0, state: "running" }]),
      pod("valet-api-7d9", "platform-1", [{ name: "api", ready: true, restarts: 2, state: "running", lastTermination: { reason: "OOMKilled", exitCode: 137 } }]),
    ], [
      { pod: "valet-api-7d9", reason: "Unhealthy", count: 3, lastAt: NOW - 5 * 60_000 },
      { pod: "valet-api-7d9", reason: "BackOff", count: 1, lastAt: NOW - 3 * 60 * 60_000 },
    ], NOW);
    expect(summary.pods.map((entry) => entry.name)).toEqual(["valet-api-7d9", "valet-pg-1"]);
    expect(summary.warnings).toEqual([{ pod: "valet-api-7d9", reason: "Unhealthy", count: 3, lastAt: NOW - 5 * 60_000 }]);
  });

  it("counts sandbox pods by node and reason without naming them", () => {
    const summary = summarizeSandboxNamespace([
      pod("sbx-a", "node-1", [{ name: "sandbox", ready: true, restarts: 1, state: "running", lastTermination: { reason: "OOMKilled", exitCode: 137 } }]),
      pod("sbx-b", "node-1", [{ name: "sandbox", ready: true, restarts: 0, state: "running" }]),
      pod("sbx-c", "node-2", [{ name: "sandbox", ready: false, restarts: 4, state: "waiting:CrashLoopBackOff", lastTermination: { reason: "Error", exitCode: 1 } }]),
    ], [{ reason: "Evicted", count: 2, lastAt: NOW }], NOW);
    expect(summary).toEqual({
      pods: 3, restartedPods: 2, restarts: 5, oomKilledPods: 1,
      lastTerminations: { OOMKilled: 1, Error: 1 },
      byNode: [{ node: "node-1", pods: 2, restarts: 1, oomKilled: 1 }, { node: "node-2", pods: 1, restarts: 4, oomKilled: 0 }],
      warningReasons: { Evicted: 2 },
    });
    expect(JSON.stringify(summary)).not.toContain("sbx-");
  });
});

describe("readPodHealth", () => {
  it("reports a refused namespace with the Role to add and an unreachable one with its error", async () => {
    const result = await readPodHealth({
      api: {
        listPods: async (namespace) => {
          if (namespace === "valet") throw Object.assign(new Error("forbidden"), { code: 403 });
          throw new Error("connect ECONNREFUSED 10.0.0.1:443");
        },
        listPodWarnings: async () => [],
      },
      apiNamespace: "valet",
      sandboxNamespace: "valet-sandboxes",
    }, { includeSandboxes: true, now: NOW });
    expect(result.api).toEqual({ namespace: "valet", error: "forbidden", requiredRbac: apiNamespaceRbac("valet") });
    expect(result.sandboxes).toEqual({ namespace: "valet-sandboxes", error: "unavailable", detail: "connect ECONNREFUSED 10.0.0.1:443" });
  });

  it("says there is no API pod out of cluster", async () => {
    const result = await readPodHealth({ api: { listPods: async () => [], listPodWarnings: async () => [] }, sandboxNamespace: "valet-sandboxes" }, { includeSandboxes: true, now: NOW });
    expect(result.api).toMatchObject({ error: "out_of_cluster" });
  });

  it("does not read sandbox pods for a caller who may not see every organization's numbers", async () => {
    const read: string[] = [];
    const result = await readPodHealth({
      api: { listPods: async (namespace) => { read.push(namespace); return []; }, listPodWarnings: async () => [] },
      apiNamespace: "valet",
      sandboxNamespace: "valet-sandboxes",
    }, { includeSandboxes: false, now: NOW });
    expect(read).toEqual(["valet"]);
    expect(result.sandboxes).toEqual({ namespace: "valet-sandboxes", omitted: SANDBOX_COUNTS_OPERATOR_ONLY });
  });
});
