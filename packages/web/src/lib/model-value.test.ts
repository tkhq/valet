import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@valet/api/wire";
import type { ModelBenchmark } from "@valet/shared";
import { blendedPrice, buildRows, filterRows, isCurrentScore, qualityOf, sortRows } from "./model-value";

function mk(id: string, o: { input?: number; output?: number; name?: string; approved?: boolean; contextWindow?: number; providerName?: string }): ModelInfo {
  return {
    id,
    name: o.name ?? id,
    providerId: "p",
    providerKind: "amazon-bedrock",
    providerName: o.providerName ?? "Amazon Bedrock",
    active: true,
    approved: o.approved ?? true,
    contextWindow: o.contextWindow,
    pricing: o.input === undefined && o.output === undefined ? undefined : { input: o.input ?? 0, output: o.output ?? 0 },
  };
}
const bm = (family: string, extra: Partial<ModelBenchmark> = {}): ModelBenchmark => ({ family, name: family, ids: [], ...extra });
const ceilings = new Map([["v5.0", 60], ["v4.0", 80]]);
const scoring = { ceilings, latestVersion: "v5.0" };

describe("blendedPrice", () => {
  it("is (3*in + out)/4 and needs both prices", () => {
    expect(blendedPrice({ input: 0.62, output: 1.85 })).toBeCloseTo(0.9275);
    expect(blendedPrice({ input: 0.5, output: 0 })).toBeUndefined();
    expect(blendedPrice(undefined)).toBeUndefined();
  });
});

describe("qualityOf", () => {
  const valet = { suite: "s", modelSpec: "m", cases: 10, runsPerCase: 1, passRate: 85, ranAt: "2026-10-30" };
  it("averages the available parts against the version ceiling", () => {
    expect(qualityOf(bm("a", { intelligenceIndex: 45, indexVersion: "v5.0" }), scoring)).toEqual({ quality: 75, sources: ["aa"] });
    expect(qualityOf(bm("a", { intelligenceIndex: 45, indexVersion: "v5.0", valetEval: valet }), scoring)).toEqual({ quality: 80, sources: ["aa", "valet"] });
    expect(qualityOf(bm("a", { valetEval: valet }), scoring)).toEqual({ quality: 85, sources: ["valet"] });
    expect(qualityOf(bm("a"), scoring)).toEqual({ quality: undefined, sources: [] });
    expect(qualityOf(undefined, scoring)).toEqual({ quality: undefined, sources: [] });
  });
  it("ignores a public score that is not on the latest index version, even with a ceiling", () => {
    // v4.0 has a ceiling (80) but is not the latest version: scores on it are
    // display-only. Otherwise an older model's share of an older era's best
    // would outrank its own successor (GLM-5 88 vs GLM-5.3 55 in the review).
    expect(qualityOf(bm("a", { intelligenceIndex: 80, indexVersion: "v4.0" }), scoring)).toEqual({ quality: undefined, sources: [] });
    expect(qualityOf(bm("a", { intelligenceIndex: 67, indexVersion: "v3.0" }), scoring)).toEqual({ quality: undefined, sources: [] });
    expect(qualityOf(bm("a", { intelligenceIndex: 80, indexVersion: "v4.0", valetEval: valet }), scoring)).toEqual({ quality: 85, sources: ["valet"] });
  });
  it("ignores a latest-version score when that version has no ceiling", () => {
    expect(qualityOf(bm("a", { intelligenceIndex: 45, indexVersion: "v5.0" }), { ceilings: new Map(), latestVersion: "v5.0" })).toEqual({ quality: undefined, sources: [] });
  });
});

