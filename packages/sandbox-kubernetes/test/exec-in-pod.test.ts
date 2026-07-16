/**
 * `execInPod`'s stitching logic (stdout/stderr capture, exit status
 * plumbing, timeout/abort force-close, maxOutputBytes truncation) tested
 * against a fake `PodExecApi` — no cluster needed. The fake plays the same
 * role `FakeCustomObjectsApi` plays for lifecycle.test.ts: an honest
 * in-memory stand-in for the one method (`Exec.exec`) this module actually
 * calls.
 */
import { describe, expect, it } from "vitest";
import { execInPod, type ExecDeps, type ExecStatus, type PodExecApi, type PodExecSocket } from "../src/exec.js";

interface ExecCall {
  namespace: string;
  podName: string;
  containerName: string;
  command: string[];
}

/** Fake transport: instead of a real WebSocket, `run` synchronously (or
 * after a tick) writes bytes to the stdout/stderr streams `execInPod`
 * handed it and invokes the status callback — mirroring what the real
 * `Exec.exec`'s binaryHandler does per frame, just without an actual
 * socket. */
class FakePodExecApi implements PodExecApi {
  calls: ExecCall[] = [];
  closed = 0;

  constructor(
    private readonly run: (
      stdout: NodeJS.WritableStream | null,
      stderr: NodeJS.WritableStream | null,
      statusCallback?: (status: ExecStatus) => void,
    ) => void,
  ) {}

  async exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[],
    stdout: NodeJS.WritableStream | null,
    stderr: NodeJS.WritableStream | null,
    _stdin: NodeJS.ReadableStream | null,
    _tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<PodExecSocket> {
    this.calls.push({ namespace, podName, containerName, command });
    this.run(stdout, stderr, statusCallback);
    return { close: () => { this.closed++; } };
  }
}

const deps = (api: PodExecApi): ExecDeps => ({ api, namespace: "ns", containerName: "sandbox" });

describe("execInPod", () => {
  it("separates stdout/stderr and reports exit code from the status channel", async () => {
    const api = new FakePodExecApi((stdout, stderr, statusCallback) => {
      stdout?.write("out-line\n");
      stderr?.write("err-line\n");
      statusCallback?.({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "3" }] } });
    });
    const result = await execInPod(deps(api), "pod-1", "echo out-line; echo err-line 1>&2; exit 3");
    expect(result.stdout).toBe("out-line\n");
    expect(result.stderr).toBe("err-line\n");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBeUndefined();
  });

  it("wraps the command as /bin/sh -c <shellCommand>", async () => {
    const api = new FakePodExecApi((_o, _e, statusCallback) => statusCallback?.({ status: "Success" }));
    await execInPod(deps(api), "pod-1", "echo hi", { cwd: "workdir" });
    expect(api.calls[0].command[0]).toBe("/bin/sh");
    expect(api.calls[0].command[1]).toBe("-c");
    expect(api.calls[0].command[2]).toContain("echo hi");
    expect(api.calls[0].command[2]).toContain("workdir");
  });

  it("reports exit code 0 on Success", async () => {
    const api = new FakePodExecApi((_o, _e, statusCallback) => statusCallback?.({ status: "Success" }));
    const result = await execInPod(deps(api), "pod-1", "true");
    expect(result.exitCode).toBe(0);
  });

  it("truncates stdout at maxOutputBytes and marks the result truncated", async () => {
    const api = new FakePodExecApi((stdout, _e, statusCallback) => {
      stdout?.write("x".repeat(1000));
      statusCallback?.({ status: "Success" });
    });
    const result = await execInPod(deps(api), "pod-1", "yes x", { maxOutputBytes: 100 });
    expect(result.stdout.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("force-closes the socket and reports timedOut when the status never arrives", async () => {
    const api = new FakePodExecApi((stdout) => {
      stdout?.write("partial");
      // never call statusCallback — simulates a hung command
    });
    const result = await execInPod(deps(api), "pod-1", "sleep 999", { timeout: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial");
    expect(api.closed).toBe(1);
  }, 2000);

  it("force-closes the socket on abort signal", async () => {
    const api = new FakePodExecApi(() => {
      // never resolves status — simulates a long-running command
    });
    const controller = new AbortController();
    const promise = execInPod(deps(api), "pod-1", "sleep 999", { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(api.closed).toBe(1);
    expect(result.timedOut).toBeUndefined();
  }, 2000);
});
