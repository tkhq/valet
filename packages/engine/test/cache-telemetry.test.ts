import { describe, it, expect } from "vitest";
import { classifyCacheBreak, type CacheTurnSnapshot } from "../src/index.js";

const base: CacheTurnSnapshot = {
  promptTokens: 50_000,
  cacheRead: 48_000,
  modelId: "claude-fable-5",
  systemPromptLength: 9_000,
  toolCount: 12,
};

function next(overrides: Partial<CacheTurnSnapshot>): CacheTurnSnapshot {
  return { ...base, ...overrides };
}

describe("classifyCacheBreak (TKAI-320)", () => {
  it("no break when the new turn reads roughly the previous prompt from cache", () => {
    expect(classifyCacheBreak(base, next({ promptTokens: 53_000, cacheRead: 49_500 }))).toBeUndefined();
  });

  it("small conversations never alert", () => {
    const tiny = next({ promptTokens: 3_000, cacheRead: 0 });
    expect(classifyCacheBreak(tiny, next({ cacheRead: 0 }))).toBeUndefined();
  });

  it("attributes a break to a model change first", () => {
    expect(
      classifyCacheBreak(base, next({ cacheRead: 0, modelId: "claude-haiku-4-5" })),
    ).toBe("model_changed");
  });

  it("attributes a break to a system prompt rewrite", () => {
    expect(
      classifyCacheBreak(base, next({ cacheRead: 0, systemPromptLength: 9_450 })),
    ).toBe("system_prompt_changed");
  });

  it("attributes a break to a tool-list change", () => {
    expect(classifyCacheBreak(base, next({ cacheRead: 0, toolCount: 13 }))).toBe("tools_changed");
  });

  it("falls back to ttl_or_content when nothing client-side explains it", () => {
    expect(classifyCacheBreak(base, next({ cacheRead: 0 }))).toBe("ttl_or_content");
  });

  it("tolerates partial reads above the loose threshold", () => {
    // 60% of the previous prompt read from cache — noisy, not a break.
    expect(classifyCacheBreak(base, next({ cacheRead: 30_000 }))).toBeUndefined();
  });
});
