import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Wakeup } from "@valet/engine";
import { decideWakeup, tail, LOG_TAIL_BYTES, WATCH_READ_BYTES, type DecideOptions, type WakeupDecision, type WakeupProbe } from "./wake-watcher-decide.js";

interface Vector {
  name: string;
  now: number;
  row: Wakeup;
  probe: WakeupProbe;
  limits: DecideOptions;
  expected: WakeupDecision | null;
}

const vectorsPath = fileURLToPath(new URL("./wake-watcher.vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as Vector[];

describe("decideWakeup", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const result = decideWakeup(vector.now, vector.row, vector.probe, vector.limits);
      expect(result).toEqual(vector.expected);
    });
  }
});

describe("tail", () => {
  it("returns the string unchanged when under the byte limit", () => {
    expect(tail("hello")).toBe("hello");
  });

  it("keeps the last LOG_TAIL_BYTES bytes of a long string", () => {
    const long = "x".repeat(LOG_TAIL_BYTES + 100);
    const result = tail(long);
    expect(Buffer.byteLength(result)).toBe(LOG_TAIL_BYTES);
    expect(result).toBe("x".repeat(LOG_TAIL_BYTES));
  });

  it("replaces NUL, which Postgres text rejects (fix wave 2, M4)", () => {
    expect(tail("a\u0000b")).toBe("a�b");
  });

  it("trims by characters from the end for multi-byte strings", () => {
    // Each euro sign is 3 bytes in UTF-8.
    const long = "€".repeat(2000);
    const result = tail(long);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(LOG_TAIL_BYTES);
  });
});

describe("watch reads bounded at WATCH_READ_BYTES", () => {
  it("turns one line that fills the whole read into an event instead of stalling", () => {
    const line = "x".repeat(WATCH_READ_BYTES);
    const row: Wakeup = {
      id: "wk_long", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "long line",
      command: "emit", execId: "e1", leaseId: "ls_1", deadlineAt: 10_000_000, logOffset: 0, logTail: "",
      eventCount: 0, createdAt: 0, updatedAt: 0,
    };
    const decision = decideWakeup(1000, row, { kind: "poll", status: "running", output: line, nextOffset: WATCH_READ_BYTES }, { watchMaxEventsPerHour: 120 });
    expect(decision?.to).toBe("running");
    expect(decision?.patch.logOffset).toBe(WATCH_READ_BYTES);
    expect(decision?.signals[0]?.body).toBe(line);
  });

  it("still holds back a short partial line", () => {
    const row: Wakeup = {
      id: "wk_short", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "short",
      command: "emit", execId: "e1", leaseId: "ls_1", deadlineAt: 10_000_000, logOffset: 0, logTail: "",
      eventCount: 0, createdAt: 0, updatedAt: 0,
    };
    expect(decideWakeup(1000, row, { kind: "poll", status: "running", output: "partial", nextOffset: 7 }, { watchMaxEventsPerHour: 120 })).toBeNull();
  });
});
