import { describe, expect, it } from "vitest";
import { formatTokens, formatUsd } from "./format-usage";

describe("formatTokens", () => {
  it("formats across magnitudes", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(5_600_000)).toBe("5.6M");
    expect(formatTokens(2_000_000_000)).toBe("2B");
  });
});

describe("formatUsd", () => {
  it("keeps cents under $10, rounds above, sub-cent floors", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(3.456)).toBe("$3.46");
    expect(formatUsd(42.9)).toBe("$43");
    expect(formatUsd(1500)).toBe("$1.5k");
  });
});
