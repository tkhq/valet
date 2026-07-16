/**
 * Live-cluster exercise of src/lifecycle.ts against the vendored
 * agent-sandbox v0.5.1 controller on Rancher Desktop k3s (Task 3 verified
 * it's installed and running in `agent-sandbox-system`).
 *
 * Context safety (decision 2, BINDING): every `kubectl` invocation below
 * pins `--context rancher-desktop` explicitly, and the client-node calls
 * go through `loadRancherDesktopKubeConfig`, which does the same. Nothing
 * here ever touches the ambient current-context (a production GKE
 * cluster on this machine).
 *
 * Skip-gated: `describe.skipIf` runs a cheap kubectl probe (CRD +
 * controller Deployment existence) before the suite. If the
 * rancher-desktop context isn't reachable or the CRD isn't installed,
 * the whole suite is skipped rather than failing — same pattern as
 * sandbox-docker's Docker-gated tests (`packages/sandbox-docker/test/
 * docker-sandbox.test.ts`).
 *
 * Namespace cleanup is `finally`-safe: the throwaway namespace is deleted
 * in `afterAll`, which vitest runs even when an `it` in this file throws.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { SANDBOX_CR_API_VERSION, buildSandboxManifest } from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";
import {
  RANCHER_DESKTOP_CONTEXT,
  applySandbox,
  customObjectsApiAdapter,
  deleteSandbox,
  getSandbox,
  loadRancherDesktopKubeConfig,
  podsApiAdapter,
  resolvePodName,
  sandboxStatus,
} from "../src/lifecycle.js";

function kubectl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("kubectl", ["--context", RANCHER_DESKTOP_CONTEXT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Cheap reachability probe: confirms the rancher-desktop context works
 * AND the vendored agent-sandbox CRD + controller are installed, without
 * doing any real work. */
function clusterReady(): boolean {
  const crd = kubectl(["get", "crd", "sandboxes.agents.x-k8s.io"]);
  if (crd.status !== 0) return false;
  const controller = kubectl(["-n", "agent-sandbox-system", "get", "deployment", "agent-sandbox-controller"]);
  return controller.status === 0;
}

function podUid(namespace: string, name: string): string | null {
  const r = kubectl(["-n", namespace, "get", "pod", name, "-o", "jsonpath={.metadata.uid}"]);
  if (r.status !== 0) return null;
  const uid = r.stdout.trim();
  return uid.length > 0 ? uid : null;
}

const isClusterReady = clusterReady();