describe("buildRows", () => {
  const lookup = (id: string) =>
    ({
      "amazon-bedrock/cheap": bm("cheap", { intelligenceIndex: 30, indexVersion: "v5.0" }),
      "amazon-bedrock/mid": bm("mid", { intelligenceIndex: 45, indexVersion: "v5.0" }),
      "amazon-bedrock/unpriced": bm("u", { intelligenceIndex: 60, indexVersion: "v5.0" }),
    })[id];
  it("value is q²/blended rescaled so the best shown row is 100", () => {
    const rows = buildRows(
      [mk("amazon-bedrock/cheap", { input: 0.15, output: 0.6 }), mk("amazon-bedrock/mid", { input: 0.62, output: 1.85 }), mk("amazon-bedrock/unpriced", {})],
      { ...scoring, lookup },
    );
    // cheap: q=50, blended=0.2625 → 9523.8 ; mid: q=75, blended=0.9275 → 6064.7
    expect(rows.map((r) => r.value)).toEqual([100, 64, undefined]);
    expect(rows[2].quality).toBe(100);
    expect(rows[2].blended).toBeUndefined();
  });
  it("a priced row with an unknown model has no quality or value", () => {
    const [row] = buildRows([mk("amazon-bedrock/vendor.new", { input: 1, output: 2 })], { ...scoring, lookup });
    expect(row.blended).toBeCloseTo(1.25);
    expect(row.quality).toBeUndefined();
    expect(row.value).toBeUndefined();
    expect(row.qualitySources).toEqual([]);
  });
  it("never divides by zero when nothing is scored", () => {
    const rows = buildRows([mk("amazon-bedrock/x", { input: 1, output: 2 }), mk("amazon-bedrock/y", {})], { ...scoring, lookup: () => undefined });
    expect(rows.every((r) => r.value === undefined)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("null");
  });
});

describe("sortRows / filterRows", () => {
  const lookup = (id: string) =>
    ({
      "amazon-bedrock/a": bm("a", { intelligenceIndex: 60, indexVersion: "v5.0" }),
      "amazon-bedrock/b": bm("b", { intelligenceIndex: 30, indexVersion: "v5.0" }),
      "amazon-bedrock/c": bm("c", { intelligenceIndex: 45, indexVersion: "v5.0" }),
    })[id];
  const rows = buildRows(
    [
      mk("amazon-bedrock/a", { input: 4, output: 20, name: "Alpha" }),
      mk("amazon-bedrock/b", { input: 0.1, output: 0.5, name: "Bravo", providerName: "OpenRouter" }),
      mk("amazon-bedrock/c", { input: 0.62, output: 1.85, name: "Charlie" }),
      mk("amazon-bedrock/d", { input: 0.3, output: 1.2, name: "Delta" }), // unscored → no value
      mk("amazon-bedrock/e", { name: "Echo" }), // nothing
    ],
    { ...scoring, lookup },
  );
  const ids = (r: typeof rows) => r.map((x) => x.model.id.slice("amazon-bedrock/".length));

  it("default sort is value desc, then quality, then blended, then name, missing last", () => {
    // values: a q100/8 = 1250; b q50/0.2=12500; c q75/0.9275=6064 → b, c, a ; d,e have no value → quality (none) → blended (d 0.525) → name
    expect(ids(sortRows(rows, "value", "desc"))).toEqual(["b", "c", "a", "d", "e"]);
  });
  it("missing values sort last in both directions", () => {
    expect(ids(sortRows(rows, "intelligence", "asc")).slice(-2)).toEqual(["d", "e"]);
    expect(ids(sortRows(rows, "intelligence", "desc")).slice(-2)).toEqual(["d", "e"]);
    expect(ids(sortRows(rows, "intelligence", "asc"))[0]).toBe("b");
    expect(ids(sortRows(rows, "intelligence", "desc"))[0]).toBe("a");
  });
  it("sorts by measured eval cost with unevaluated rows last", () => {
    const evaluated = buildRows(
      [mk("amazon-bedrock/x", { input: 1, output: 2, name: "X" }), mk("amazon-bedrock/y", { input: 1, output: 2, name: "Y" }), mk("amazon-bedrock/z", { input: 1, output: 2, name: "Z" })],
      { ...scoring, lookup: (id) => (id.endsWith("/x") ? bm("x", { valetEval: { suite: "s", modelSpec: "m", cases: 1, runsPerCase: 1, passRate: 50, meanCostUsd: 0.03, ranAt: "2026-10-30" } }) : id.endsWith("/y") ? bm("y", { valetEval: { suite: "s", modelSpec: "m", cases: 1, runsPerCase: 1, passRate: 50, meanCostUsd: 0.001, ranAt: "2026-10-30" } }) : undefined) },
    );
    expect(ids(sortRows(evaluated, "evalCost", "asc"))).toEqual(["y", "x", "z"]);
    expect(ids(sortRows(evaluated, "evalCost", "desc"))).toEqual(["x", "y", "z"]);
  });
  it("sorts by name both ways and does not mutate the input", () => {
    const before = ids(rows);
    expect(ids(sortRows(rows, "name", "asc"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(sortRows(rows, "name", "desc"))).toEqual(["e", "d", "c", "b", "a"]);
    expect(ids(rows)).toEqual(before);
  });
  it("filters by name, id and provider text, case-insensitively", () => {
    expect(ids(filterRows(rows, { needle: "BRAVO" }))).toEqual(["b"]);
    expect(ids(filterRows(rows, { needle: "openrouter" }))).toEqual(["b"]);
    expect(ids(filterRows(rows, { needle: "amazon-bedrock/c" }))).toEqual(["c"]);
    expect(ids(filterRows(rows, { needle: "  " }))).toEqual(["a", "b", "c", "d", "e"]);
    expect(filterRows(rows, { needle: "zzz" })).toEqual([]);
  });
  it("filters by provider, approval, and current public score", () => {
    const mixed = buildRows(
      [
        mk("amazon-bedrock/a", { input: 4, output: 20, name: "Alpha" }),
        mk("amazon-bedrock/b", { input: 0.1, output: 0.5, name: "Bravo", providerName: "OpenRouter", approved: false }),
        mk("amazon-bedrock/d", { input: 0.3, output: 1.2, name: "Delta" }),
      ],
      { ...scoring, lookup: (id) => (id === "amazon-bedrock/a" ? bm("a", { intelligenceIndex: 60, indexVersion: "v5.0" }) : id === "amazon-bedrock/d" ? bm("d", { intelligenceIndex: 50, indexVersion: "v4.0" }) : undefined) },
    );
    expect(ids(filterRows(mixed, { provider: "OpenRouter" }))).toEqual(["b"]);
    expect(ids(filterRows(mixed, { approvedOnly: true }))).toEqual(["a", "d"]);
    // currentOnly keeps rows whose public score is on the latest index version;
    // an older-version score (d) and no score (b) are hidden.
    expect(ids(filterRows(mixed, { currentOnly: true, scoring }))).toEqual(["a"]);
    expect(ids(filterRows(mixed, { currentOnly: true, scoring, needle: "alpha" }))).toEqual(["a"]);
    expect(isCurrentScore(mixed[2].benchmark, scoring)).toBe(false);
    // A model with our own eval result is "current" even without a current public score.
    const evaluated = buildRows([mk("amazon-bedrock/d", { input: 0.3, output: 1.2, name: "Delta" })], {
      ...scoring,
      lookup: () => bm("d", { intelligenceIndex: 50, indexVersion: "v4.0", valetEval: { suite: "s", modelSpec: "m", cases: 1, runsPerCase: 1, passRate: 80, ranAt: "2026-10-30" } }),
    });
    expect(ids(filterRows(evaluated, { currentOnly: true, scoring }))).toEqual(["d"]);
  });
});
