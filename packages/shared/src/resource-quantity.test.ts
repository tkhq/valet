import { describe, expect, it } from "vitest";
import { parseResourceQuantity } from "./resource-quantity.js";

describe("parseResourceQuantity", () => {
  it.each([
    ["1n", 1],
    ["1m", 1],
    ["1", 1],
    ["1K", 1_000],
    ["1G", 1_000_000_000],
    ["0.001E", 1_000_000_000_000_000],
  ])("parses the DecimalSI quantity %s", (quantity, bytes) => {
    expect(parseResourceQuantity(quantity)).toBe(bytes);
  });

  it.each([
    ["1Ki", 1_024],
    ["1Gi", 1_073_741_824],
    ["0.001Ei", 1_152_921_504_606_847],
  ])("parses the BinarySI quantity %s", (quantity, bytes) => {
    expect(parseResourceQuantity(quantity)).toBe(bytes);
  });

  it("parses exponents and rounds fractional bytes away from zero", () => {
    expect(parseResourceQuantity("+1E+3")).toBe(1_000);
    expect(parseResourceQuantity("0.1")).toBe(1);
    expect(parseResourceQuantity("-1E-3")).toBe(-1);
  });

  it("preserves zero and rejects invalid or unsafe values", () => {
    expect(parseResourceQuantity("0m")).toBe(0);
    expect(parseResourceQuantity("1e309")).toBeNull();
    expect(parseResourceQuantity("1Ei")).toBeNull();
    expect(parseResourceQuantity("invalid")).toBeNull();
  });
});
