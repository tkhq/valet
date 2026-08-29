/**
 * Pure unit tests for jobs.ts's command builders and status parsing — no
 * cluster required.
 */
import { describe, expect, it } from "vitest";
import {
  cancelCommand,
  decodeUtf8HoldingTail,
  incompleteUtf8TailLength,
  jobKickoffCommand,
  parseJobStatus,
  pollCommand,
  utf8SequenceLength,
} from "../src/jobs.js";
import { JOBS_DIR, shQuote } from "../src/exec.js";

describe("jobKickoffCommand", () => {
  it("creates the jobs dir and an empty .out file before backgrounding", () => {
    const cmd = jobKickoffCommand("job-1", "echo hi");
    expect(cmd).toContain(`mkdir -p ${shQuote(JOBS_DIR)}`);
    expect(cmd).toContain(`: > ${shQuote(`${JOBS_DIR}/job-1.out`)}`);
  });

  it("groups the backgrounded work in parens so the WHOLE sequence backgrounds, not just the trailing echo", () => {
    const cmd = jobKickoffCommand("job-1", "echo hi");
    // The literal brief text `cmd1; cmd2 & echo started` would only
    // background cmd2 — this asserts the actual grouping construct is
    // present, which is the fix for that ambiguity (see jobs.ts docblock).
    expect(cmd).toMatch(/\(\s*setsid/);
    expect(cmd.trim().endsWith("echo started")).toBe(true);
  });

  it("uses setsid so cancelJob can kill the whole process group", () => {
    expect(jobKickoffCommand("job-1", "echo hi")).toContain("setsid");
  });

  it("waits for the pid file (or an early exit file) before echoing started — closes the cancelJob-before-pidfile race", () => {
    const cmd = jobKickoffCommand("job-1", "echo hi");
    const pidFile = shQuote(`${JOBS_DIR}/job-1.pid`);
    const exitFile = shQuote(`${JOBS_DIR}/job-1.exit`);
    expect(cmd).toMatch(new RegExp(`while \\[ ! -f ${pidFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(cmd).toContain(`[ ! -f ${exitFile} ]`);
    // The wait must come after the backgrounded job group and before the
    // final "started" echo, not inside the backgrounded subshell itself
    // (else it wouldn't block execJobInPod's own exec call at all).
    const backgroundIdx = cmd.indexOf(") </dev/null >/dev/null 2>&1 &");
    const waitIdx = cmd.indexOf("while [ ! -f");
    const startedIdx = cmd.lastIndexOf("echo started");
    expect(backgroundIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(backgroundIdx);
    expect(startedIdx).toBeGreaterThan(waitIdx);
  });

  it("nulls the backgrounded group's OWN stdio so the containerd (EKS) kickoff exec returns instead of hanging until the job ends", () => {
    // The inner job redirects its own streams to OUT/FIFO, but the `( ... )`
    // subshell wrapper lives for the job's whole duration and would otherwise
    // inherit the kickoff exec's stdout/stderr. containerd's exec streaming
    // does not close until every copy of that pipe closes, so without this
    // redirect a job-mode command longer than 60s trips EXEC_DEFAULT_TIMEOUT_MS
    // and surfaces as `execJob kickoff failed (exit 124)`. Both the uncapped and
    // capped kickoff shapes must redirect the background group's own stdio.
    for (const cmd of [
      jobKickoffCommand("job-1", "sleep 300"),
      jobKickoffCommand("job-1", "sleep 300", 1024),
    ]) {
      expect(cmd).toContain(") </dev/null >/dev/null 2>&1 &");
      // The redirect belongs to the background group, not the inner job: the
      // job keeps writing to OUT (uncapped) or the fifo (capped).
      const bgIdx = cmd.indexOf(") </dev/null >/dev/null 2>&1 &");
      const startedIdx = cmd.lastIndexOf("echo started");
      expect(bgIdx).toBeGreaterThan(-1);
      expect(startedIdx).toBeGreaterThan(bgIdx);
    }
  });

  it("embeds the inner command's text, doubly shell-quoted (once for `exec sh -c`, once for the outer `setsid sh -c`)", () => {
    const inner = "echo 'has quotes' && exit 9";
    const cmd = jobKickoffCommand("job-1", inner);
    // Two layers of shQuote transform every `'` in `inner` but never touch
    // non-quote characters, so the literal text still shows up verbatim —
    // this is a weak framing-level check; the actual round-trip through a
    // real shell (does it decode back to exactly `inner`?) is proven
    // functionally in jobs-local-protocol.test.ts.
    expect(cmd).toContain("has quotes");
    expect(cmd).toContain("exit 9");
  });

  it("without maxOutputBytes, redirects the job's exec output directly to OUT and captures setsid's own $? after it returns (uncapped path)", () => {
    const cmd = jobKickoffCommand("job-1", "echo hi");
    expect(cmd).toContain("exec sh -c");
    expect(cmd).not.toContain("head -c");
    expect(cmd).not.toContain("mkfifo");
    expect(cmd).toMatch(/< \/dev\/null > '[^']+\.out' 2>&1; echo \$\? > '[^']+\.exit'/);
  });

  it("with maxOutputBytes, connects the job to a head/cat capping filter through a fifo instead of a direct redirect", () => {
    const cmd = jobKickoffCommand("job-1", "echo hi", 1024);
    expect(cmd).toContain(`mkfifo ${shQuote(`${JOBS_DIR}/job-1.fifo`)}`);
    expect(cmd).toContain(`head -c 1024 > ${shQuote(`${JOBS_DIR}/job-1.out`)}`);
    // `cat > /dev/null` keeps draining (discarding) output past the cap so
    // the job's process never sees a broken pipe / SIGPIPE.
    expect(cmd).toContain("cat > /dev/null");
    // The capped branch still exec-tail-calls into the job — the fifo
    // decouples exit-code capture from the capping filter, so there's no
    // longer any need to avoid `exec` here (see jobs.ts docblock, DEFECT 2
    // fix).
    expect(cmd).toContain("exec sh -c");
    // The capping filter reads from the fifo as a background job whose pid
    // is captured for a later `wait`, so OUT is flushed before the whole
    // kickoff script exits.
    expect(cmd).toContain('filterpid=$!');
    expect(cmd).toContain('wait "$filterpid"');
  });

  it("with maxOutputBytes, the exit code is still captured from setsid's own $? AFTER it returns, not from inside the killed group — this is what makes cancelJob's EXIT write prompt (DEFECT 2 fix)", () => {
    const cmd = jobKickoffCommand("job-1", "exit 5", 1024);
    // Ordering: mkfifo -> background capping filter (captures $! as
    // filterpid) -> setsid runs the job, writing to the fifo -> ONLY AFTER
    // setsid returns is $? written to EXIT -> then (and only then) do we
    // wait for the capping filter and clean up the fifo. Critically, the
    // `echo $? > EXIT` write happens OUTSIDE setsid's own process group, so
    // cancelJob's SIGKILL to that group can never prevent it from running.
    const mkfifoIdx = cmd.indexOf("mkfifo");
    const filterpidIdx = cmd.indexOf("filterpid=$!");
    const setsidIdx = cmd.indexOf("setsid sh -c");
    const echoExitIdx = cmd.indexOf("echo $?");
    const waitIdx = cmd.indexOf('wait "$filterpid"');
    expect(mkfifoIdx).toBeGreaterThan(-1);
    expect(filterpidIdx).toBeGreaterThan(-1);
    expect(setsidIdx).toBeGreaterThan(-1);
    expect(echoExitIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(-1);
    expect(mkfifoIdx).toBeLessThan(filterpidIdx);
    expect(filterpidIdx).toBeLessThan(setsidIdx);
    expect(setsidIdx).toBeLessThan(echoExitIdx);
    expect(echoExitIdx).toBeLessThan(waitIdx);
  });

  it("floors and clamps a fractional/negative maxOutputBytes to a safe non-negative integer", () => {
    expect(jobKickoffCommand("job-1", "echo hi", 10.9)).toContain("head -c 10 >");
    expect(jobKickoffCommand("job-1", "echo hi", -5)).toContain("head -c 0 >");
  });
});

describe("pollCommand", () => {
  it("uses tail -c +N with a 1-indexed offset (0-indexed offset + 1)", () => {
    const cmd = pollCommand("job-1", 42);
    expect(cmd).toContain("tail -c +43");
  });

  it("offset 0 reads the whole file (tail -c +1)", () => {
    expect(pollCommand("job-1", 0)).toContain("tail -c +1");
  });

  it("reports an unknown execId distinctly from running/done", () => {
    const cmd = pollCommand("job-1", 0);
    expect(cmd).toContain("echo unknown 1>&2");
    expect(cmd).toContain("echo running 1>&2");
  });

  it("base64-encodes the tail output (-w0, no line wrap) so raw bytes survive execInPod's own UTF-8 decode", () => {
    const cmd = pollCommand("job-1", 0);
    expect(cmd).toContain("tail -c +1");
    expect(cmd).toMatch(/tail -c \+1 '[^']+' \| base64 -w0/);
  });
});

describe("cancelCommand", () => {
  it("kills the negative pid (process group) read from the pid file, WITHOUT a `--` before it", () => {
    const cmd = cancelCommand("job-1");
    // No `--`: dash's `kill` builtin (the real /bin/sh on the Debian-slim
    // sandbox image) rejects `kill -KILL -- -"$pid"` outright ("Illegal
    // number: -", exit 2) and falls through to the single-process fallback,
    // orphaning the job's child (see this function's docblock). Dropping
    // `--` is accepted by dash, BusyBox, and GNU/util-linux `kill` alike and
    // actually reaps the group in all three.
    expect(cmd).toContain(`kill -KILL -"$pid"`);
    expect(cmd).not.toContain(`kill -KILL -- -"$pid"`);
  });

  it("polls for the exit file to appear before returning", () => {
    expect(cancelCommand("job-1")).toContain(`-f ${shQuote(`${JOBS_DIR}/job-1.exit`)}`);
  });
});

describe("parseJobStatus", () => {
  it("parses 'running'", () => {
    expect(parseJobStatus("running\n")).toEqual({ status: "running" });
  });

  it("parses a numeric exit code as done", () => {
    expect(parseJobStatus("0\n")).toEqual({ status: "done", exitCode: 0 });
    expect(parseJobStatus("137\n")).toEqual({ status: "done", exitCode: 137 });
  });

  it("parses 'unknown' as failed (job never started / lost)", () => {
    expect(parseJobStatus("unknown\n")).toEqual({ status: "failed" });
  });

  it("throws on garbage", () => {
    expect(() => parseJobStatus("garbage\n")).toThrow();
  });
});

describe("utf8SequenceLength", () => {
  it("returns 1 for ASCII lead bytes", () => {
    expect(utf8SequenceLength(0x41)).toBe(1); // 'A'
  });

  it("returns 2/3/4 for multi-byte lead bytes", () => {
    expect(utf8SequenceLength(0xc2)).toBe(2); // 2-byte lead
    expect(utf8SequenceLength(0xe2)).toBe(3); // 3-byte lead
    expect(utf8SequenceLength(0xf0)).toBe(4); // 4-byte lead (e.g. emoji)
  });

  it("returns 0 for a continuation byte or invalid lead byte", () => {
    expect(utf8SequenceLength(0x80)).toBe(0); // continuation byte
    expect(utf8SequenceLength(0xff)).toBe(0); // invalid
  });
});

describe("incompleteUtf8TailLength / decodeUtf8HoldingTail (pollJobInPod's byte-boundary fix)", () => {
  // "AB\u{1F680}CD" split mid-emoji: the reviewer's exact repro. \u{1F680}
  // (rocket) is F0 9F 9A 80 in UTF-8 — 4 bytes. Split the buffer after the
  // first 2 bytes of the emoji, mid-codepoint.
  const full = Buffer.from("AB\u{1F680}CD", "utf8");
  const emojiStart = 2; // byte offset where the 4-byte emoji sequence starts

  it("holds back the correct number of bytes when a fetch ends mid-codepoint", () => {
    // First half: "AB" + first 2 bytes of the emoji (F0 9F) — incomplete.
    const firstHalf = full.subarray(0, emojiStart + 2);
    expect(incompleteUtf8TailLength(firstHalf)).toBe(2);

    const { text, deliveredBytes } = decodeUtf8HoldingTail(firstHalf);
    expect(text).toBe("AB");
    expect(deliveredBytes).toBe(2);
  });

  it("delivers a complete codepoint with no holdback", () => {
    expect(incompleteUtf8TailLength(full)).toBe(0);
    const { text, deliveredBytes } = decodeUtf8HoldingTail(full);
    expect(text).toBe("AB\u{1F680}CD");
    expect(deliveredBytes).toBe(full.length);
  });

  it("reassembles losslessly across two polls that split mid-emoji", () => {
    // Poll 1 fetches "AB" + the first 2 bytes of the emoji.
    const firstFetch = full.subarray(0, emojiStart + 2);
    const first = decodeUtf8HoldingTail(firstFetch);
    expect(first.text).toBe("AB");
    expect(first.deliveredBytes).toBe(2);

    // Poll 2 (from nextOffset = 2) re-fetches the held-back bytes plus the
    // rest of the file — exactly what pollJobInPod's tail -c +N does since
    // nextOffset never advanced past the held-back tail.
    const secondFetch = full.subarray(first.deliveredBytes);
    const second = decodeUtf8HoldingTail(secondFetch);
    expect(second.text).toBe("\u{1F680}CD");
    expect(second.deliveredBytes).toBe(secondFetch.length);

    expect(first.text + second.text).toBe("AB\u{1F680}CD");
  });

  it("is a no-op (holds back nothing) for an empty buffer", () => {
    expect(incompleteUtf8TailLength(Buffer.alloc(0))).toBe(0);
    expect(decodeUtf8HoldingTail(Buffer.alloc(0))).toEqual({ text: "", deliveredBytes: 0 });
  });

  it("does not hold back plain ASCII", () => {
    const buf = Buffer.from("hello", "utf8");
    expect(incompleteUtf8TailLength(buf)).toBe(0);
    expect(decodeUtf8HoldingTail(buf)).toEqual({ text: "hello", deliveredBytes: 5 });
  });

  it("documents the binary-output limitation: genuinely invalid UTF-8 is delivered as-is (lossy), not held back forever", () => {
    // A lone continuation byte (0x80) with no preceding lead byte within
    // the 3-byte scan window isn't an "incomplete tail" this function can
    // fix — it's just not valid UTF-8. Per JobPoll's `output: string`
    // contract (matches sandbox-docker's own StringDecoder-based fidelity,
    // which is equally lossy for non-UTF-8 bytes), this is delivered
    // immediately and decodes to the U+FFFD replacement character rather
    // than being held back indefinitely.
    const buf = Buffer.from([0x80, 0x80, 0x80, 0x80]);
    expect(incompleteUtf8TailLength(buf)).toBe(0);
    const { text, deliveredBytes } = decodeUtf8HoldingTail(buf);
    expect(deliveredBytes).toBe(4);
    expect(text).toBe("����");
  });
});
