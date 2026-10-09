import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Wakeup } from "@valet/engine";
import { decideWakeup, tail, LOG_TAIL_BYTES, WATCH_BUFFER_BYTES, WATCH_READ_BYTES, type DecideOptions, type WakeupDecision, type WakeupProbe } from "./wake-watcher-decide.js";

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

  it("sends every remaining line at exit, not only the first 200 (PR review, finding 4)", () => {
    const row: Wakeup = {
      id: "wk_exit", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "final lines",
      command: "emit", execId: "e1", leaseId: "ls_1", deadlineAt: 10_000_000, logOffset: 0, logTail: "",
      eventCount: 0, createdAt: 0, updatedAt: 0,
    };
    const output = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const decision = decideWakeup(
      1000,
      row,
      { kind: "poll", status: "done", exitCode: 0, output, nextOffset: Buffer.byteLength(output) },
      { watchMaxEventsPerHour: 120 },
    );
    expect(decision?.to).toBe("done");
    const events = decision?.signals.filter((s) => s.signalType === "watch.event") ?? [];
    const sent = events.flatMap((s) => s.body.split("\n"));
    expect(sent).toHaveLength(300);
    expect(sent[299]).toBe("line 300");
    expect(decision?.signals.at(-1)?.signalType).toBe("watch.exited");
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

// ── Fix wave 3, group A: rate limit reachable at defaults, coalesced emits ──

const WATCH_ROW: Wakeup = {
  id: "wk_w3", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "follow build",
  command: "tail -f build.log", execId: "e1", leaseId: "ls_1", deadlineAt: 100 * 3_600_000, logOffset: 0, logTail: "",
  eventCount: 0, createdAt: 0, updatedAt: 0,
};

const DEFAULTS: DecideOptions = { watchMaxEventsPerHour: 120, watchMinIntervalMs: 120_000 };

/** Applies a running decision's patch the way the store does. */
function applied(row: Wakeup, d: WakeupDecision): Wakeup {
  return { ...row, status: d.to, ...d.patch };
}

describe("watch rate limit and coalescing (fix wave 3)", () => {
  it("expires a watch that prints on every 30s tick on the 121st tick, at defaults", () => {
    let row = WATCH_ROW;
    let signals = 0;
    let offset = 0;
    for (let tick = 0; tick < 200; tick++) {
      const now = 1_000 + tick * 30_000;
      const output = `line ${tick}\n`;
      offset += Buffer.byteLength(output);
      const d = decideWakeup(now, row, { kind: "poll", status: "running", output, nextOffset: offset }, DEFAULTS);
      expect(d).not.toBeNull();
      if (!d) return;
      if (d.to === "expired") {
        expect(tick).toBe(120);
        expect(d.cause).toBe("rate");
        expect(signals).toBeLessThanOrEqual(31);
        expect(d.signals[0]?.body).toContain("line 120");
        expect(d.signals[0]?.body).toContain("sandbox.watchMaxEventsPerHour");
        return;
      }
      signals += d.signals.length;
      row = applied(row, d);
    }
    throw new Error("the watch never expired");
  });

  it("emits the first lines at once, then buffers until watchMinIntervalMs passes", () => {
    const first = decideWakeup(1_000, WATCH_ROW, { kind: "poll", status: "running", output: "a\n", nextOffset: 2 }, DEFAULTS);
    expect(first?.signals.map((s) => s.body)).toEqual(["a"]);
    const row1 = applied(WATCH_ROW, first as WakeupDecision);
    const second = decideWakeup(31_000, row1, { kind: "poll", status: "running", output: "b\n", nextOffset: 4 }, DEFAULTS);
    expect(second?.signals).toEqual([]);
    expect(second?.patch.watchBuffer).toBe("b\n");
    const row2 = applied(row1, second as WakeupDecision);
    // No new output, but the buffer is due: it goes out alone.
    const third = decideWakeup(121_000, row2, { kind: "poll", status: "running", output: "", nextOffset: 4 }, DEFAULTS);
    expect(third?.signals.map((s) => s.body)).toEqual(["b"]);
    expect(third?.patch.watchBuffer).toBe("");
    expect(third?.patch.lastEmitAt).toBe(121_000);
    expect(third?.signals[0]?.dispatchId).toBe("wakeup:wk_w3:event:2");
  });

  it("forces an emit when the buffer reaches 64 KiB", () => {
    const big = "y".repeat(40 * 1024) + "\n";
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, watchBuffer: big };
    const d = decideWakeup(31_000, row, { kind: "poll", status: "running", output: big, nextOffset: Buffer.byteLength(big) }, DEFAULTS);
    expect(d?.signals).toHaveLength(1);
    // One event holds at most 64 KiB; the second line stays buffered (fix wave 4, data N8).
    expect(d?.signals[0]?.body).toBe(big.slice(0, -1));
    expect(d?.patch.watchBuffer).toBe(big);
  });

  it("flushes the buffer into the final watch.event at exit", () => {
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, watchBuffer: "held\n" };
    const d = decideWakeup(31_000, row, { kind: "poll", status: "done", exitCode: 0, output: "last\n", nextOffset: 5 }, DEFAULTS);
    expect(d?.signals.map((s) => s.signalType)).toEqual(["watch.event", "watch.exited"]);
    expect(d?.signals[0]?.body).toBe("held\nlast");
  });

  it("does not count a tick without new output toward the rate window", () => {
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, windowStartAt: 1_000, windowCount: 120 };
    expect(decideWakeup(31_000, row, { kind: "poll", status: "running", output: "", nextOffset: 0 }, DEFAULTS)).toBeNull();
  });
});

