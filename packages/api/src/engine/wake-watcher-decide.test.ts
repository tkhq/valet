import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Wakeup, WakeupLimits } from "@valet/engine";
import { decideWakeup, tail, LOG_TAIL_BYTES, type WakeupDecision, type WakeupProbe } from "./wake-watcher-decide.js";

interface Vector {
  name: string;
  now: number;
  row: Wakeup;
  probe: WakeupProbe;
  limits: Pick<WakeupLimits, "watchMaxEventsPerHour">;
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

  it("trims by characters from the end for multi-byte strings", () => {
    // Each euro sign is 3 bytes in UTF-8.
    const long = "€".repeat(2000);
    const result = tail(long);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(LOG_TAIL_BYTES);
  });
});
