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
import {
  cancelCommand,
  decodeUtf8HoldingTail,
  jobKickoffCommand,
  parseJobStatus,
  pollCommand,
} from "../src/jobs.js";
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

/** `pollCommand` now pipes its `tail -c +N` output through `base64 -w0`
 * (see jobs.ts's module docblock) for byte fidelity across poll
 * boundaries. `-w0` is GNU coreutils / BusyBox syntax — the version that
 * ships on macOS (BSD/FreeBSD `base64`) doesn't support it, so this file's
 * real-local-shell exercise of `pollCommand` skip-gates on it the same way
 * it already does for `setsid`. The cluster suite (`exec.cluster.test.ts`)
 * runs the identical protocol inside an actual Linux pod, which is the
 * authoritative round-trip check for this behavior. */
const hasBase64W0 = spawnSync("/bin/sh", ["-c", "printf ab | base64 -w0"], { encoding: "utf8" }).stdout === "YWI=";

/** Decodes `pollCommand`'s base64-wrapped stdout back to raw bytes and then
 * to text, holding back an incomplete trailing codepoint exactly the way
 * `pollJobInPod` does — this is the local-shell equivalent of that
 * function's real wiring. */
function decodePollStdout(base64Stdout: string): { text: string; deliveredBytes: number } {
  return decodeUtf8HoldingTail(Buffer.from(base64Stdout.trim(), "base64"));
}

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
 * exactly the way pollJobInPod does (offset advances by the number of
 * bytes `decodeUtf8HoldingTail` actually delivered, not the raw base64
 * fetch length). */