describe("rows the kernel cannot act on (fix wave 3)", () => {
  it("ends a timer with no prompt as lost and flags the bad row", () => {
    const row: Wakeup = {
      id: "wk_t", sessionId: "s1", threadId: "t1", kind: "timer", status: "pending", reason: "r", fireAt: 500,
      logOffset: 0, logTail: "", eventCount: 0, createdAt: 0, updatedAt: 0,
    };
    const d = decideWakeup(1_000, row, { kind: "none" }, DEFAULTS);
    expect(d).toEqual({ to: "lost", patch: { endedAt: 1_000 }, signals: [], badRow: true });
  });
});

describe("terminal bodies name the next step (fix wave 3, UX)", () => {
  const proc: Wakeup = { ...WATCH_ROW, id: "wk_p", kind: "process", logTail: "partial\n" };
  it("pid_missing after a run tells the agent to check before a rerun", () => {
    const d = decideWakeup(1_000, proc, { kind: "poll", status: "failed", output: "", nextOffset: 0 }, DEFAULTS);
    expect(d?.signals[0]?.body).toContain("partial\n");
    expect(d?.signals[0]?.body).toContain("Check /workspace for partial output");
  });
  it("sandbox_unavailable says the sandbox stopped", () => {
    const d = decideWakeup(1_000, proc, { kind: "unavailable" }, DEFAULTS);
    expect(d?.signals[0]?.body).toContain("The sandbox stopped");
  });
  it("deadline says the process was stopped at its deadline", () => {
    const d = decideWakeup(200 * 3_600_000, proc, { kind: "poll", status: "running", output: "", nextOffset: 0 }, DEFAULTS);
    expect(d?.signals[0]?.body).toContain("reached its deadline");
  });
  it("a capped log says so in the exit body", () => {
    const d = decideWakeup(1_000, proc, { kind: "poll", status: "done", exitCode: 1, output: "x\n[valet: log capped at 10 bytes; later output dropped]\n", nextOffset: 60 }, DEFAULTS);
    expect(d?.signals[0]?.body).toContain("The log hit its size cap");
  });
});

// ── Fix wave 4, group A ──

