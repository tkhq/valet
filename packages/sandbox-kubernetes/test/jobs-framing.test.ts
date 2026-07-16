/**
 * Pure unit tests for jobs.ts's command builders and status parsing — no
 * cluster required.
 */
import { describe, expect, it } from "vitest";
import { cancelCommand, jobKickoffCommand, parseJobStatus, pollCommand } from "../src/jobs.js";
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
});

describe("cancelCommand", () => {
  it("kills the negative pid (process group) read from the pid file", () => {
    const cmd = cancelCommand("job-1");
    expect(cmd).toContain(`kill -KILL -- -"$pid"`);
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

describe("offset math (pollJobInPod's increment, not docker's full-buffer slice)", () => {
  // These document the *shape* of the offset arithmetic pollJobInPod
  // performs (nextOffset = offset + byteLength(newChunk)) as a standalone,
  // dependency-free check — the actual wiring is exercised end-to-end by
  // jobs-local-protocol.test.ts and, live, by exec.cluster.test.ts.
  function nextOffset(offset: number, chunk: string): number {
    return offset + Buffer.byteLength(chunk, "utf8");
  }

  it("advances by the UTF-8 byte length of the chunk, not its JS string length", () => {
    const chunk = "\u{1F680}"; // 4 bytes in utf8, length 2 as a JS UTF-16 string
    expect(Buffer.byteLength(chunk, "utf8")).toBe(4);
    expect(nextOffset(0, chunk)).toBe(4);
  });

  it("is idempotent for an empty chunk (no new data yet)", () => {
    expect(nextOffset(10, "")).toBe(10);
  });

  it("accumulates monotonically across polls", () => {
    let offset = 0;
    for (const chunk of ["hello", " ", "world"]) {
      offset = nextOffset(offset, chunk);
    }
    expect(offset).toBe(Buffer.byteLength("hello world", "utf8"));
  });
});
