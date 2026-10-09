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
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelCommand,
  decodeUtf8HoldingTail,
  execJobInPod,
  jobKickoffCommand,
  parseJobStatus,
  pollCommand,
  pollJobInPod,
} from "../src/jobs.js";
import { JOBS_DIR, type ExecDeps, type ExecStatus, type PodExecApi, type PodExecSocket } from "../src/exec.js";

function sh(command: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** True if any process on the machine still belongs to process group
 * `pgid` — the direct DEFECT 1 repro check: cancelCommand's old
 * `kill -KILL -- -"$pid"` was rejected by dash's builtin `kill` ("Illegal
 * number: -"), fell through to killing only the setsid leader, and left the
 * job's real child (e.g. the `sleep` process itself, forked by the exec'd
 * `sh -c 'sleep N'`, distinct from the leader's own pid — see this file's
 * "actually reaps" test) running under `pgid` indefinitely. */
function pgidStillAlive(pgid: number): boolean {
  const r = spawnSync("ps", ["-eo", "pid,pgid,args"], { encoding: "utf8" });
  return r.stdout
    .split("\n")
    .slice(1) // header row
    .some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols.length >= 2 && Number(cols[1]) === pgid;
    });
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
        "printf hi; printf '\\360\\237'; sleep 0.3; printf '\\232\\200'; printf END",
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

  it("maxOutputBytes caps accumulated output at the limit — a job emitting more than the cap is truncated, matching docker's execJob cap semantics", async () => {
    const execId = newExecId();
    // Emit 500 bytes of 'x' but cap at 100 — the .out file (and therefore
    // everything pollToCompletion can ever read) must never exceed 100
    // bytes, and the job must still exit cleanly (0), not be SIGPIPE-killed
    // by the capping filter.
    const kickoff = sh(jobKickoffCommand(execId, "yes x | head -c 500 | tr -d '\\n'; printf ''; exit 0", 100));
    expect(kickoff.status).toBe(0);

    const { output, exitCode } = await pollToCompletion(execId);
    // The cap keeps the first 100 bytes and then appends one marker line
    // (fix wave 3, k8s M-B), so a tail read shows the log stopped there.
    expect(output).toBe(`${"x".repeat(100)}\n[valet: log capped at 100 bytes; later output dropped]\n`);
    expect(exitCode).toBe(0);
  }, 10_000);

  it("maxOutputBytes does not kill a slow producer early — the job keeps running to its natural exit past the cap", async () => {
    const execId = newExecId();
    // Two writes straddling the cap (60 + 60 = 120 bytes into a 50-byte
    // cap), with a real command *after* the point where the cap is
    // exceeded — if the capping filter SIGPIPE'd the job, this trailing
    // `echo done-marker` would never run and the exit code would be
    // signal-shaped instead of the clean 0 from `exit 0`.
    const kickoff = sh(
      jobKickoffCommand(
        execId,
        "printf '%060d' 1; sleep 0.1; printf '%060d' 2; echo done-marker; exit 0",
        50,
      ),
    );
    expect(kickoff.status).toBe(0);

    const { output, exitCode } = await pollToCompletion(execId);
    expect(output.length).toBe(50);
    expect(exitCode).toBe(0); // clean exit, not signal-killed by a broken pipe
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

  // DEFECT 1's actual repro: the pid recorded in `.pid` is the setsid
  // LEADER (the `sh -c 'sleep 30'` shell that `exec sh -c innerCommand`
  // replaced), but dash forks a distinct CHILD process to run `sleep 30`
  // itself (dash does not tail-call-optimize a single simple command inside
  // `sh -c`) — so a group-kill that silently degrades to killing only the
  // leader (the old `kill -KILL -- -"$pid"` behavior under dash) leaves
  // that child running under the same pgid, invisible to a naive "is the
  // recorded pid still alive" check.
  it("cancelCommand reaps the job's ACTUAL child process, not just the setsid leader — DEFECT 1 repro", async () => {
    const execId = newExecId();
    const kickoff = sh(jobKickoffCommand(execId, "sleep 30"));
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout.trim()).toBe("started");

    const pgidText = await readFile(`${JOBS_DIR}/${execId}.pid`, "utf8");
    const pgid = Number(pgidText.trim());
    expect(Number.isInteger(pgid)).toBe(true);
    // Sanity: the group must actually be alive before we cancel it, else
    // the "gone after cancel" assertion below would be vacuously true.
    expect(pgidStillAlive(pgid)).toBe(true);

    const cancel = sh(cancelCommand(execId));
    expect(cancel.status).toBe(0);

    expect(pgidStillAlive(pgid)).toBe(false);
  }, 10_000);

  it("cancelCommand writes EXIT promptly for a CAPPED job too — DEFECT 2 repro (the F1 output-cap change moved the exit-code write inside the killed group; a fifo moves it back outside)", async () => {
    const execId = newExecId();
    const kickoff = sh(jobKickoffCommand(execId, "sleep 30", 1024));
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout.trim()).toBe("started");

    const start = Date.now();
    const cancel = sh(cancelCommand(execId));
    const elapsedMs = Date.now() - start;
    expect(cancel.status).toBe(0);
    // cancelCommand's own poll-for-EXIT loop is 10 * 300ms = up to 3s if
    // EXIT never appears. A prompt write (the fix) should resolve in well
    // under one poll cycle; generous margin against CI jitter.
    expect(elapsedMs).toBeLessThan(1000);

    const poll = sh(pollCommand(execId, 0));
    const status = parseJobStatus(poll.stderr);
    expect(status.status).toBe("done");
    expect(status.exitCode).not.toBe(0);
  }, 10_000);
});

