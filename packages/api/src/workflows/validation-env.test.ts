import { describe, expect, it } from "vitest";
import { isKnownModelSpec } from "./validation-env.js";

describe("workflow model validation", () => {
  it.each(["openai/gpt-6-astra", "gpt-6-astra"])("accepts the supplemental model %s", (spec) => {
    expect(isKnownModelSpec(spec)).toBe(true);
  });

  it("still rejects unknown models and providers", () => {
    expect(isKnownModelSpec("openai/unknown-model")).toBe(false);
    expect(isKnownModelSpec("unknown-provider/gpt-6-astra")).toBe(false);
  });
});
