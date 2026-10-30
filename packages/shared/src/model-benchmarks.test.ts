import { describe, expect, it } from "vitest";
import {
  MODEL_BENCHMARKS_SNAPSHOT,
  benchmarkFor,
  intelligenceCeilings,
  latestIndexVersion,
  type ModelBenchmarksSnapshot,
} from "./model-benchmarks.js";

const bare = (entries: ModelBenchmarksSnapshot["entries"]): ModelBenchmarksSnapshot => ({
  asOf: "x",
  source: { label: "", url: "", version: "" },
  entries,
});

describe("benchmarkFor", () => {
  it("drops the provider namespace and matches a Bedrock id with dots and a colon", () => {
    expect(benchmarkFor("amazon-bedrock/openai.gpt-oss-120b-1:0")?.family).toBe("gpt-oss-120b");
  });
  it("keeps nested OpenRouter ids after the first slash", () => {
    expect(benchmarkFor("openrouter/deepseek/deepseek-v4-pro")?.family).toBe("deepseek-v4-pro");
  });
  it("matches a bare legacy Anthropic id", () => {
    expect(benchmarkFor("claude-opus-5-5")?.family).toBe("claude-opus-5.5");
  });
  it("is case-insensitive and returns undefined for unknown ids", () => {
    expect(benchmarkFor("Amazon-Bedrock/US.ZAI.GLM-5.3")?.family).toBe("glm-5.3");
    expect(benchmarkFor("amazon-bedrock/vendor.brand-new-model")).toBeUndefined();
  });
  it("falls back to the bare Bedrock id when a geo profile prefix is not listed", () => {
    expect(benchmarkFor("amazon-bedrock/us.openai.gpt-5.5")?.family).toBe("gpt-5.5");
    expect(benchmarkFor("amazon-bedrock/global.anthropic.claude-opus-5-5")?.family).toBe("claude-opus-5.5");
    expect(benchmarkFor("amazon-bedrock/eu.zai.glm-5.3")?.family).toBe("glm-5.3");
    // Listed only as a `us.` profile; other geographies reach it through the stripped alias.
    expect(benchmarkFor("amazon-bedrock/global.moonshotai.kimi-k3")?.family).toBe("kimi-k3");
    expect(benchmarkFor("amazon-bedrock/moonshotai.kimi-k3")?.family).toBe("kimi-k3");
    expect(benchmarkFor("amazon-bedrock/us-gov.openai.gpt-oss-120b-1:0")?.family).toBe("gpt-oss-120b");
    // A dotted vendor prefix that is not a geo is not stripped.
    expect(benchmarkFor("amazon-bedrock/vendor.us.zai.glm-5.3")).toBeUndefined();
  });
  it("snapshot ids are unique across families and lower-case", () => {
    const all = MODEL_BENCHMARKS_SNAPSHOT.entries.flatMap((e) => e.ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => id === id.toLowerCase())).toBe(true);
  });
  it("snapshot families are unique and every entry has at least one id", () => {
    const families = MODEL_BENCHMARKS_SNAPSHOT.entries.map((e) => e.family);
    expect(new Set(families).size).toBe(families.length);
    expect(MODEL_BENCHMARKS_SNAPSHOT.entries.every((e) => e.ids.length > 0)).toBe(true);
  });
});

describe("intelligenceCeilings", () => {
  it("is the best score per index version, only for versions with at least three scored entries", () => {
    const ceilings = intelligenceCeilings(
      bare([
        { family: "a", name: "a", ids: ["a"], intelligenceIndex: 40, indexVersion: "v5.0" },
        { family: "b", name: "b", ids: ["b"], intelligenceIndex: 55, indexVersion: "v5.0" },
        { family: "c", name: "c", ids: ["c"], intelligenceIndex: 20, indexVersion: "v5.0" },
        { family: "d", name: "d", ids: ["d"], intelligenceIndex: 67, indexVersion: "v3.0" },
        { family: "e", name: "e", ids: ["e"] },
      ]),
    );
    expect(ceilings.get("v5.0")).toBe(55);
    expect(ceilings.has("v3.0")).toBe(false);
    expect(ceilings.size).toBe(1);
  });
  it("ignores a scored entry with no version", () => {
    expect(intelligenceCeilings(bare([{ family: "a", name: "a", ids: ["a"], intelligenceIndex: 40 }])).size).toBe(0);
  });
  it("the bundled snapshot has a v5.0 ceiling and every scored entry names its version", () => {
    expect(intelligenceCeilings().get("v5.0")).toBeGreaterThan(0);
    for (const e of MODEL_BENCHMARKS_SNAPSHOT.entries) {
      if (e.intelligenceIndex !== undefined) expect(e.indexVersion, e.family).toBeTruthy();
    }
  });
});

describe("latestIndexVersion", () => {
  it("picks the numerically highest vX.Y(.Z) among scored entries", () => {
    expect(
      latestIndexVersion(
        bare([
          { family: "a", name: "a", ids: ["a"], intelligenceIndex: 1, indexVersion: "v4.3.2" },
          { family: "b", name: "b", ids: ["b"], intelligenceIndex: 1, indexVersion: "v5.0" },
          { family: "c", name: "c", ids: ["c"], intelligenceIndex: 1, indexVersion: "v4.10" },
          { family: "d", name: "d", ids: ["d"], indexVersion: "v9.9" }, // unscored: ignored
        ]),
      ),
    ).toBe("v5.0");
    expect(latestIndexVersion(bare([{ family: "c", name: "c", ids: ["c"] }]))).toBeUndefined();
    expect(latestIndexVersion()).toBe("v5.0");
  });
});
