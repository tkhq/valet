import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserEvent, BrowserIdentity, BrowserRequest, BrowserResponse } from "@valet/shared";
import { browserRequest } from "@valet/plugin-browser";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import {
  RANCHER_DESKTOP_CONTEXT,
  customObjectsApiAdapter,
  loadRancherDesktopKubeConfig,
  podStatusApiAdapter,
  podDeleteApiAdapter,
  podsApiAdapter,
} from "../src/lifecycle.js";
import { podExecApiAdapter } from "../src/exec.js";
import {
  KubernetesSandboxProvider,
  podLivenessApiAdapter,
} from "../src/provider.js";
import { sandboxRuntimeStateApiAdapter, runtimeStateClaimName } from "../src/runtime-state.js";
import { sweepStaleThrowawayNamespaces } from "./throwaway-namespace.js";

function kubectl(args: string[]) {
  const result = spawnSync("kubectl", ["--context", RANCHER_DESKTOP_CONTEXT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const browserImage = process.env.VALET_BROWSER_K8S_IMAGE;
const combinedDocker = process.env.VALET_BROWSER_K8S_DOCKER === "1";
const dockerRuntimeClassName = process.env.VALET_BROWSER_K8S_RUNTIME_CLASS;
const clusterReady = browserImage !== undefined &&
  kubectl(["get", "crd", "sandboxes.agents.x-k8s.io"]).status === 0 &&
  kubectl(["-n", "agent-sandbox-system", "get", "deployment", "agent-sandbox-controller"]).status === 0;

describe.skipIf(!clusterReady)(`managed browser lifecycle on Kubernetes${combinedDocker ? " with Docker companion" : ""}`, () => {
  const namespace = `valet-browser-${Date.now()}`;
  const sessionId = `browser-k8s-${randomUUID()}`;
  const workspace = `browser-workspace-${randomUUID()}`;
  const cfg = {
    namespace,
    defaultImage: browserImage as string,
    dockerRuntimeClassName,
    apiVersion: SANDBOX_CR_API_VERSION,
    browserEnabled: true,
    browserSeccompProfile: "valet/browser.json",
    browserRuntimeStorage: "256Mi",
  };
  const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const deps = {
    objectsApi: customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi)),
    podsApi: podsApiAdapter(coreApi),
    execApi: podExecApiAdapter(new k8s.Exec(kc)),
    livenessApi: podLivenessApiAdapter(coreApi),
    podStatusApi: podStatusApiAdapter(coreApi),
    podDeleteApi: podDeleteApiAdapter(coreApi),
    runtimeStateApi: sandboxRuntimeStateApiAdapter(coreApi),
  };
  const create = {
    workspace,
    sessionId,
    ...(combinedDocker ? { docker: true } : {}),
    browser: { enabled: true },
    env: { VALET_BROWSER_DEV_PORTS: "5173", VALET_SESSION_ID: sessionId },
  };
  const identity: BrowserIdentity = {
    protocolVersion: "1.0",
    sessionId,
    threadId: "fixture-thread",
    actorId: "fixture-user",
    ownerId: "fixture-user",
  };

  beforeAll(() => {
    if (combinedDocker && !dockerRuntimeClassName) throw new Error("The Docker RuntimeClass is missing. Set VALET_BROWSER_K8S_RUNTIME_CLASS before this test.");
    sweepStaleThrowawayNamespaces(kubectl);
    const created = kubectl(["create", "namespace", namespace]);
    if (created.status !== 0) throw new Error(`failed to create ${namespace}: ${created.stderr}`);
  });

  afterAll(() => {
    kubectl(["delete", "namespace", namespace, "--ignore-not-found"]);
  }, 90_000);

  it("keeps gates and profile state across restart, suspend, and replace", async () => {
    let provider = new KubernetesSandboxProvider(deps, cfg);
    let sandbox = await provider.create(create);
    const request = (body: BrowserRequest) => browserRequest(sandbox, body);

    async function startFixture() {
      const uploadHtml = '<label>Upload<input type="file" id="upload-file"></label><pre id="upload-result"></pre><script>document.getElementById("upload-file").addEventListener("change",async event=>{document.getElementById("upload-result").textContent=await event.target.files[0].text();});</script>';
      await sandbox.writeFile("fixture.cjs", `require('node:http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.setHeader('set-cookie','fixture=signed-in; Path=/; Max-Age=3600; HttpOnly');res.end('<title>'+((req.headers.cookie||'').includes('fixture=signed-in')?'Signed in':'Guest')+'</title>'+${JSON.stringify(uploadHtml)});}).listen(5173,'127.0.0.1')`);
      if (!sandbox.execJob) throw new Error("Kubernetes job execution is unavailable.");
      await sandbox.execJob("node fixture.cjs");
      await expect.poll(async () => (await sandbox.exec("node -e 'require(\"http\").get(\"http://127.0.0.1:5173\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))'" )).exitCode, { timeout: 10_000 }).toBe(0);
    }

    async function finish(invocationId: string, response: BrowserResponse) {
      const events: BrowserEvent[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        events.push(...response.events);
        for (const event of response.events) {
          if (event.type !== "approval") continue;
          const approval = event.request;
          await request({ ...identity, command: "resolve", invocationId, operationId: approval.operationId, hash: approval.hash, runtimeId: approval.runtimeId, decision: "allow", policyVersion: approval.policyVersion, expiresAt: approval.expiresAt });
        }
        if (response.cell && !["running", "awaiting_approval"].includes(response.cell.status)) {
          expect(response.cell.status).toBe("completed");
          return { response, events };
        }
        response = await request({ ...identity, command: "events", invocationId, after: response.cursor, waitMs: 1000 });
      }
      throw new Error(`Browser cell ${invocationId} did not finish.`);
    }

    try {
      if (combinedDocker) {
        const pod = await coreApi.readNamespacedPod({ namespace, name: sandbox.id });
        expect(pod.spec?.hostUsers).toBe(false);
        expect(pod.spec?.runtimeClassName).toBe(dockerRuntimeClassName);
        expect(pod.spec?.containers.find(container => container.name === "browser")?.securityContext?.seccompProfile?.type).toBe("Localhost");
        await expect.poll(async () => (await sandbox.exec("docker info >/dev/null 2>&1")).exitCode, { timeout: 30_000 }).toBe(0);
        const docker = await sandbox.exec("docker run --rm busybox:stable echo docker-browser-ok", { timeout: 60_000 });
        expect(docker.stderr).not.toContain("Operation not permitted");
        expect(docker.exitCode).toBe(0);
        expect(docker.stdout.trim()).toBe("docker-browser-ok");
        await sandbox.writeFile("workload-private.txt", "workload-only");
        expect((await sandbox.exec("test ! -e /var/lib/valet/browser", { privileged: true })).exitCode).toBe(0);
        expect((await sandbox.exec("test -f /workspace/workload-private.txt && ! touch /workspace/browser-write-test && test ! -e /var/lib/valet/home && test ! -e /etc/valet/creds && test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token && test ! -S /var/run/docker.sock", { target: "browser", privileged: true })).exitCode).toBe(0);
      }
      const writeGitConfig = () => sandbox.exec(
        "git config --global credential.helper valet-test && git config --global --get credential.helper",
      );
      const gitConfig = await writeGitConfig();
      expect(gitConfig.exitCode).toBe(0);
      expect(gitConfig.stdout.trim()).toBe("valet-test");
      await startFixture();
      const initial = await request({ ...identity, command: "status" });
      let pending = await request({ ...identity, command: "submit", invocationId: "open", title: "Open fixture", code: 'const tab=await browser.tabs.new({url:"http://localhost:5173"}); await tab.title();' });
      for (let attempt = 0; attempt < 10 && !pending.events.some((event) => event.type === "approval"); attempt++)
        pending = await request({ ...identity, command: "events", invocationId: "open", after: pending.cursor, waitMs: 1000 });
      expect(pending.events.some((event) => event.type === "approval")).toBe(true);

      provider = new KubernetesSandboxProvider(deps, cfg);
      sandbox = await provider.restore(sandbox.id);
      expect((await request({ ...identity, command: "status" })).runtimeId).toBe(initial.runtimeId);
      await finish("open", pending);

      if (combinedDocker) {
        for (const absolute of [false, true]) {
          const content = `kubernetes-upload-${absolute ? "absolute" : "relative"}-exact-bytes`;
          await sandbox.writeFile("upload.txt", content);
          const invocationId = `upload-${absolute}`;
          const uploaded = await finish(invocationId, await request({
            ...identity, command: "submit", invocationId, title: "Upload fixture bytes",
            code: `var uploadSnapshot=await tab.getAXState(); var uploadLine=uploadSnapshot.split("\\n").find(line=>line.includes('"Upload"')); var uploadRef=uploadLine?.match(/\\[ref=([^\\]]+)\\]/)?.[1]; if(!uploadRef)throw Error(uploadSnapshot); await tab.upload(uploadRef,[${JSON.stringify(absolute ? "/workspace/upload.txt" : "upload.txt")}]); await tab.playwright.getByText(${JSON.stringify(content)},{exact:true}).waitFor({state:"visible"}); await tab.getAXState();`,
          }));
          expect(uploaded.events.some(event => event.type === "text" && event.text.includes(content))).toBe(true);
        }
      }

      const poisonHome = await sandbox.exec(
        "chown -R 1501:1501 /var/lib/valet/home && chmod 0700 /var/lib/valet/home/dockerd",
        { privileged: true },
      );
      expect(poisonHome.exitCode).toBe(0);
      expect((await writeGitConfig()).exitCode).not.toBe(0);

      await request({ ...identity, audience: "lifecycle", command: "suspend" });
      await provider.suspend(sandbox.id);
      await expect.poll(() => kubectl(["-n", namespace, "get", "pod", sandbox.id]).status, { timeout: 60_000 }).not.toBe(0);
      await provider.resume(sandbox.id);
      expect((await writeGitConfig()).exitCode).toBe(0);
      await startFixture();
      const afterResume = await finish("resume-cookie", await request({ ...identity, command: "submit", invocationId: "resume-cookie", title: "Read cookie", code: 'const resumed=await browser.tabs.new({url:"http://localhost:5173"}); await resumed.title();' }));
      expect(afterResume.response.cell?.operations.some((operation) => operation.result === "Signed in")).toBe(true);

      const podUid = (await coreApi.readNamespacedPod({ namespace, name: sandbox.id })).metadata?.uid;
      await request({ ...identity, audience: "lifecycle", command: "suspend" });
      await provider.release(sandbox.id);
      sandbox = await provider.create(create);
      expect((await coreApi.readNamespacedPod({ namespace, name: sandbox.id })).metadata?.uid).not.toBe(podUid);
      await startFixture();
      const afterReplace = await finish("replace-cookie", await request({ ...identity, command: "submit", invocationId: "replace-cookie", title: "Read cookie", code: 'const replaced=await browser.tabs.new({url:"http://localhost:5173"}); await replaced.title();' }));
      expect(afterReplace.response.cell?.operations.some((operation) => operation.result === "Signed in")).toBe(true);

      await request({ ...identity, audience: "lifecycle", command: "suspend" });
      await provider.destroy(sandbox.id);
      await expect.poll(async () => {
        try {
          await coreApi.readNamespacedPersistentVolumeClaim({ namespace, name: runtimeStateClaimName(sessionId) });
          return true;
        } catch { return false; }
      }, { timeout: 60_000 }).toBe(false);
    } finally {
      await provider.destroy(sandbox.id).catch(() => {});
    }
  }, 300_000);
});
