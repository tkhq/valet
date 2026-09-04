/**
 * Reasoning-level vocabulary and per-call resolution (pure).
 *
 * The clamp runs at STREAM time, not at set time: a thread pinned to "max"
 * keeps that pin while it runs a model that only supports "high" — switch
 * back to a capable model and the original pin applies again.
 */
import { describe, it, expect } from "vitest";
import { getModel, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { isReasoningLevel, parseReasoningLevel, resolveReasoningLevel, REASONING_LEVELS } from "../src/index.js";

const registryModel: Model<Api> = getModel("anthropic", "claude-haiku-4-5");
/** A model with full extended-thinking support. */
const thinker: Model<Api> = {
  ...registryModel,
  reasoning: true,
  thinkingLevelMap: { minimal: "1", low: "2", medium: "3", high: "4", xhigh: "5", max: "6" },
};
/** A reasoning model whose provider tops out at "high". */
const cappedThinker: Model<Api> = { ...thinker, thinkingLevelMap: { xhigh: null, max: null } };
/** A model with no reasoning support at all. */
const plain: Model<Api> = { ...registryModel, reasoning: false, thinkingLevelMap: undefined };

describe("engine: reasoning levels", () => {
  it("names the six levels in ascending order", () => {
    expect(REASONING_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("recognizes only the six tokens", () => {
    expect(isReasoningLevel("medium")).toBe(true);
    expect(isReasoningLevel("off")).toBe(false);
    expect(isReasoningLevel("turbo")).toBe(false);
    expect(isReasoningLevel(3)).toBe(false);
  });

  it("parses a persisted token and drops an unreadable one", () => {
    expect(parseReasoningLevel("xhigh")).toBe("xhigh");
    expect(parseReasoningLevel(null)).toBeUndefined();
    expect(parseReasoningLevel(undefined)).toBeUndefined();
    // A row written by an older/newer build must not crash a restore.
    expect(parseReasoningLevel("ultra")).toBeUndefined();
  });

  it("layers per-call over thread pin over session default", () => {
    expect(resolveReasoningLevel(thinker, "low", "medium", "high")).toBe("low");
    expect(resolveReasoningLevel(thinker, undefined, "medium", "high")).toBe("medium");
    expect(resolveReasoningLevel(thinker, undefined, undefined, "high")).toBe("high");
    expect(resolveReasoningLevel(thinker, undefined, undefined, undefined)).toBeUndefined();
  });

  it("clamps the effective level to what the model supports", () => {
    expect(resolveReasoningLevel(cappedThinker, undefined, "max", undefined)).toBe("high");
    expect(resolveReasoningLevel(cappedThinker, undefined, "low", undefined)).toBe("low");
  });

  it("returns undefined for a model without reasoning support", () => {
    // pi-ai clamps to "off" there; StreamOptions.reasoning takes no "off",
    // so the engine sends nothing and the provider default applies.
    expect(resolveReasoningLevel(plain, "max", undefined, undefined)).toBeUndefined();
  });
});
