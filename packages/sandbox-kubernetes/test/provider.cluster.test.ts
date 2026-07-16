/**
 * Task 5 targeted tests (beyond the generic conformance suite in
 * conformance.cluster.test.ts): destroy() terminal cascade (CR + pod + PVC
 * all gone), the liveness/SandboxUnavailableError-translation path for a
 * pod killed mid-exec, and (adversarial-review fix, decision 5) the two
 * REAL paths a session's teardown/re-provision can take:
 *   - `destroy()` reached through the attachment's terminal path (session
 *     deletion) — CR+pod+PVC gone.
 *   - `release()` reached through `SandboxAttachment.reportFailure`'s
 *     non-terminal re-provision path — CR (and its workspace PVC) survives,
 *     and the follow-up `create()` (upsert, same opts) re-adopts it.
 * Same skip-gate and context-safety posture as the other `.cluster.test.ts`
 * files (decision 2, BINDING).
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTAINER_DEATH_PATTERN } from "@valet/engine";
import { SANDBOX_CR_API_VERSION } from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";
import { RANCHER_DESKTOP_CONTEXT, customObjectsApiAdapter, loadRancherDesktopKubeConfig, podsApiAdapter } from "../src/lifecycle.js";
import { podExecApiAdapter } from "../src/exec.js";
import { KubernetesSandboxProvider, podLivenessApiAdapter } from "../src/provider.js";

function kubectl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("kubectl", ["--context", RANCHER_DESKTOP_CONTEXT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function clusterReady(): boolean {
  const crd = kubectl(["get", "crd", "sandboxes.agents.x-k8s.io"]);
  if (crd.status !== 0) return false;
  const controller = kubectl(["-n", "agent-sandbox-system", "get", "deployment", "agent-sandbox-controller"]);
  return controller.status === 0;
}

const isClusterReady = clusterReady();

describe.skipIf(!isClusterReady)("KubernetesSandboxProvider targeted behaviors (live rancher-desktop cluster)", () => {
  const namespace = `valet-sbx-provider-${Date.now()}`;
  const cfg: K8sProviderConfig = {
    namespace,
    defaultImage: "busybox:stable",
    apiVersion: SANDBOX_CR_API_VERSION,
  };

  let provider: KubernetesSandboxProvider;

  beforeAll(() => {
    const created = kubectl(["create", "namespace", namespace]);
    if (created.status !== 0) {
      throw new Error(`failed to create throwaway namespace "${namespace}": ${created.stderr}`);
    }
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
    const podsApi = podsApiAdapter(kc.makeApiClient(k8s.CoreV1Api));
    const execApi = podExecApiAdapter(new k8s.Exec(kc));
    const livenessApi = podLivenessApiAdapter(kc.makeApiClient(k8s.CoreV1Api));
    provider = new KubernetesSandboxProvider({ objectsApi, podsApi, execApi, livenessApi }, cfg);
  }, 30_000);

  afterAll(() => {
    kubectl(["delete", "namespace", namespace, "--ignore-not-found"]);
  }, 60_000);

  it(
    "destroy() is terminal: CR, backing pod, and workspace PVC are all gone afterward",
    async () => {
      const identity = `destroy-${randomUUID()}`;
      const sandbox = await provider.create({ workspace: identity, image: "busybox:stable" });
      const name = sandbox.id;

      // Sanity: CR + pod + PVC actually exist before destroy.
      expect(kubectl(["-n", namespace, "get", "sandbox", name]).status).toBe(0);
      expect(kubectl(["-n", namespace, "get", "pod", name]).status).toBe(0);
      const pvcBefore = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim();
      expect(pvcBefore.length).toBeGreaterThan(0);

      await provider.destroy(name);

      // CR delete is synchronous; pod/PVC cascade via owner references is
      // async (observed up to ~60s in lifecycle.cluster.test.ts) — poll.
      const deadline = Date.now() + 60_000;
      let crGone = false;
      let podGone = false;
      let pvcGone = false;
      while (Date.now() < deadline && !(crGone && podGone && pvcGone)) {
        crGone = kubectl(["-n", namespace, "get", "sandbox", name]).status !== 0;
        podGone = kubectl(["-n", namespace, "get", "pod", name]).status !== 0;
        pvcGone = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim() === "";
        if (!(crGone && podGone && pvcGone)) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(crGone).toBe(true);
      expect(podGone).toBe(true);
      expect(pvcGone).toBe(true);

      // status() on a fully-destroyed sandbox reports "released", not an
      // error — matches lifecycle.ts's sandboxStatus contract for an
      // absent CR.
      await expect(provider.status(name)).resolves.toEqual({ id: name, state: "released" });
    },
    120_000,
  );

  it(
    "a pod killed mid-exec surfaces a transport-failure-shaped error (the CONTAINER_DEATH_PATTERN match PolicySandbox's dispatch() classifies as SandboxUnavailableError)",
    async () => {
      const identity = `kill-mid-exec-${randomUUID()}`;
      const sandbox = await provider.create({ workspace: identity, image: "busybox:stable" });
      const name = sandbox.id;

      try {
        const execPromise = sandbox.exec("sleep 30");
        // Let the exec actually attach before yanking the pod out from
        // under it (same 1.5s margin kill-container-recovery.test.ts uses
        // for the docker analog).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        kubectl(["-n", namespace, "delete", "pod", name, "--wait=false", "--grace-period=0", "--force"]);

        await expect(execPromise).rejects.toThrow(CONTAINER_DEATH_PATTERN);

        // The specific message this provider constructs (podUnavailableError,
        // see provider.ts) always says "is not running" — one of the
        // pattern's literal alternatives — so this also pins the exact
        // wording, not just that some CONTAINER_DEATH_PATTERN-matching text
        // happened to appear.
        await expect(execPromise).rejects.toThrow(/is not running/i);
      } finally {
        await provider.destroy(name);
      }
    },
    60_000,
  );

  it(
    "TERMINAL teardown via the real attachment path: create -> write workspace file -> provider.destroy() -> CR+pod+PVC all gone",
    async () => {
      // Drives the exact path `SandboxAttachment.destroy()` reaches on
      // session deletion: raw `KubernetesSandbox` has no `destroy()` method
      // (see provider.ts), so the attachment falls through to
      // `provider.destroy(id)` — the terminal CR+PVC cascade delete. This
      // pins that fallthrough by exercising `provider.destroy` directly
      // (the attachment layer itself is unit-tested against a fake
      // provider in packages/engine/test/sandbox-attachment.test.ts; this
      // test proves the k8s side of that contract against the live
      // controller).
      const identity = `terminal-${randomUUID()}`;
      const sandbox = await provider.create({ workspace: identity, image: "busybox:stable" });
      const name = sandbox.id;

      await sandbox.writeFile("/workspace/terminal-marker.txt", "should not survive destroy\n");
      await expect(sandbox.readFile("/workspace/terminal-marker.txt")).resolves.toContain("should not survive");

      const pvcBefore = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim();
      expect(pvcBefore.length).toBeGreaterThan(0);

      await provider.destroy(name);

      const deadline = Date.now() + 60_000;
      let crGone = false;
      let podGone = false;
      let pvcGone = false;
      while (Date.now() < deadline && !(crGone && podGone && pvcGone)) {
        crGone = kubectl(["-n", namespace, "get", "sandbox", name]).status !== 0;
        podGone = kubectl(["-n", namespace, "get", "pod", name]).status !== 0;
        pvcGone = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim() === "";
        if (!(crGone && podGone && pvcGone)) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(crGone).toBe(true);
      expect(podGone).toBe(true);
      expect(pvcGone).toBe(true);
    },
    120_000,
  );

  it(
    "NON-TERMINAL re-provision via provider.release(): create -> write workspace file -> release() (no-op) -> create() SAME opts re-adopts CR -> file still present",
    async () => {
      // Simulates exactly what `SandboxAttachment.reportFailure` now does
      // (spec decision 5, adversarial-review fix): on a liveness-triggered
      // re-provision it calls `provider.release(oldId)` — never
      // `provider.destroy(oldId)` — before re-`create`ing with the SAME
      // `SandboxCreateOpts`. This is the whole point of the `release` seam:
      // proving the workspace PVC survives that path, unlike the old
      // unconditional-`destroy` behavior which would have cascade-deleted
      // it.
      const identity = `release-${randomUUID()}`;
      const opts = { workspace: identity, image: "busybox:stable" };
      const sandbox = await provider.create(opts);
      const name = sandbox.id;

      try {
        await sandbox.writeFile("/workspace/release-marker.txt", "should survive release\n");
        await expect(sandbox.readFile("/workspace/release-marker.txt")).resolves.toContain(
          "should survive release",
        );

        const pvcBefore = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim();
        expect(pvcBefore.length).toBeGreaterThan(0);

        // release(): no-op, must leave the CR (and its PVC) standing.
        await provider.release(name);
        expect(kubectl(["-n", namespace, "get", "sandbox", name]).status).toBe(0);
        const pvcAfterRelease = kubectl(["-n", namespace, "get", "pvc", "-o", "name"]).stdout.trim();
        expect(pvcAfterRelease).toBe(pvcBefore);

        // create() again with the SAME opts (the attachment's re-provision
        // shape): upsert-adopts the retained CR rather than erroring.
        const reprovisioned = await provider.create(opts);
        expect(reprovisioned.id).toBe(name);

        await expect(reprovisioned.readFile("/workspace/release-marker.txt")).resolves.toContain(
          "should survive release",
        );
      } finally {
        await provider.destroy(name);
      }
    },
    120_000,
  );
});
