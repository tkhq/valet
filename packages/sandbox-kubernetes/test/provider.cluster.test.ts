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
import { SANDBOX_CR_API_VERSION, buildSandboxManifest, sandboxCrName } from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";
import {
  RANCHER_DESKTOP_CONTEXT,
  applySandbox,
  customObjectsApiAdapter,
  loadRancherDesktopKubeConfig,
  podDeleteApiAdapter,
  podStatusApiAdapter,
  podsApiAdapter,
} from "../src/lifecycle.js";
import { podExecApiAdapter } from "../src/exec.js";
import { KubernetesSandbox, KubernetesSandboxProvider, podLivenessApiAdapter } from "../src/provider.js";
import { SandboxStartupError } from "@valet/engine";
import { sweepStaleThrowawayNamespaces } from "./throwaway-namespace.js";

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
  let rawDeps: {
    objectsApi: ReturnType<typeof customObjectsApiAdapter>;
    podsApi: ReturnType<typeof podsApiAdapter>;
    execApi: ReturnType<typeof podExecApiAdapter>;
    livenessApi: ReturnType<typeof podLivenessApiAdapter>;
  };

  beforeAll(() => {
    // Reap namespaces a killed previous run's afterAll never got to delete,
    // then create this run's own.
    sweepStaleThrowawayNamespaces(kubectl);
    const created = kubectl(["create", "namespace", namespace]);
    if (created.status !== 0) {
      throw new Error(`failed to create throwaway namespace "${namespace}": ${created.stderr}`);
    }
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
    const podsApi = podsApiAdapter(coreApi);
    const execApi = podExecApiAdapter(new k8s.Exec(kc));
    const livenessApi = podLivenessApiAdapter(coreApi);
    const podStatusApi = podStatusApiAdapter(coreApi);
    const podDeleteApi = podDeleteApiAdapter(coreApi);
    provider = new KubernetesSandboxProvider({ objectsApi, podsApi, execApi, livenessApi, podStatusApi, podDeleteApi }, cfg);
    rawDeps = { objectsApi, podsApi, execApi, livenessApi };
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

  it(
    "a bogus image FAILS FAST: status() reports error with an image-pull reason, and create()/waitReady throws SandboxStartupError well under the 60s ready timeout (bug repro)",
    async () => {
      // Non-existent repository/tag on the default registry — the kubelet
      // reports this as ErrImagePull first, then ImagePullBackOff once it
      // starts backing off retries. Neither this image nor this registry
      // path exists, so there is no risk of an accidental successful pull.
      const identity = `bad-image-${randomUUID()}`;
      const badImage = "valet-nonexistent-image-does-not-exist:doesnotexist";
      const name = sandboxCrName(identity);

      const start = Date.now();
      let thrown: unknown;
      try {
        await provider.create({ workspace: identity, image: badImage });
      } catch (err) {
        thrown = err;
      }
      const elapsedMs = Date.now() - start;

      try {
        expect(thrown).toBeInstanceOf(SandboxStartupError);
        const startupErr = thrown as SandboxStartupError;
        expect(startupErr.message).toMatch(/sandbox failed to start/i);
        expect(startupErr.reason).toMatch(/image pull failed/i);
        expect(startupErr.reason).toMatch(/(ImagePullBackOff|ErrImagePull)/);

        // The whole point of the fix: this must resolve in a handful of
        // poll intervals (READY_POLL_INTERVAL_MS = 1s), NOT burn the full
        // 60s READY_TIMEOUT_MS generic-timeout path.
        expect(elapsedMs).toBeLessThan(30_000);

        // status() independently corroborates the same terminal
        // classification (the provider's own polling loop, exercised
        // directly rather than via the create()/waitReady wrapper).
        const status = await provider.status(name);
        expect(status.state).toBe("error");
        expect(status.error ?? "").toMatch(/image pull failed/i);
      } finally {
        await provider.destroy(name);
      }
    },
    60_000,
  );

  it(
    "gatewayEndpoint() reads spec.service + status.serviceFQDN off the live API server (Task 3)",
    async () => {
      // A full-profile CR's container command (`/bin/bash /start-full.sh`)
      // has no working entrypoint until Task 4 lands the script into the
      // image, so `provider.create()`'s `waitReady` would never observe
      // Ready and this test can't drive gatewayEndpoint() through the
      // normal create() path yet. Bypass waitReady: apply the CR directly
      // with `applySandbox` (this is exactly what buildSandboxManifest
      // produces for profile: "full" — spec.service: true), and simulate
      // the controller having reconciled a Service by patching the CR's
      // status subresource directly. This proves gatewayEndpoint()'s
      // parsing/wiring against the REAL CRD schema (status.service /
      // status.serviceFQDN are confirmed top-level status fields per
      // `kubectl explain sandbox.status`) without depending on Task 4.
      const identity = `gateway-${randomUUID()}`;
      const name = sandboxCrName(identity);
      const manifest = buildSandboxManifest(cfg, name, { workspace: identity, image: "busybox:stable", profile: "full" });
      expect(manifest.spec.service).toBe(true);
      await applySandbox(rawDeps.objectsApi, cfg, manifest);

      try {
        const sandbox = new KubernetesSandbox(
          { objectsApi: rawDeps.objectsApi, podsApi: rawDeps.podsApi, execApi: rawDeps.execApi, livenessApi: rawDeps.livenessApi, cfg },
          name,
        );

        // Before the controller (here: our patch, standing in for it) sets
        // status.serviceFQDN, gatewayEndpoint() must report null even
        // though spec.service is true — the Service isn't reachable yet.
        await expect(sandbox.gatewayEndpoint?.()).resolves.toBeNull();

        const fqdn = `${name}.${namespace}.svc.cluster.local`;
        const patch = kubectl([
          "-n",
          namespace,
          "patch",
          "sandbox",
          name,
          "--type=merge",
          "--subresource=status",
          "-p",
          JSON.stringify({ status: { service: name, serviceFQDN: fqdn } }),
        ]);
        expect(patch.status).toBe(0);

        await expect(sandbox.gatewayEndpoint?.()).resolves.toEqual({ host: fqdn, port: 9000 });
      } finally {
        await kubectl(["-n", namespace, "delete", "sandbox", name, "--ignore-not-found"]);
      }
    },
    60_000,
  );
});
