import { describe, expect, it } from "vitest";
import { buildDataset, buildHeldOutDataset } from "../src/secret-intake/dataset.js";
import { stage1 } from "../src/secret-intake/detectors.js";
import { score } from "../src/secret-intake/metrics.js";

describe("secret-intake dataset", () => {
  it("is deterministic for a seed", () => {
    expect(buildDataset(1)).toEqual(buildDataset(1));
    expect(buildDataset(1)).not.toEqual(buildDataset(2));
  });

  it("labels each key span with its exact value", () => {
    for (const m of [...buildDataset(), ...buildHeldOutDataset()]) {
      for (const s of m.secrets) {
        expect(s.end).toBeGreaterThan(s.start);
        expect(m.text.slice(s.start, s.end)).not.toMatch(/\s/);
      }
    }
  });

  it("keeps held-out ids apart from the tuning set", () => {
    const dev = new Set(buildDataset().map((m) => m.id));
    expect(buildHeldOutDataset().some((m) => dev.has(m.id))).toBe(false);
  });
});

describe("secret-intake metrics", () => {
  it("counts recall, false alarms, and span precision", () => {
    const messages = [
      { id: "a", kind: "positive" as const, category: "x", text: "k=abc", secrets: [{ start: 2, end: 5, provider: "x" }] },
      { id: "b", kind: "negative" as const, category: "y", text: "nothing", secrets: [] },
    ];
    const s = score(messages, new Map([["a", [{ start: 2, end: 5 }]], ["b", [{ start: 0, end: 3 }]]]));
    expect(s.recall).toBe(1);
    expect(s.falseAlarmRate).toBe(1);
    expect(s.spanPrecision).toBe(0.5);
  });

  it("holds stage 1 to the release floor on the tuning set", async () => {
    const messages = buildDataset();
    const detect = stage1(0.5);
    const results = new Map(await Promise.all(messages.map(async (m) => [m.id, await detect(m)] as const)));
    const s = score(messages, results);
    expect(s.recall).toBeGreaterThanOrEqual(0.98);
    expect(s.falseAlarmRate).toBeLessThanOrEqual(0.05);
  });
});