/** Runs `execInPod`'s composed command on the local `/bin/sh`, so
 * `pollJobInPod` parses real shell output without a cluster. */
class LocalShellPodExecApi implements PodExecApi {
  async exec(
    _namespace: string,
    _podName: string,
    _containerName: string,
    command: string[],
    stdout: NodeJS.WritableStream | null,
    stderr: NodeJS.WritableStream | null,
    _stdin: NodeJS.ReadableStream | null,
    _tty: boolean,
    statusCallback?: (status: ExecStatus) => void,
  ): Promise<PodExecSocket> {
    const [file = "/bin/sh", ...args] = command;
    const r = spawnSync(file, args, { encoding: "utf8" });
    stdout?.write(r.stdout);
    stderr?.write(r.stderr);
    statusCallback?.(
      r.status === 0
        ? { status: "Success" }
        : { status: "Failure", details: { causes: [{ reason: "ExitCode", message: String(r.status) }] } },
    );
    return { close: () => {} };
  }
}

const localDeps: ExecDeps = { api: new LocalShellPodExecApi(), namespace: "ns", containerName: "sandbox" };

/** A process group id that no longer exists: a finished child's own pid. */
function deadPgid(): number {
  return Number(sh("sh -c 'echo $$'").stdout.trim());
}

/** `pollJobInPod` trims stdout before it decodes, so a `base64 -w0` that
 * adds a trailing newline (FreeBSD, macOS) still works for these tests. */
const hasBase64W0Trimmed = spawnSync("/bin/sh", ["-c", "printf ab | base64 -w0"], { encoding: "utf8" }).stdout.trim() === "YWI=";

