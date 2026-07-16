/**
 * Live-cluster exercise of exec.ts/files.ts/jobs.ts against the vendored
 * agent-sandbox v0.5.1 controller on Rancher Desktop k3s — same skip-gate
 * and context-safety posture as lifecycle.cluster.test.ts (decision 2,
 * BINDING: every client-node call goes through `loadRancherDesktopKubeConfig`;
 * nothing here ever touches the ambient current-context).
 *
 * ONE Sandbox is provisioned in `beforeAll` and reused for the whole file
 * (per the task brief) rather than one per `it` — exec/file-ops/job-mode
 * round trips don't need isolation from each other the way lifecycle's
 * create/destroy semantics do, and standing up a fresh pod per test would
 * make this suite (already ~30s+ for the pod to go Ready) prohibitively
 * slow. `afterAll` tears the Sandbox + throwaway namespace down
 * finally-safe.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SANDBOX_CR_API_VERSION, SANDBOX_CONTAINER_NAME, buildSandboxManifest } from "../src/index.js";
import type { K8sProviderConfig } from "../src/index.js";
import {
  RANCHER_DESKTOP_CONTEXT,
  applySandbox,
  customObjectsApiAdapter,
  deleteSandbox,
  loadRancherDesktopKubeConfig,
  podsApiAdapter,
  resolvePodName,
  sandboxStatus,
} from "../src/lifecycle.js";
import { execInPod, podExecApiAdapter, type ExecDeps } from "../src/exec.js";
import {
  mkdirInPod,
  readBinaryInPod,
  readFileInPod,
  readdirInPod,
  rmInPod,
  statInPod,
  writeBinaryInPod,
  writeFileInPod,
} from "../src/files.js";
import { cancelJobInPod, execJobInPod, pollJobInPod } from "../src/jobs.js";

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

describe.skipIf(!isClusterReady)("exec/files/jobs (live rancher-desktop cluster)", () => {
  const namespace = `valet-sbx-exec-${Date.now()}`;
  const sandboxName = "exec-e2e";
  const cfg: K8sProviderConfig = {
    namespace,
    defaultImage: "busybox:stable",
    apiVersion: SANDBOX_CR_API_VERSION,
  };
  let deps: ExecDeps;
  let podName: string;
  let nextJobId = 1;

  beforeAll(async () => {
    const created = kubectl(["create", "namespace", namespace]);
    if (created.status !== 0) {
      throw new Error(`failed to create throwaway namespace "${namespace}": ${created.stderr}`);
    }
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
    const podsApi = podsApiAdapter(kc.makeApiClient(k8s.CoreV1Api));

    const manifest = buildSandboxManifest(cfg, sandboxName, { image: "busybox:stable" });
    await applySandbox(objectsApi, cfg, manifest);

    let status = await sandboxStatus(objectsApi, cfg, sandboxName);
    const deadline = Date.now() + 30_000;
    while (status.state !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = await sandboxStatus(objectsApi, cfg, sandboxName);
    }
    expect(status.state).toBe("ready");

    const resolved = await resolvePodName(objectsApi, podsApi, cfg, sandboxName);
    if (!resolved) throw new Error("resolvePodName returned null for a Ready sandbox");
    podName = resolved;

    const execApi = podExecApiAdapter(new k8s.Exec(kc));
    deps = { api: execApi, namespace, containerName: SANDBOX_CONTAINER_NAME };
  }, 60_000);

  afterAll(async () => {
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
    try {
      await deleteSandbox(objectsApi, cfg, sandboxName);
    } finally {
      kubectl(["delete", "namespace", namespace, "--ignore-not-found"]);
    }
  }, 90_000);

  // ── exec ───────────────────────────────────────────────────────────

  it("exec reports exit codes 0, 7, and 127 correctly", async () => {
    const ok = await execInPod(deps, podName, "true");
    expect(ok.exitCode).toBe(0);

    const custom = await execInPod(deps, podName, "exit 7");
    expect(custom.exitCode).toBe(7);

    const notFound = await execInPod(deps, podName, "this-command-does-not-exist-anywhere");
    expect(notFound.exitCode).toBe(127);
  });

  it("exec separates stdout and stderr", async () => {
    const result = await execInPod(deps, podName, "echo out-line; echo err-line 1>&2");
    expect(result.stdout).toBe("out-line\n");
    expect(result.stderr).toBe("err-line\n");
    expect(result.exitCode).toBe(0);
  });

  it("exec honors a cwd override", async () => {
    await mkdirInPod(deps, podName, "/workspace/cwd-test");
    await writeFileInPod(deps, podName, "/workspace/cwd-test/marker.txt", "here");
    const result = await execInPod(deps, podName, "cat marker.txt", { cwd: "/workspace/cwd-test" });
    expect(result.stdout).toBe("here");
    expect(result.exitCode).toBe(0);
  });

  it("exec times out and force-closes without hanging the test", async () => {
    const start = Date.now();
    const result = await execInPod(deps, podName, "sleep 30", { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);

  // ── files ──────────────────────────────────────────────────────────

  it("binary round-trip: random 1MB buffer is byte-identical after write -> read", async () => {
    const original = randomBytes(1024 * 1024);
    await writeBinaryInPod(deps, podName, "/workspace/random.bin", new Uint8Array(original));
    const readBack = await readBinaryInPod(deps, podName, "/workspace/random.bin");
    expect(Buffer.from(readBack).equals(original)).toBe(true);
  }, 30_000);

  it("text file round-trip: newlines, quotes, and unicode survive exactly", async () => {
    const content = "line one\nline 'two' with \"quotes\"\nline three: \u{1F680} éèê\ntab\there\n";
    await writeFileInPod(deps, podName, "/workspace/text.txt", content);
    const readBack = await readFileInPod(deps, podName, "/workspace/text.txt");
    expect(readBack).toBe(content);
  });

  it("readdir lists created entries, no ./.. and no directory-listing artifacts", async () => {
    await mkdirInPod(deps, podName, "/workspace/rddir");
    await writeFileInPod(deps, podName, "/workspace/rddir/a.txt", "a");
    await writeFileInPod(deps, podName, "/workspace/rddir/b.txt", "b");
    const entries = await readdirInPod(deps, podName, "/workspace/rddir");
    expect([...entries].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("stat distinguishes file vs directory and reports file size", async () => {
    await mkdirInPod(deps, podName, "/workspace/statdir");
    await writeFileInPod(deps, podName, "/workspace/statdir/file.txt", "12345");
    const fileStat = await statInPod(deps, podName, "/workspace/statdir/file.txt");
    expect(fileStat).toEqual({ isFile: true, isDirectory: false, size: 5 });
    const dirStat = await statInPod(deps, podName, "/workspace/statdir");
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);
  });

  it("rm with recursive removes a directory tree", async () => {
    await mkdirInPod(deps, podName, "/workspace/rmdir/nested");
    await writeFileInPod(deps, podName, "/workspace/rmdir/nested/f.txt", "x");
    await rmInPod(deps, podName, "/workspace/rmdir", { recursive: true });
    await expect(readdirInPod(deps, podName, "/workspace/rmdir")).rejects.toThrow();
  });

  // ── job-mode ───────────────────────────────────────────────────────

  it("execJob -> pollJob (partial-offset reads) -> completion with exitCode 0", async () => {
    const execId = `job-${nextJobId++}`;
    await execJobInPod(deps, podName, execId, "echo job-output; sleep 0.5; echo more-output");

    let offset = 0;
    let combined = "";
    let status: "running" | "done" | "failed" = "running";
    let exitCode: number | undefined;
    for (let i = 0; i < 100 && status === "running"; i++) {
      const poll = await pollJobInPod(deps, podName, execId, offset);
      combined += poll.output;
      offset = poll.nextOffset;
      status = poll.status;
      exitCode = poll.exitCode;
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe("done");
    expect(exitCode).toBe(0);
    expect(combined).toBe("job-output\nmore-output\n");

    const after = await pollJobInPod(deps, podName, execId, offset);
    expect(after.output).toBe("");
  }, 20_000);

  it("execJob captures a non-zero exit as a normal 'done', not a failure", async () => {
    const execId = `job-${nextJobId++}`;
    await execJobInPod(deps, podName, execId, "exit 9");

    let poll = await pollJobInPod(deps, podName, execId, 0);
    for (let i = 0; i < 50 && poll.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      poll = await pollJobInPod(deps, podName, execId, poll.nextOffset);
    }
    expect(poll.status).toBe("done");
    expect(poll.exitCode).toBe(9);
  }, 15_000);

  it("cancelJob stops a running job immediately after execJob returns — zero delay, no pidfile race", async () => {
    const execId = `job-${nextJobId++}`;
    await execJobInPod(deps, podName, execId, "sleep 30; echo should-not-appear");
    // No delay: jobKickoffCommand's own wait-for-pidfile loop (see jobs.ts)
    // guarantees the .pid file exists by the time execJobInPod's single
    // exec call resolves, so cancelJob is safe to call the instant
    // execJob returns — this is the fix for the cancelJob-before-pidfile
    // race, exercised against the real cluster instead of a busy-wait
    // sleep crutch.
    await cancelJobInPod(deps, podName, execId);

    const poll = await pollJobInPod(deps, podName, execId, 0);
    expect(poll.status).toBe("done");
    expect(poll.exitCode).not.toBe(0);
    expect(poll.output).not.toContain("should-not-appear");
  }, 15_000);

  // Task-9 whole-phase review, DEFECT 1: cancelCommand's process-group kill
  // used `kill -KILL -- -"$pid"`, which dash's builtin `kill` (the real
  // `/bin/sh` on the Debian-slim sandbox image — this pod's `busybox:stable`
  // image also matters here, exercised below) rejects outright, silently
  // degrading to killing only the setsid leader and orphaning the job's
  // real child. The test above only asserts poll()'s reported exit code —
  // it can't see a leaked child that the *pod's own kernel* is still
  // running. This test execs directly into the pod after cancelJob and
  // greps the live process table for the job's marker command, which is
  // the only way to actually prove the child is gone.
  it("cancelJob actually reaps the job's child process in the pod — not just the setsid leader (DEFECT 1)", async () => {
    const execId = `job-${nextJobId++}`;
    // A distinctive sleep DURATION, not a shell comment, is the marker:
    // `sh -c` strips comments before exec'ing, so a trailing `# marker`
    // never reaches the child's own argv — pgrep -f matches process
    // argv/cmdline, not the shell source that spawned it. A random,
    // per-test-unique duration is what actually shows up in `ps`/`pgrep`.
    const marker = `sleep 8${randomBytes(2).readUInt16BE(0) % 1000}`;
    await execJobInPod(deps, podName, execId, marker);

    const beforeCancel = await execInPod(deps, podName, `pgrep -f ${JSON.stringify(marker)}`);
    expect(beforeCancel.stdout.trim().length).toBeGreaterThan(0); // sanity: it's actually running

    const start = Date.now();
    await cancelJobInPod(deps, podName, execId);
    const elapsedMs = Date.now() - start;

    const afterCancel = await execInPod(deps, podName, `pgrep -f ${JSON.stringify(marker)}`);
    // pgrep exits 1 (no matches) once the child is gone; stdout is empty.
    expect(afterCancel.stdout.trim()).toBe("");
    expect(afterCancel.exitCode).toBe(1);
    // cancelCommand's own poll-for-EXIT loop caps at ~3s; a prompt kill
    // should resolve well under that.
    expect(elapsedMs).toBeLessThan(2000);
  }, 15_000);

  // Task-9 whole-phase review, DEFECT 2: the output-cap change moved
  // `echo $? > EXIT` inside the killed process group for capped jobs (the
  // shape every real job actually uses, since PolicySandbox always sets
  // maxOutputBytes) — on cancel, EXIT never got written, and
  // cancelJob's poll-for-EXIT loop spun its full ~3s budget. There was no
  // capped-cancel test at all before this fix.
  it("cancelJob stops a CAPPED job promptly too — the job's real child is reaped and EXIT appears without spinning the poll budget (DEFECT 2)", async () => {
    const execId = `job-${nextJobId++}`;
    const marker = `sleep 8${randomBytes(2).readUInt16BE(0) % 1000}`;
    await execJobInPod(deps, podName, execId, marker, { maxOutputBytes: 1024 });

    const beforeCancel = await execInPod(deps, podName, `pgrep -f ${JSON.stringify(marker)}`);
    expect(beforeCancel.stdout.trim().length).toBeGreaterThan(0);

    const start = Date.now();
    await cancelJobInPod(deps, podName, execId);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000); // not the ~3s pre-fix spin

    const afterCancel = await execInPod(deps, podName, `pgrep -f ${JSON.stringify(marker)}`);
    expect(afterCancel.stdout.trim()).toBe("");
    expect(afterCancel.exitCode).toBe(1);

    const poll = await pollJobInPod(deps, podName, execId, 0);
    expect(poll.status).toBe("done");
    expect(poll.exitCode).not.toBe(0);
  }, 15_000);

  it("reassembles multibyte output losslessly when polled at tight offsets across a mid-codepoint write boundary", async () => {
    const execId = `job-${nextJobId++}`;
    // Rocket emoji (\xF0\x9F\x9A\x80, 4 bytes) written as two separate
    // printfs with a pause between them, so a poll landing in that 300ms
    // window sees the job's .out file mid-codepoint — the live-cluster
    // version of the AB\u{1F680}CD boundary repro (jobs-framing.test.ts /
    // jobs-local-protocol.test.ts cover the same case without a cluster).
    await execJobInPod(
      deps,
      podName,
      execId,
      "printf hi; printf '\\xf0\\x9f'; sleep 0.3; printf '\\x9a\\x80'; printf END",
    );

    let offset = 0;
    let output = "";
    let status: "running" | "done" | "failed" = "running";
    for (let i = 0; i < 100 && status === "running"; i++) {
      const poll = await pollJobInPod(deps, podName, execId, offset);
      output += poll.output;
      offset = poll.nextOffset;
      status = poll.status;
      // Tight poll interval — well under the 300ms gap between the two
      // printfs — to maximize the chance a poll actually lands mid-write.
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe("done");
    expect(output).toBe("hi\u{1F680}END");
  }, 20_000);

  it("execJob honors maxOutputBytes — a job emitting more than the cap is truncated to the cap, matching sandbox-docker's execJob cap semantics", async () => {
    const execId = `job-${nextJobId++}`;
    await execJobInPod(
      deps,
      podName,
      execId,
      "yes x | head -c 2000 | tr -d '\\n'; printf ''; exit 0",
      { maxOutputBytes: 200 },
    );

    let offset = 0;
    let output = "";
    let status: "running" | "done" | "failed" = "running";
    let exitCode: number | undefined;
    for (let i = 0; i < 100 && status === "running"; i++) {
      const poll = await pollJobInPod(deps, podName, execId, offset);
      output += poll.output;
      offset = poll.nextOffset;
      status = poll.status;
      exitCode = poll.exitCode;
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe("done");
    // Clean exit — the capping filter's trailing `cat > /dev/null` drains
    // (rather than SIGPIPE-killing) output past the cap, so the job runs
    // to its own `exit 0`, not a signal-shaped termination.
    expect(exitCode).toBe(0);
    expect(output).toBe("x".repeat(200));
    expect(output.length).toBe(200);
  }, 20_000);
});
