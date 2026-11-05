import { describe, expect, it } from "vitest";
import { formatContext, formatPerMillion, formatRate, formatTokens, formatTurns, formatUsd, formatUsdPrecise } from "./format-usage";

describe("formatTokens", () => {
  it("formats across magnitudes", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(5_600_000)).toBe("5.6M");
    expect(formatTokens(2_000_000_000)).toBe("2B");
  });
});

describe("formatUsdPrecise", () => {
  it("keeps four decimals below a dollar and never shows a nonzero cost as zero", () => {
    expect(formatUsdPrecise(0)).toBe("$0.0000");
    expect(formatUsdPrecise(0.00001)).toBe("<$0.0001");
    expect(formatUsdPrecise(0.00421)).toBe("$0.0042");
    expect(formatUsdPrecise(0.2634)).toBe("$0.2634");
  });

  it("shows cents from a dollar up, so totals read as money", () => {
    expect(formatUsdPrecise(3.456)).toBe("$3.46");
    expect(formatUsdPrecise(184.2017)).toBe("$184.20");
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

describe("formatTurns", () => {
  it("names one turn in the singular", () => {
    expect(formatTurns(1)).toBe("1 turn");
    expect(formatTurns(0)).toBe("0 turns");
    expect(formatTurns(1204)).toBe(`${(1204).toLocaleString()} turns`);
  });
});

describe("formatPerMillion", () => {
  it("renders list prices as input / output per million tokens", () => {
    expect(formatPerMillion({ input: 0.62, output: 1.85 })).toBe("$0.62 in / $1.85 out per 1M tokens");
    expect(formatPerMillion({ input: 3.3, output: 16.5 })).toBe("$3.30 in / $16.50 out per 1M tokens");
  });
  it("keeps sub-cent rates visible instead of rounding to $0.00", () => {
    expect(formatPerMillion({ input: 0.005, output: 0.0825 })).toBe("$0.005 in / $0.08 out per 1M tokens");
  });
  it("returns undefined when pricing is missing or free", () => {
    expect(formatPerMillion(undefined)).toBeUndefined();
    expect(formatPerMillion({ input: 0, output: 0 })).toBeUndefined();
  });
  it("short form fits a chip", () => {
    expect(formatPerMillion({ input: 0.62, output: 1.85 }, "short")).toBe("$0.62 / $1.85");
  });
});

describe("formatRate / formatContext", () => {
  it("formats one per-million rate", () => {
    expect(formatRate(0.62)).toBe("$0.62");
    expect(formatRate(16.5)).toBe("$16.50");
    expect(formatRate(0.005)).toBe("$0.005");
    expect(formatRate(0)).toBeUndefined();
    expect(formatRate(undefined)).toBeUndefined();
  });
  it("formats a context window", () => {
    expect(formatContext(131072)).toBe("131k");
    expect(formatContext(262144)).toBe("262k");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_048_576)).toBe("1M");
    expect(formatContext(8192)).toBe("8k");
    expect(formatContext(undefined)).toBeUndefined();
  });
});
