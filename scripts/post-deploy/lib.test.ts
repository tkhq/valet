import { describe, expect, it } from "vitest";
import { PollTimeout, pollUntil, renderReport, selectJourneys, toReport, unclearErrorReason, type JourneyResult } from "./lib";

function result(over: Partial<JourneyResult>): JourneyResult {
  return { id: "j", title: "A journey", status: "passed", durationMs: 1500, evidence: [], leftovers: [], ...over };
}

describe("toReport", () => {
  it("exits 1 when any journey failed, 0 when the rest passed or skipped", () => {
    const base = { url: "https://v", build: "abc", startedAt: "t" };
    expect(toReport({ ...base, journeys: [result({}), result({ id: "k", status: "skipped" })] }).exitCode).toBe(0);
    const failed = toReport({ ...base, journeys: [result({}), result({ id: "k", status: "failed" })] });
    expect(failed).toMatchObject({ passed: 1, failed: 1, skipped: 0, exitCode: 1 });
  });
});

describe("renderReport", () => {
  it("prints the reason, the evidence, and any leftovers under each row", () => {
    const text = renderReport(
      toReport({
        url: "https://v",
        build: "abc123",
        startedAt: "2026-10-20T00:00:00Z",
        journeys: [
          result({ id: "workflow-branches", evidence: [{ key: "run", value: "wfrun_1" }] }),
          result({ id: "mcp-call", status: "failed", reason: "no connection", leftovers: ["workflow wf_1"] }),
          result({ id: "event-delivery", status: "skipped", reason: "set VALET_X" }),
        ],
      }),
    );
    expect(text).toContain("build: abc123");
    expect(text).toContain("✓ workflow-branches  passed (1.5s)");
    expect(text).toContain("    run: wfrun_1");
    expect(text).toContain("✗ mcp-call           failed (1.5s)");
    expect(text).toContain("    reason: no connection");
    expect(text).toContain("    LEFTOVER: workflow wf_1");
    expect(text).toContain("⊘ event-delivery     skipped: set VALET_X");
    expect(text).toContain("1 passed · 1 failed · 1 skipped");
  });
});

describe("selectJourneys", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("keeps table order and rejects an unknown id", () => {
    expect(selectJourneys(all, ["c", "a"]).map((j) => j.id)).toEqual(["a", "c"]);
    expect(selectJourneys(all, undefined)).toBe(all);
    expect(() => selectJourneys(all, ["z"])).toThrow(/Unknown journey "z"/);
  });
});

describe("unclearErrorReason", () => {
  it("accepts an error that names the integration", () => {
    expect(unclearErrorReason("notion: no credential connected", ["notion", "Notion"])).toBeNull();
    expect(unclearErrorReason("Linear rejected your connected account. Reconnect Linear on the Integrations page.", ["linear", "Linear"])).toBeNull();
  });

  it("refuses empty, raw, and unnamed errors", () => {
    expect(unclearErrorReason("  ", ["linear"])).toBe("the error text is empty");
    expect(unclearErrorReason("MCP linear tools/call failed: HTTP 500 — oops", ["linear"])).toMatch(/raw server text \("HTTP 500"\)/);
    expect(unclearErrorReason("fetch failed", ["linear"])).toMatch(/raw server text/);
    expect(unclearErrorReason("no credential connected", ["linear", "Linear"])).toMatch(/does not name the integration/);
  });
});

describe("pollUntil", () => {
  it("returns the first value that satisfies the condition", async () => {
    let n = 0;
    const value = await pollUntil("n to reach 3", async () => ++n, (v) => v >= 3, { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} });
    expect(value).toBe(3);
  });

  it("throws PollTimeout with the last value read", async () => {
    let clock = 0;
    const err = await pollUntil("never", async () => "running", () => false, {
      timeoutMs: 100,
      intervalMs: 40,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollTimeout);
    expect(err).toMatchObject({ what: "never", last: "running" });
  });
});