describe.skipIf(!isClusterReady)("lifecycle (live rancher-desktop cluster)", () => {
  const namespace = `valet-sbx-lifecycle-${Date.now()}`;
  const cfg: K8sProviderConfig = {
    namespace,
    defaultImage: "busybox:stable",
    apiVersion: SANDBOX_CR_API_VERSION,
  };
  let objectsApi: ReturnType<typeof customObjectsApiAdapter>;
  let podsApi: ReturnType<typeof podsApiAdapter>;

  beforeAll(() => {
    const created = kubectl(["create", "namespace", namespace]);
    if (created.status !== 0) {
      throw new Error(`failed to create throwaway namespace "${namespace}": ${created.stderr}`);
    }
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
    podsApi = podsApiAdapter(kc.makeApiClient(k8s.CoreV1Api));
  }, 30_000);

  afterAll(() => {
    // finally-safe: this runs even if an `it` above throws. Synchronous
    // (no --wait=false) so the namespace is actually gone before the
    // process exits — leaves only agent-sandbox-system behind, per the
    // task's cluster-cleanliness constraint.
    kubectl(["delete", "namespace", namespace, "--ignore-not-found"]);
  }, 60_000);

  it(
    "apply -> Ready -> resolvePodName -> adopt-idempotence -> pod-delete recovery -> destroy",
    async () => {
      const name = "lifecycle-e2e";
      // busybox:stable so this test doesn't depend on a locally-built
      // valet-sandbox image; buildSandboxManifest's default container
      // command (`tail -f /dev/null`, see ./manifest.ts) is a busybox
      // applet, so no override needed.
      const manifest = buildSandboxManifest(cfg, name, { image: "busybox:stable" });

      // ── create -> Ready ──────────────────────────────────────────
      const created = await applySandbox(objectsApi, cfg, manifest);
      expect(created.metadata.name).toBe(name);
      expect(created.metadata.uid).toBeTruthy();

      let status = await sandboxStatus(objectsApi, cfg, name);
      const readyDeadline = Date.now() + 30_000;
      while (status.state !== "ready" && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = await sandboxStatus(objectsApi, cfg, name);
      }
      expect(status).toEqual({ id: name, state: "ready" });

      // ── resolvePodName ───────────────────────────────────────────
      const podName = await resolvePodName(objectsApi, podsApi, cfg, name);
      // Empirical (see lifecycle.ts docblock): the controller's pod
      // identity is exact-name-match against the Sandbox name, not a
      // suffixed/hashed name.
      expect(podName).toBe(name);
      const originalUid = podUid(cfg.namespace, podName!);
      expect(originalUid).toBeTruthy();

      // ── adopt-idempotence: re-apply the identical manifest ──────
      const reapplied = await applySandbox(objectsApi, cfg, manifest);
      expect(reapplied.metadata.name).toBe(name);
      expect(reapplied.metadata.uid).toBe(created.metadata.uid); // same CR, not recreated
      // Pod itself must be untouched by a same-spec re-apply.
      expect(podUid(cfg.namespace, name)).toBe(originalUid);

      // ── kubectl-delete-the-pod -> controller recreates ──────────
      // --grace-period=0 --force: busybox's default sleep-loop entrypoint
      // doesn't respond to SIGTERM, so a graceful delete sits in
      // `Terminating` for the full ~30s grace period before the pod
      // object is actually gone (observed manually while investigating
      // restartPolicy — see lifecycle.ts's docblock). Forcing an
      // immediate delete is both faster and a closer simulation of an
      // evicted/OOM-killed pod (which also disappears without a graceful
      // shutdown).
      const podDeleted = kubectl([
        "-n",
        cfg.namespace,
        "delete",
        "pod",
        podName!,
        "--wait=false",
        "--grace-period=0",
        "--force",
      ]);
      expect(podDeleted.status).toBe(0);

      let recreatedUid: string | null = null;
      const recreateDeadline = Date.now() + 45_000;
      while (Date.now() < recreateDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const uid = podUid(cfg.namespace, name);
        if (uid && uid !== originalUid) {
          recreatedUid = uid;
          break;
        }
      }
      expect(recreatedUid).not.toBeNull();
      expect(recreatedUid).not.toBe(originalUid);

      // resolvePodName must re-resolve fresh (not return a stale cached
      // value) — same name string per the controller's identity scheme,
      // but backed by the new pod object.
      const resolvedAfterRecreate = await resolvePodName(objectsApi, podsApi, cfg, name);
      expect(resolvedAfterRecreate).toBe(name);
      expect(podUid(cfg.namespace, resolvedAfterRecreate!)).toBe(recreatedUid);

      // ── destroy (TERMINAL): CR + pod + PVC gone ─────────────────
      await deleteSandbox(objectsApi, cfg, name);

      const afterDelete = await getSandbox(objectsApi, cfg, name);
      expect(afterDelete).toBeNull();

      // The CR delete itself is synchronous, but the owner-reference
      // cascade to the pod/PVC is async, and the cascaded pod delete uses
      // the default (graceful, ~30s) grace period — poll well past that
      // rather than asserting immediately.
      const cascadeDeadline = Date.now() + 60_000;
      let podGoneStatus: number | null = 0;
      let pvcListStdout = "unchecked";
      while (Date.now() < cascadeDeadline) {
        podGoneStatus = kubectl(["-n", cfg.namespace, "get", "pod", name]).status;
        pvcListStdout = kubectl(["-n", cfg.namespace, "get", "pvc", "-o", "name"]).stdout.trim();
        if (podGoneStatus !== 0 && pvcListStdout === "") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(podGoneStatus).not.toBe(0);
      expect(pvcListStdout).toBe("");
    },
    150_000,
  );

  it("deleteSandbox is idempotent — deleting an already-absent CR does not throw", async () => {
    await expect(deleteSandbox(objectsApi, cfg, "never-existed")).resolves.toBeUndefined();
  });

  it("getSandbox / sandboxStatus report an absent CR as null / released", async () => {
    await expect(getSandbox(objectsApi, cfg, "never-existed")).resolves.toBeNull();
    await expect(sandboxStatus(objectsApi, cfg, "never-existed")).resolves.toEqual({
      id: "never-existed",
      state: "released",
    });
  });
});
