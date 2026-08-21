/**
 * Reaper for leaked throwaway test namespaces. Each *.cluster.test.ts suite
 * works in its own `valet-sbx-<suite>-<epochMs>` namespace and deletes it in
 * `afterAll` — but a killed test process never gets there, and the namespace
 * leaks together with its dead sandbox pods. The creation time rides in the
 * name, so the next run can reap what a dead one left behind.
 */

const THROWAWAY_NAMESPACE_PREFIX = "valet-sbx-";

/** Far beyond any suite's runtime, far below "leaked days ago". */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

type Kubectl = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** Deletes leaked `valet-sbx-*-<epochMs>` namespaces older than the staleness
 * threshold. Best-effort: listing failures return [] — the suite's own
 * namespace-create right after this surfaces real cluster trouble. */
export function sweepStaleThrowawayNamespaces(kubectl: Kubectl, now: number = Date.now()): string[] {
  const listed = kubectl(["get", "namespaces", "-o", "name"]);
  if (listed.status !== 0) return [];

  const stale = listed.stdout
    .split("\n")
    .map((line) => line.replace(/^namespace\//, "").trim())
    .filter((name) => {
      if (!name.startsWith(THROWAWAY_NAMESPACE_PREFIX)) return false;
      const epochMs = Number(name.slice(name.lastIndexOf("-") + 1));
      return Number.isFinite(epochMs) && now - epochMs > STALE_AFTER_MS;
    });

  for (const name of stale) {
    // --wait=false: namespace finalization can take minutes; don't block suite startup on it.
    kubectl(["delete", "namespace", name, "--ignore-not-found", "--wait=false"]);
  }
  return stale;
}
