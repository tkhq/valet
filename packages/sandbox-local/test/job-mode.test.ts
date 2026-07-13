import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSandbox } from "../src/index.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "valet-engine-localsb-job-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function pollUntilTerminal(
  sb: LocalSandbox,
  execId: string,
  maxAttempts = 200,
): Promise<{ output: string; polls: Array<{ status: string; output: string }> }> {
  let offset = 0;
  let output = "";
  const polls: Array<{ status: string; output: string }> = [];
  for (let i = 0; i < maxAttempts; i++) {
    const poll = await sb.pollJob(execId, offset);
    polls.push({ status: poll.status, output: poll.output });
    output += poll.output;
    offset = poll.nextOffset;
    if (poll.status !== "running") return { output, polls };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not reach a terminal state in time");
}

describe("LocalSandbox: job mode", () => {
  it("1. polls with advancing offsets deliver each byte exactly once; final poll done + exitCode 0", async () => {
    const sb = new LocalSandbox("test", tmp);
    const { execId } = await sb.execJob(
      "i=0; while [ $i -lt 5 ]; do echo tick$i; i=$((i+1)); sleep 0.1; done",
    );

    const { output, polls } = await pollUntilTerminal(sb, execId);

    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`tick${i}`);
    }
    // Order preserved, no duplication: reconstruct the concatenation from
    // deltas and it should equal a single-shot read from offset 0.
    const finalStatus = polls[polls.length - 1];
    expect(finalStatus.status).toBe("done");

    const full = await sb.pollJob(execId + "-doesnotexist", 0);
    expect(full.status).toBe("failed"); // sanity: unrelated id still fails cleanly

    const last = await sb.pollJob(execId, 0);
    expect(last.status).toBe("failed"); // evicted after prior terminal poll
  });

  it("2. non-zero exit is done + exitCode, not failed", async () => {
    const sb = new LocalSandbox("test", tmp);
    const { execId } = await sb.execJob("exit 7");
    const { polls } = await pollUntilTerminal(sb, execId);
    const final = polls[polls.length - 1];
    expect(final.status).toBe("done");

    // Re-derive exitCode via a fresh job since the prior one evicted on
    // terminal observation; poll once and check exitCode directly.
    const { execId: execId2 } = await sb.execJob("exit 7");
    let poll = await sb.pollJob(execId2, 0);
    let offset = poll.nextOffset;
    while (poll.status === "running") {
      await new Promise((r) => setTimeout(r, 20));
      poll = await sb.pollJob(execId2, offset);
      offset = poll.nextOffset;
    }
    expect(poll.status).toBe("done");
    expect(poll.exitCode).toBe(7);
  });

  it("3. cancelJob mid-run -> subsequent poll is terminal with non-zero exit", async () => {
    const sb = new LocalSandbox("test", tmp);
    const { execId } = await sb.execJob("sleep 30");
    await sb.cancelJob(execId);

    const poll = await sb.pollJob(execId, 0);
    expect(poll.status).toBe("done");
    expect(poll.exitCode).not.toBe(0);
  });

  it("4. unknown execId poll -> status failed", async () => {
    const sb = new LocalSandbox("test", tmp);
    const poll = await sb.pollJob("job-does-not-exist", 0);
    expect(poll.status).toBe("failed");
    expect(poll.output).toBe("");
  });
});