describe("watch rate limit under timer drift (fix wave 4, data M1)", () => {
  it("expires a watch on its 121st output poll when each tick lands 30 001 ms after the last", () => {
    let row = WATCH_ROW;
    let offset = 0;
    for (let poll = 0; poll < 121; poll++) {
      const now = 1_000 + poll * 30_001;
      const output = `line ${poll}\n`;
      offset += Buffer.byteLength(output);
      const d = decideWakeup(now, row, { kind: "poll", status: "running", output, nextOffset: offset }, DEFAULTS);
      expect(d).not.toBeNull();
      if (!d) return;
      if (poll < 120) {
        expect(d.to).toBe("running");
        row = applied(row, d);
        continue;
      }
      expect(d.to).toBe("expired");
      expect(d.cause).toBe("rate");
    }
  });

  it("starts a new window only one tick past the hour", () => {
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, windowStartAt: 0, windowCount: 5 };
    const inside = decideWakeup(3_600_000 + 30_000, row, { kind: "poll", status: "running", output: "x\n", nextOffset: 2 }, DEFAULTS);
    expect(inside?.patch.windowCount).toBe(6);
    const past = decideWakeup(3_600_000 + 30_001, row, { kind: "poll", status: "running", output: "x\n", nextOffset: 2 }, DEFAULTS);
    expect(past?.patch.windowCount).toBe(1);
    const slowTick = decideWakeup(3_600_000 + 30_001, row, { kind: "poll", status: "running", output: "x\n", nextOffset: 2 }, { ...DEFAULTS, tickMs: 60_000 });
    expect(slowTick?.patch.windowCount).toBe(6);
  });
});

describe("pending row past the start grace (fix wave 4, concurrency N4)", () => {
  const pending: Wakeup = { ...WATCH_ROW, id: "wk_pend", kind: "process", status: "pending", deadlineAt: 10 * 3_600_000 };
  it("makes no decision on a probe error before the deadline", () => {
    expect(decideWakeup(46 * 60_000, pending, { kind: "error" }, DEFAULTS)).toBeNull();
  });
  it("expires the row at its deadline when the probe still fails", () => {
    const d = decideWakeup(11 * 3_600_000, pending, { kind: "error" }, DEFAULTS);
    expect(d).toMatchObject({ to: "expired", cause: "deadline", kill: true, releaseLease: "deadline" });
  });
});

describe("buffered watch lines reach every terminal body (fix wave 4, data N2)", () => {
  const held: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, logTail: "sent\nheld 1\nheld 2\n", watchBuffer: "held 1\nheld 2\n" };
  it("the deadline body carries the buffered lines and the new output", () => {
    const d = decideWakeup(200 * 3_600_000, held, { kind: "poll", status: "running", output: "new\n", nextOffset: 4 }, DEFAULTS);
    expect(d?.to).toBe("expired");
    expect(d?.signals[0]?.body.startsWith("held 1\nheld 2\nnew\n")).toBe(true);
  });
  it("the sandbox_unavailable body carries the buffered lines", () => {
    const d = decideWakeup(31_000, held, { kind: "unavailable" }, DEFAULTS);
    expect(d?.signals[0]?.body.startsWith("held 1\nheld 2\n")).toBe(true);
    expect(d?.signals[0]?.body).not.toContain("sent");
  });
  it("the rate body keeps up to 64 KiB of buffered lines, not a 4 KiB tail", () => {
    const line = "z".repeat(1023) + "\n";
    const buffer = line.repeat(40);
    const row: Wakeup = { ...held, watchBuffer: buffer, windowStartAt: 0, windowCount: 120 };
    const d = decideWakeup(31_000, row, { kind: "poll", status: "running", output: "last\n", nextOffset: 5 }, DEFAULTS);
    expect(d?.cause).toBe("rate");
    expect(d?.signals[0]?.body.startsWith(`${buffer}last\n`)).toBe(true);
  });
  it("caps a terminal body's buffered lines at 64 KiB", () => {
    const line = "q".repeat(1023) + "\n";
    const row: Wakeup = { ...held, watchBuffer: line.repeat(100) };
    const d = decideWakeup(31_000, row, { kind: "unavailable" }, DEFAULTS);
    const body = d?.signals[0]?.body ?? "";
    expect(Buffer.byteLength(body)).toBeLessThan(WATCH_BUFFER_BYTES + 1024);
    expect(body).toContain("The sandbox stopped");
  });
});

