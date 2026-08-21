import { describe, expect, it } from "vitest";
import { sweepStaleThrowawayNamespaces } from "./throwaway-namespace.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function fakeKubectl(listing: { status: number; stdout: string }) {
  const calls: string[][] = [];
  const fn = (args: string[]) => {
    calls.push(args);
    if (args[0] === "get") return { status: listing.status, stdout: listing.stdout, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fn, calls };
}

describe("sweepStaleThrowawayNamespaces", () => {
  it("deletes only stale valet-sbx-* namespaces, keeping fresh and foreign ones", () => {
    const staleConformance = `valet-sbx-conformance-${NOW - 17 * 24 * HOUR}`;
    const staleExec = `valet-sbx-exec-${NOW - 7 * HOUR}`;
    const freshLifecycle = `valet-sbx-lifecycle-${NOW - 5 * 60 * 1000}`;
    const { fn, calls } = fakeKubectl({
      status: 0,
      stdout: [
        `namespace/${staleConformance}`,
        `namespace/${staleExec}`,
        `namespace/${freshLifecycle}`,
        "namespace/kube-system",
        "namespace/valet-sandboxes",
        "",
      ].join("\n"),
    });

    const swept = sweepStaleThrowawayNamespaces(fn, NOW);

    expect(swept).toEqual([staleConformance, staleExec]);
    const deleted = calls.filter((c) => c[0] === "delete").map((c) => c[2]);
    expect(deleted).toEqual([staleConformance, staleExec]);
  });

  it("keeps prefixed namespaces whose suffix is not an epoch timestamp", () => {
    const { fn, calls } = fakeKubectl({
      status: 0,
      stdout: "namespace/valet-sbx-conformance-notanumber\n",
    });

    expect(sweepStaleThrowawayNamespaces(fn, NOW)).toEqual([]);
    expect(calls.filter((c) => c[0] === "delete")).toEqual([]);
  });

  it("is a no-op when listing namespaces fails", () => {
    const { fn, calls } = fakeKubectl({ status: 1, stdout: "" });

    expect(sweepStaleThrowawayNamespaces(fn, NOW)).toEqual([]);
    expect(calls.filter((c) => c[0] === "delete")).toEqual([]);
  });

  it("issues non-blocking, idempotent deletes", () => {
    const stale = `valet-sbx-provider-${NOW - 24 * HOUR}`;
    const { fn, calls } = fakeKubectl({ status: 0, stdout: `namespace/${stale}\n` });

    sweepStaleThrowawayNamespaces(fn, NOW);

    const del = calls.find((c) => c[0] === "delete");
    expect(del).toContain("--ignore-not-found");
    expect(del).toContain("--wait=false");
  });
});
