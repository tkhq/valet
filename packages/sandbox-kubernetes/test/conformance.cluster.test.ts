/**
 * Task 5 exit criteria: the engine's sandbox-provider conformance suite
 * (`runSandboxContract`, `packages/engine/src/test-helpers/sandbox-contract.ts`
 * — the same suite `sandbox-docker`/`sandbox-local` run) against
 * `KubernetesSandboxProvider` on the live Rancher Desktop k3s cluster.
 * Skip-gated the same way as lifecycle.cluster.test.ts/exec.cluster.test.ts:
 * a cheap kubectl probe for the CRD + controller before the suite even
 * starts, so CI/dev machines without the cluster just skip.
 *
 * Context safety (decision 2, BINDING): every `kubectl` call pins
 * `--context rancher-desktop` explicitly; every client-node call goes
 * through `loadRancherDesktopKubeConfig`. Nothing here reads the ambient
 * current-context (a production GKE cluster on this dev machine).
 *
 * `capabilities().persistentWorkspace` is `true`, so the suite requires
 * `ctx.recreate`. Per decision 5 (NON-NEGOTIABLE), that callback is
 * implemented as **pod-recreate under the retained CR** — delete the
 * backing pod via CoreV1, wait for the controller to reconcile a fresh pod
 * + Ready, and return a NEW `KubernetesSandbox` handle bound to the SAME
 * CR name — never `provider.destroy()` + `provider.create()` (that would
 * cascade-delete the workspace PVC, the exact thing decision 5 forbids on
 * a recovery path).
 *
 * Each `it()` in `runSandboxContract` calls `factory()` independently, so
 * each gets its OWN Sandbox CR (a fresh random identity fed to
 * `sandboxCrName`) rather than sharing one — a shared CR would race
 * `destroy()`'s async pod/PVC cascade (observed in lifecycle.cluster.test.ts
 * to take up to ~60s) against the next test's `create()` re-applying the
 * same name.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { afterAll, describe, expect, it } from "vitest";
import { runSandboxContract } from "@valet/engine/test-helpers";
import { SANDBOX_CR_API_VERSION } from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";
import {
  RANCHER_DESKTOP_CONTEXT,
  customObjectsApiAdapter,
  loadRancherDesktopKubeConfig,
  podDeleteApiAdapter,
  podStatusApiAdapter,
  podsApiAdapter,
} from "../src/lifecycle.js";
import { podExecApiAdapter } from "../src/exec.js";
import { sweepStaleThrowawayNamespaces } from "./throwaway-namespace.js";
import {
  KubernetesSandbox,
  KubernetesSandboxProvider,
  podLivenessApiAdapter,
  sandboxSecretsApiAdapter,
} from "../src/provider.js";

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

describe.skipIf(!isClusterReady)("kubernetes sandbox contract (live rancher-desktop cluster)", () => {
  const namespace = `valet-sbx-conformance-${Date.now()}`;
  const cfg: K8sProviderConfig = {
    namespace,
    defaultImage: "busybox:stable",
    apiVersion: SANDBOX_CR_API_VERSION,
  };

  const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
  const podsApi = podsApiAdapter(coreApi);
  const execApi = podExecApiAdapter(new k8s.Exec(kc));
  const livenessApi = podLivenessApiAdapter(coreApi);
  const podStatusApi = podStatusApiAdapter(coreApi);
  const podDeleteApi = podDeleteApiAdapter(coreApi);
  const secretsApi = sandboxSecretsApiAdapter(coreApi);

  const provider = new KubernetesSandboxProvider({ objectsApi, podsApi, execApi, livenessApi, podStatusApi, podDeleteApi, secretsApi }, cfg);

  // Reap namespaces a killed previous run's afterAll never got to delete,
  // then create this run's own.
  sweepStaleThrowawayNamespaces(kubectl);
  kubectl(["create", "namespace", namespace]);

  // finally-safe: runs even if an `it` inside runSandboxContract's nested
  // `describe` throws. Each factory()/recreate() cleanup already destroys
  // its own CR, so this is a backstop for anything a failed assertion
  // skipped, plus the actual namespace object itself.
  afterAll(() => {
    kubectl(["delete", "namespace", namespace, "--ignore-not-found"]);
  }, 90_000);

  async function podUid(podName: string): Promise<string | null> {
    try {
      const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
      return pod.metadata?.uid ?? null;
    } catch {
      return null;
    }
  }

  runSandboxContract("kubernetes", {
    factory: async () => {
      const identity = `contract-${randomUUID()}`;
      const sandbox = await provider.create({ workspace: identity, image: "busybox:stable" });
      return {
        sandbox,
        cleanup: async () => {
          await provider.destroy(sandbox.id);
        },
      };
    },
    recreate: async (sandbox) => {
      const before = await podUid(sandbox.id);
      if (before === null) {
        throw new Error(`recreate: no backing pod found for CR "${sandbox.id}" before deletion`);
      }
      // --grace-period=0 --force: same rationale as lifecycle.cluster.test.ts
      // — busybox's sleep-loop entrypoint ignores SIGTERM, so a graceful
      // delete would sit in Terminating for the full ~30s grace period.
      const deleted = await coreApi.deleteNamespacedPod({
        name: sandbox.id,
        namespace,
        gracePeriodSeconds: 0,
      });
      void deleted;

      const deadline = Date.now() + 60_000;
      let afterUid: string | null = null;
      for (;;) {
        afterUid = await podUid(sandbox.id);
        if (afterUid !== null && afterUid !== before) break;
        if (Date.now() >= deadline) {
          throw new Error(`recreate: controller did not reconcile a fresh pod for CR "${sandbox.id}" in time`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Wait for the fresh pod to actually reach Ready before handing back
      // a usable Sandbox — otherwise the contract's immediate
      // readFile/writeFile round-trip could race the container starting.
      const readyDeadline = Date.now() + 30_000;
      for (;;) {
        const pod = await coreApi.readNamespacedPod({ name: sandbox.id, namespace }).catch(() => null);
        if (pod?.status?.phase === "Running") break;
        if (Date.now() >= readyDeadline) {
          throw new Error(`recreate: fresh pod for CR "${sandbox.id}" did not reach Running in time`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const recreated = new KubernetesSandbox({ objectsApi, podsApi, execApi, livenessApi, cfg }, sandbox.id);
      return {
        sandbox: recreated,
        cleanup: async () => {
          await provider.destroy(sandbox.id);
        },
      };
    },
    capabilities: provider.capabilities(),
    provider,
    supportsAbort: true,
    shell: "full",
    // This suite's factory always creates headless (profile omitted)
    // sandboxes, so "null" is the honest expectation here — not
    // "service-fqdn". A full-profile CR needs a working `/start-full.sh`
    // entrypoint (Task 4, not yet landed) to actually reach Ready; forcing
    // profile: "full" through this shared factory would break every other
    // case in this suite (readFile/exec/etc.) against a live cluster today.
    // The full-profile "service-fqdn" path is covered directly against a
    // live CR's spec/status in provider.cluster.test.ts, which doesn't
    // require the pod to actually become Ready.
    gatewayEndpoint: "null",
  });

  it(
    "create() with image B after create() with image A rolls the pod and preserves /workspace but not /root",
    async () => {
      // imageA is the suite's default image (already in the node's image
      // cache from prior conformance tests). imageB is a distinct image also
      // present in the Rancher Desktop containerd cache — no pull latency,
      // and a different name string than imageA (required for the drift check
      // to trigger).
      const imageA = "busybox:stable";
      const imageB = "rancher/mirrored-library-busybox:1.37.0";
      const identity = `imgdrift-${randomUUID()}`;

      // Step 1: create with image A and write sentinel files.
      const sandboxA = await provider.create({ workspace: identity, image: imageA });
      const name = sandboxA.id;

      await sandboxA.writeFile("/workspace/keep.txt", "persistent");
      await sandboxA.writeFile("/root/lose.txt", "ephemeral");

      // Confirm imageA is running.
      const podUidA = await coreApi.readNamespacedPod({ name, namespace }).then((p) => p.metadata?.uid);
      expect(podUidA).toBeTruthy();

      // Step 2: release (non-terminal — CR and PVC retained).
      await provider.release(name);

      // Step 3: create() with imageB — the image-drift path must roll the pod.
      const sandboxB = await provider.create({ workspace: identity, image: imageB });
      expect(sandboxB.id).toBe(name);

      // The new pod must have a different uid (it's a fresh pod object).
      const podUidB = await coreApi.readNamespacedPod({ name, namespace }).then((p) => p.metadata?.uid);
      expect(podUidB).toBeTruthy();
      expect(podUidB).not.toBe(podUidA);

      // The new pod must run imageB.
      const podSpec = await coreApi.readNamespacedPod({ name, namespace });
      const liveImage = podSpec.spec?.containers?.[0]?.image;
      expect(liveImage).toBe(imageB);

      // /workspace/keep.txt survives (PVC retained across pod roll).
      const kept = await sandboxB.readFile("/workspace/keep.txt");
      expect(kept).toBe("persistent");

      // /root/lose.txt is gone (ephemeral rootfs of the new pod).
      await expect(sandboxB.readFile("/root/lose.txt")).rejects.toThrow();

      await provider.destroy(name);
    },
    120_000,
  );

  it(
    "credsFiles → mount at /etc/valet/creds, updateCreds propagates into running pod",
    async () => {
      const identity = `creds-${randomUUID()}`;

      // Step 1: create sandbox with initial token.
      const sandbox = await provider.create({
        workspace: identity,
        image: "busybox:stable",
        credsFiles: { token: "aaa" },
      });
      const name = sandbox.id;

      try {
        // Confirm the initial token is mounted.
        const initial = await sandbox.exec("cat /etc/valet/creds/token");
        expect(initial.stdout.trim()).toBe("aaa");

        // Step 2: update the token via updateCreds.
        await provider.updateCreds(name, { token: "bbb" });

        // Step 3: poll until the kubelet propagates the updated Secret.
        // The kubelet sync period is typically 60s; allow up to 90s.
        const deadline = Date.now() + 90_000;
        let final = "";
        for (;;) {
          const r = await sandbox.exec("cat /etc/valet/creds/token");
          final = r.stdout.trim();
          if (final === "bbb") break;
          if (Date.now() >= deadline) {
            throw new Error(`creds propagation timed out after 90s; last value: ${final}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        expect(final).toBe("bbb");
      } finally {
        await provider.destroy(name);
      }
    },
    120_000,
  );
});