describe.skipIf(!hasBase64W0Trimmed)("pollJobInPod: dead-process detection and read bounds (spec B4)", () => {
  afterEach(async () => {
    for (const id of execIds) await rm(`${JOBS_DIR}/${id}.dead`, { force: true });
  });

  it("reports failed with no exit code when the pid group is gone and no .exit exists", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.out`, "partial\n");
    await writeFile(`${JOBS_DIR}/${execId}.pid`, `${deadPgid()}\n`);
    const poll = await pollJobInPod(localDeps, "pod-1", execId, 0);
    expect(poll.status).toBe("failed");
    expect(poll.exitCode).toBeUndefined();
    expect(poll.output).toBe("partial\n");
  }, 10_000);

  it("reports failed for a job the start script marked dead, even with a live pid", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      await writeFile(`${JOBS_DIR}/${execId}.out`, "");
      // A live group stands in for a pid that a new container reused.
      await writeFile(`${JOBS_DIR}/${execId}.pid`, `${child.pid}\n`);
      await writeFile(`${JOBS_DIR}/${execId}.dead`, "");
      const poll = await pollJobInPod(localDeps, "pod-1", execId, 0);
      expect(poll.status).toBe("failed");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports running while the pid group is alive", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      await writeFile(`${JOBS_DIR}/${execId}.out`, "");
      await writeFile(`${JOBS_DIR}/${execId}.pid`, `${child.pid}\n`);
      const poll = await pollJobInPod(localDeps, "pod-1", execId, 0);
      expect(poll.status).toBe("running");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("caps a forward read at maxBytes and stays running until the rest is read", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.out`, "0123456789");
    await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
    const first = await pollJobInPod(localDeps, "pod-1", execId, 0, { maxBytes: 4 });
    expect(first).toEqual({ status: "running", output: "0123", nextOffset: 4 });
    const last = await pollJobInPod(localDeps, "pod-1", execId, 8, { maxBytes: 4 });
    expect(last).toEqual({ status: "done", exitCode: 0, output: "89", nextOffset: 10 });
  });

  it("reads only the tail in tail mode and moves nextOffset to the end", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.out`, "0123456789");
    await writeFile(`${JOBS_DIR}/${execId}.exit`, "3\n");
    const poll = await pollJobInPod(localDeps, "pod-1", execId, 2, { maxBytes: 3, tail: true });
    expect(poll).toEqual({ status: "done", exitCode: 3, output: "789", nextOffset: 10 });
    const short = await pollJobInPod(localDeps, "pod-1", execId, 8, { maxBytes: 3, tail: true });
    expect(short).toEqual({ status: "done", exitCode: 3, output: "89", nextOffset: 10 });
  });

  it("drops a cut codepoint's continuation bytes at the start of a tail read", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    // "€" is 3 bytes. The last 4 bytes start inside it.
    await writeFile(`${JOBS_DIR}/${execId}.out`, "ab€cde");
    await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
    const poll = await pollJobInPod(localDeps, "pod-1", execId, 0, { maxBytes: 4, tail: true });
    expect(poll.output).toBe("cde");
    expect(poll.nextOffset).toBe(Buffer.byteLength("ab€cde"));
  });
});

// Fix wave 2, B1 and L9. The refusal and the guarded kill run before any
// setsid call, so these run on every machine.
describe("job file reuse guards (fix wave 2)", () => {
  afterEach(async () => {
    for (const id of execIds) await rm(`${JOBS_DIR}/${id}.dead`, { force: true });
  });

  it.each(["out", "pid", "exit", "dead"])("kickoff refuses when %s already exists and keeps the old log", async (ext) => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.out`, "old log\n");
    if (ext !== "out") await writeFile(`${JOBS_DIR}/${execId}.${ext}`, "1\n");
    const result = sh(jobKickoffCommand(execId, "echo new"));
    expect(result.status).toBe(17);
    expect(result.stderr).toContain(execId);
    expect(await readFile(`${JOBS_DIR}/${execId}.out`, "utf8")).toBe("old log\n");
  });

  it("a kickoff prunes the files of a job that ended more than a day ago and keeps newer ones (fix wave 3, k8s M-B)", async () => {
    const old = newExecId();
    const fresh = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    for (const ext of ["out", "pid", "exit"]) {
      await writeFile(`${JOBS_DIR}/${old}.${ext}`, "x\n");
      await writeFile(`${JOBS_DIR}/${fresh}.${ext}`, "x\n");
    }
    sh(`touch -t 202001010000 ${JOBS_DIR}/${old}.exit`);
    // A refused kickoff still runs the prune, so this needs no setsid.
    const refusedId = fresh;
    const result = sh(jobKickoffCommand(refusedId, "echo new"));
    expect(result.status).toBe(17);
    expect(result.stdout).toMatch(/pruned=[1-9]/);
    await expect(readFile(`${JOBS_DIR}/${old}.out`, "utf8")).rejects.toThrow();
    expect(await readFile(`${JOBS_DIR}/${fresh}.out`, "utf8")).toBe("x\n");
  });

  it("execJobInPod surfaces the refusal as an error that names the id", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
    await writeFile(`${JOBS_DIR}/${execId}.out`, "");
    await expect(execJobInPod(localDeps, "pod-1", execId, "echo new")).rejects.toThrow(
      new RegExp(`job id ${execId} already has files`),
    );
  });

  it("cancelCommand does not kill the recorded group when .exit already exists (L9)", async () => {
    const execId = newExecId();
    await mkdir(JOBS_DIR, { recursive: true });
    // A live group stands in for an unrelated group that reused the pid.
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      await writeFile(`${JOBS_DIR}/${execId}.out`, "");
      await writeFile(`${JOBS_DIR}/${execId}.pid`, `${child.pid}\n`);
      await writeFile(`${JOBS_DIR}/${execId}.exit`, "0\n");
      sh(cancelCommand(execId));
      // A killed child stays in `ps` as a zombie until node reaps it, so
      // read the exit event instead.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.signalCode).toBeNull();
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });
});