describe("watch.event body cap (fix wave 4, data N8)", () => {
  it("emits at most 64 KiB of lines and keeps the rest buffered", () => {
    const line = "w".repeat(1023) + "\n";
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, watchBuffer: line.repeat(63) };
    const output = line.repeat(60);
    const d = decideWakeup(31_000, row, { kind: "poll", status: "running", output, nextOffset: Buffer.byteLength(output) }, DEFAULTS);
    expect(d?.signals).toHaveLength(1);
    const body = d?.signals[0]?.body ?? "";
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(WATCH_BUFFER_BYTES);
    expect(d?.signals[0]?.attributes.lineCount).toBe("64");
    expect(d?.patch.watchBuffer).toBe(line.repeat(59));
  });
  it("splits a large exit flush into several events of at most 64 KiB", () => {
    const line = "e".repeat(1023) + "\n";
    const row: Wakeup = { ...WATCH_ROW, lastEmitAt: 1_000, eventCount: 1, watchBuffer: line.repeat(63) };
    const output = line.repeat(60);
    const d = decideWakeup(31_000, row, { kind: "poll", status: "done", exitCode: 0, output, nextOffset: Buffer.byteLength(output) }, DEFAULTS);
    const events = d?.signals.filter((s) => s.signalType === "watch.event") ?? [];
    expect(events.map((s) => s.attributes.lineCount)).toEqual(["64", "59"]);
    expect(events.map((s) => s.dispatchId)).toEqual(["wakeup:wk_w3:event:2", "wakeup:wk_w3:event:3"]);
    expect(d?.patch.eventCount).toBe(3);
    for (const s of events) expect(Buffer.byteLength(s.body)).toBeLessThanOrEqual(WATCH_BUFFER_BYTES);
  });
});

describe("a provider-reported truncation gives the capped notice (fix wave 4, UX N5)", () => {
  const proc: Wakeup = { ...WATCH_ROW, id: "wk_p", kind: "process", logTail: "" };
  it("adds the capped notice to the exit body when the poll reports truncated", () => {
    const d = decideWakeup(1_000, proc, { kind: "poll", status: "done", exitCode: 0, output: "head\n", nextOffset: 5, truncated: true }, DEFAULTS);
    expect(d?.signals[0]?.body).toContain("The log hit its size cap");
  });
});

describe("deadline guidance (fix wave 4, UX N14)", () => {
  const proc: Wakeup = { ...WATCH_ROW, id: "wk_p", kind: "process", logTail: "", createdAt: 0, deadlineAt: 72 * 3_600_000 };
  it("does not say to rerun with a larger deadline when the deadline was already the max", () => {
    const d = decideWakeup(73 * 3_600_000, proc, { kind: "error" }, { ...DEFAULTS, leaseMaxHours: 72 });
    const body = d?.signals[0]?.body ?? "";
    expect(body).not.toContain("larger deadline");
    expect(body).toContain("72 hours");
  });
  it("names the watch and max_hours for a watch", () => {
    const d = decideWakeup(200 * 3_600_000, { ...WATCH_ROW, logTail: "" }, { kind: "error" }, { ...DEFAULTS, leaseMaxHours: 200 });
    const body = d?.signals[0]?.body ?? "";
    expect(body).toContain("the watch reached its max_hours");
    expect(body).toContain("larger max_hours");
    expect(body).not.toContain("process");
  });
});
