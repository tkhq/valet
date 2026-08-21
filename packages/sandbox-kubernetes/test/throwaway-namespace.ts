/**
 * Reaper for leaked throwaway test namespaces.
 *
 * Every *.cluster.test.ts suite works in its own `valet-sbx-<suite>-<epochMs>`
 * namespace and deletes it in `afterAll` — but a killed test process (SIGKILL,
 * hard runner timeout, closed laptop) never reaches `afterAll`, and the
 * namespace leaks forever together with its dead sandbox pods. Each leaked pod
 * permanently occupies one of the node's kubelet pod slots (110/node k3s
 * default); observed in the wild as a 17-day-old conformance namespace still
 * holding 18 Failed pods.
 *
 * Because the creation time rides in the namespace name, the NEXT suite run
 * can reap what a dead one left behind: call this before creating a fresh
 * namespace. The age threshold is far beyond any suite's runtime, so a sweep
 * can never touch a namespace belonging to a concurrently running suite.
 */

export const THROWAWAY_NAMESPACE_PREFIX = "valet-sbx-";

/** Far beyond any suite's runtime, far below "leaked days ago". */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

type Kubectl = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** Deletes leaked `valet-sbx-*-<epochMs>` namespaces older than the staleness
 * threshold. Best-effort by design: listing failures return [] rather than
 * throw, because the suite's own namespace-create right after this will
 * surface any real cluster trouble with a better error. Returns the names it
 * issued deletes for (used by tests; callers may ignore it). */
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
    // --wait=false: namespace finalization can take minutes; the point is
    // that the pods go eventually, not that this suite's startup blocks on it.
    kubectl(["delete", "namespace", name, "--ignore-not-found", "--wait=false"]);
  }
  return stale;
}