async function pollToCompletion(execId: string, deadlineMs = 5000): Promise<{ output: string; exitCode?: number }> {
  let offset = 0;
  let output = "";
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = sh(pollCommand(execId, offset));
    expect(result.status).toBe(0);
    const { status, exitCode } = parseJobStatus(result.stderr);
    const { text, deliveredBytes } = decodePollStdout(result.stdout);
    output += text;
    offset += deliveredBytes;
    if (status === "done") return { output, exitCode };
    if (status === "failed") throw new Error(`job ${execId} reported failed/unknown`);
    if (Date.now() > deadline) throw new Error(`job ${execId} did not complete within ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// pollCommand's own logic (tail -c +N offset math, exit-file detection,
// unknown-execId marker) doesn't involve setsid at all — these run
// everywhere GNU/BusyBox base64 -w0 is available (see hasBase64W0),
// seeding the .out/.exit files directly rather than via jobKickoffCommand.
describe.skipIf(!hasBase64W0)("pollCommand against manually-seeded job files (no setsid dependency)", () => {
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
    const firstDecoded = decodePollStdout(first.stdout);
    expect(firstDecoded.text).toBe("hello ");
    expect(parseJobStatus(first.stderr)).toEqual({ status: "running" });

    await writeFile(`${JOBS_DIR}/${execId}.out`, "hello world", { flag: "w" });
    const secondOffset = firstDecoded.deliveredBytes;
    const second = sh(pollCommand(execId, secondOffset));
    const secondDecoded = decodePollStdout(second.stdout);
    expect(secondDecoded.text).toBe("world");
    expect(parseJobStatus(second.stderr)).toEqual({ status: "running" });

    await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
    const third = sh(pollCommand(execId, secondOffset + secondDecoded.deliveredBytes));
    expect(decodePollStdout(third.stdout).text).toBe("");
    expect(parseJobStatus(third.stderr)).toEqual({ status: "done", exitCode: 0 });
  });

  it("re-polling at the current end offset never re-delivers bytes", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    const content = "abcdefgh";
    await writeFile(`${JOBS_DIR}/${execId}.out`, content);
    const result = sh(pollCommand(execId, Buffer.byteLength(content, "utf8")));
    expect(decodePollStdout(result.stdout).text).toBe("");
  });

  it("holds back a codepoint split mid-emoji across two writes/polls and reassembles losslessly (AB\\u{1F680}CD)", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    const full = Buffer.from("AB\u{1F680}CD", "utf8");
    // Write only "AB" + the first 2 bytes of the 4-byte emoji sequence —
    // the file itself ends mid-codepoint, exactly the reviewer's repro.
    await writeFile(`${JOBS_DIR}/${execId}.out`, full.subarray(0, 4));

    const first = sh(pollCommand(execId, 0));
    const firstDecoded = decodePollStdout(first.stdout);
    expect(firstDecoded.text).toBe("AB");
    expect(firstDecoded.deliveredBytes).toBe(2);

    // Complete the file; poll again from the held-back offset.
    await writeFile(`${JOBS_DIR}/${execId}.out`, full);
    const second = sh(pollCommand(execId, firstDecoded.deliveredBytes));
    const secondDecoded = decodePollStdout(second.stdout);
    expect(secondDecoded.text).toBe("\u{1F680}CD");

    expect(firstDecoded.text + secondDecoded.text).toBe("AB\u{1F680}CD");
  });
});

describe.skipIf(!hasSetsid || !hasBase64W0)("job-mode shell protocol against a real local shell", () => {
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
    expect(decodePollStdout(after.stdout).text).toBe("");
  }, 10_000);

  it("captures a non-zero exit code as a normal 'done', not a failure", async () => {
    const execId = newExecId();
    sh(jobKickoffCommand(execId, "echo boom 1>&2; exit 5"));
    const { exitCode, output } = await pollToCompletion(execId);
    expect(exitCode).toBe(5);
    expect(output).toBe("boom\n"); // stderr merged into .out via 2>&1
  }, 10_000);

  it("emits multibyte output slowly across two writes and reassembles losslessly when polled at tight offsets", async () => {
    const execId = newExecId();
    // Rocket emoji (F0 9F 9A 80) written as two separate printfs with a
    // pause between them, so a poll landing in that window sees the file
    // mid-codepoint — the live version of the AB\u{1F680}CD repro, driven
    // by real timing instead of manually seeding the .out file.
    const kickoff = sh(
      jobKickoffCommand(
        execId,
        "printf hi; printf '\\xf0\\x9f'; sleep 0.3; printf '\\x9a\\x80'; printf END",
      ),
    );
    expect(kickoff.status).toBe(0);

    let offset = 0;
    let output = "";
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = sh(pollCommand(execId, offset));
      const { status } = parseJobStatus(result.stderr);
      const { text, deliveredBytes } = decodePollStdout(result.stdout);
      output += text;
      offset += deliveredBytes;
      if (status === "done") break;
      if (status === "failed") throw new Error(`job ${execId} reported failed/unknown`);
      if (Date.now() > deadline) throw new Error(`job ${execId} did not complete within deadline`);
      await new Promise((resolve) => setTimeout(resolve, 20)); // tight poll interval to try to land mid-codepoint
    }
    expect(output).toBe("hi\u{1F680}END");
  }, 10_000);

  it("cancelCommand kills a running job immediately after kickoff returns — zero-delay, no pidfile race", async () => {
    const execId = newExecId();
    const kickoff = sh(jobKickoffCommand(execId, "sleep 30; echo should-not-appear"));
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout.trim()).toBe("started");

    // No sleep here: jobKickoffCommand's own wait-for-pidfile loop already
    // guarantees the .pid file exists by the time `sh()` (spawnSync, which
    // blocks until the whole script — including that loop — exits)
    // returns. Cancel must work immediately.
    const cancel = sh(cancelCommand(execId));
    expect(cancel.status).toBe(0);

    const poll = sh(pollCommand(execId, 0));
    const status = parseJobStatus(poll.stderr);
    expect(status.status).toBe("done");
    expect(status.exitCode).not.toBe(0); // killed, not a clean exit
    expect(decodePollStdout(poll.stdout).text).not.toContain("should-not-appear");
  }, 10_000);
});
