/**
 * Runs the actual job-mode shell protocol (jobKickoffCommand / pollCommand /
 * cancelCommand) against a REAL local `/bin/sh`, writing into the real
 * `/tmp/valet-jobs` directory on the dev/CI machine — no Kubernetes cluster
 * involved. This is the thing pure string-matching unit tests on the
 * command builders can't catch: whether the composed shell script actually
 * *parses and runs correctly* (nested quoting, the `( ... ) &` grouping,
 * `setsid` availability, `tail -c +N` semantics). `exec.cluster.test.ts`
 * repeats the same shape of assertions against a real pod's exec transport;
 * this file is the fast, always-on complement that doesn't depend on the
 * cluster gate.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { cancelCommand, jobKickoffCommand, parseJobStatus, pollCommand } from "../src/jobs.js";
import { JOBS_DIR } from "../src/exec.js";

function sh(command: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** `setsid` (util-linux) is what `jobKickoffCommand` uses to give the job
 * its own process group for cancelJob's group-kill. It ships with every
 * Linux base (including busybox — the image the cluster suite targets —
 * and Debian, the eventual sandbox image), which is all that matters for
 * the real cluster path. It is NOT present on macOS/BSD dev machines,
 * so this file's real-local-shell exercise (as opposed to
 * exec.cluster.test.ts, which runs the identical protocol inside an
 * actual Linux pod) skip-gates on it rather than failing dev/CI runs on a
 * Mac. */
const hasSetsid = spawnSync("setsid", ["--version"], { stdio: "ignore" }).status === 0;

const execIds: string[] = [];
function newExecId(): string {
  const id = `local-${randomUUID()}`;
  execIds.push(id);
  return id;
}

afterEach(async () => {
  for (const id of execIds.splice(0)) {
    await rm(`${JOBS_DIR}/${id}.out`, { force: true });
    await rm(`${JOBS_DIR}/${id}.exit`, { force: true });
    await rm(`${JOBS_DIR}/${id}.pid`, { force: true });
  }
});

/** Polls until parseJobStatus reports a terminal state, accumulating output
 * exactly the way pollJobInPod does (offset advances by byte length of each
 * chunk received). */
async function pollToCompletion(execId: string, deadlineMs = 5000): Promise<{ output: string; exitCode?: number }> {
  let offset = 0;
  let output = "";
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = sh(pollCommand(execId, offset));
    expect(result.status).toBe(0);
    const { status, exitCode } = parseJobStatus(result.stderr);
    output += result.stdout;
    offset += Buffer.byteLength(result.stdout, "utf8");
    if (status === "done") return { output, exitCode };
    if (status === "failed") throw new Error(`job ${execId} reported failed/unknown`);
    if (Date.now() > deadline) throw new Error(`job ${execId} did not complete within ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// pollCommand's own logic (tail -c +N offset math, exit-file detection,
// unknown-execId marker) doesn't involve setsid at all — these run
// everywhere (including macOS dev machines), seeding the .out/.exit files
// directly rather than via jobKickoffCommand.
describe("pollCommand against manually-seeded job files (no setsid dependency)", () => {
  it("reports 'unknown' (failed) for an execId that was never started", () => {
    const result = sh(pollCommand("never-started-anything", 0));
    expect(result.status).toBe(0);
    expect(parseJobStatus(result.stderr)).toEqual({ status: "failed" });
  });

  it("reads output incrementally by byte offset and reports running while no .exit file exists", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.out`, "hello ");

    const first = sh(pollCommand(execId, 0));
    expect(first.stdout).toBe("hello ");
    expect(parseJobStatus(first.stderr)).toEqual({ status: "running" });

    await writeFile(`${JOBS_DIR}/${execId}.out`, "hello world", { flag: "w" });
    const secondOffset = Buffer.byteLength("hello ", "utf8");
    const second = sh(pollCommand(execId, secondOffset));
    expect(second.stdout).toBe("world");
    expect(parseJobStatus(second.stderr)).toEqual({ status: "running" });

    await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
    const third = sh(pollCommand(execId, secondOffset + Buffer.byteLength("world", "utf8")));
    expect(third.stdout).toBe("");
    expect(parseJobStatus(third.stderr)).toEqual({ status: "done", exitCode: 0 });
  });

  it("re-polling at the current end offset never re-delivers bytes", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    const content = "abcdefgh";
    await writeFile(`${JOBS_DIR}/${execId}.out`, content);
    const result = sh(pollCommand(execId, Buffer.byteLength(content, "utf8")));
    expect(result.stdout).toBe("");
  });
});

describe.skipIf(!hasSetsid)("job-mode shell protocol against a real local shell", () => {
  it("kickoff -> poll (partial reads across the boundary) -> completion, exit 0", async () => {
    const execId = newExecId();
    const kickoff = sh(jobKickoffCommand(execId, "echo first; sleep 0.3; echo second"));
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout.trim()).toBe("started");

    // Poll immediately — before "second" has been written — to prove a
    // partial read mid-job is a normal "running" poll, not an error.
    const early = sh(pollCommand(execId, 0));
    expect(early.status).toBe(0);
    const earlyStatus = parseJobStatus(early.stderr);
    expect(["running", "done"]).toContain(earlyStatus.status);

    const { output, exitCode } = await pollToCompletion(execId);
    expect(output).toBe("first\nsecond\n");
    expect(exitCode).toBe(0);

    // Re-polling at the final offset must not re-deliver any bytes.
    const finalOffset = Buffer.byteLength(output, "utf8");
    const after = sh(pollCommand(execId, finalOffset));
    expect(after.stdout).toBe("");
  }, 10_000);

  it("captures a non-zero exit code as a normal 'done', not a failure", async () => {
    const execId = newExecId();
    sh(jobKickoffCommand(execId, "echo boom 1>&2; exit 5"));
    const { exitCode, output } = await pollToCompletion(execId);
    expect(exitCode).toBe(5);
    expect(output).toBe("boom\n"); // stderr merged into .out via 2>&1
  }, 10_000);

  it("cancelCommand kills a running job and its status becomes terminal", async () => {
    const execId = newExecId();
    const kickoff = sh(jobKickoffCommand(execId, "sleep 30; echo should-not-appear"));
    expect(kickoff.status).toBe(0);

    // Let the pid file actually get written before we try to cancel.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const cancel = sh(cancelCommand(execId));
    expect(cancel.status).toBe(0);

    const poll = sh(pollCommand(execId, 0));
    const status = parseJobStatus(poll.stderr);
    expect(status.status).toBe("done");
    expect(status.exitCode).not.toBe(0); // killed, not a clean exit
    expect(poll.stdout).not.toContain("should-not-appear");
  }, 10_000);
});
