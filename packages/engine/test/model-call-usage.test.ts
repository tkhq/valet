import { describe, expect, it } from "vitest";
import { modelCallUsage } from "../src/model-call-usage.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("modelCallUsage", () => {
  it("omits usage when no tokens were reported and cost when no price was", () => {
    expect(modelCallUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero }))
      .toEqual({ reported: zero });
    expect(modelCallUsage({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero })).toEqual({
      reported: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
    });
    expect(modelCallUsage({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { ...zero, input: 0.5, total: 0.5 } }))
      .toMatchObject({ usage: { total: 12 }, cost: { input: 0.5, total: 0.5 } });
  });
});
