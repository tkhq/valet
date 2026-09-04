/**
 * Storage quantity coverage for create-time workspace sizing (TKAI-385).
 * Format coverage lives in workspace-pvc.test.ts, which exercises the same
 * functions through their re-export.
 */
import { describe, expect, it } from "vitest";
import { clampStorageRequest, parseStorageQuantity } from "../src/quantity.js";

describe("parseStorageQuantity", () => {
  it.each([
    ["1n", 1],
    ["1u", 1],
    ["1m", 1],
    ["1", 1],
    ["1k", 1_000],
    ["1K", 1_000],
    ["1M", 1_000_000],
    ["1G", 1_000_000_000],
    ["1T", 1_000_000_000_000],
    ["1P", 1_000_000_000_000_000],
    ["0.001E", 1_000_000_000_000_000],
  ])("parses the DecimalSI quantity %s", (quantity, bytes) => {
    expect(parseStorageQuantity(quantity)).toBe(bytes);
  });

  it.each([
    ["1Ki", 1_024],
    ["1Mi", 1_048_576],
    ["1Gi", 1_073_741_824],
    ["1Ti", 1_099_511_627_776],
    ["1Pi", 1_125_899_906_842_624],
    ["0.001Ei", 1_152_921_504_606_847],
  ])("parses the BinarySI quantity %s", (quantity, bytes) => {
    expect(parseStorageQuantity(quantity)).toBe(bytes);
  });

  it("parses decimal exponents with either marker and a signed exponent", () => {
    expect(parseStorageQuantity("1e3")).toBe(1_000);
    expect(parseStorageQuantity("+1E+3")).toBe(1_000);
    expect(parseStorageQuantity("1e-3")).toBe(1);
  });

  it("rounds positive fractional byte values up", () => {
    expect(parseStorageQuantity("1500m")).toBe(2);
    expect(parseStorageQuantity("0.1")).toBe(1);
    expect(parseStorageQuantity("0.0001m")).toBe(1);
  });

  it("keeps negative fractional byte values negative", () => {
    expect(parseStorageQuantity("-0.1")).toBe(-1);
    expect(parseStorageQuantity("-1m")).toBe(-1);
    expect(parseStorageQuantity("-1E-3")).toBe(-1);
    expect(clampStorageRequest("-0.1", "20Gi")).toBeNull();
  });

  it("preserves exact zero", () => {
    expect(parseStorageQuantity("0")).toBe(0);
    expect(parseStorageQuantity("0m")).toBe(0);
    expect(parseStorageQuantity("0e3")).toBe(0);
  });

  it("rejects non-finite or unsafe byte counts", () => {
    expect(parseStorageQuantity("1e309")).toBeNull();
    expect(parseStorageQuantity("1E")).toBeNull();
    expect(parseStorageQuantity("1Ei")).toBeNull();
  });
});

describe("clampStorageRequest", () => {
  it("returns the request verbatim when it fits under the cap", () => {
    expect(clampStorageRequest("4Gi", "20Gi")).toEqual({ storage: "4Gi", clamped: false });
    expect(clampStorageRequest("20Gi", "20Gi")).toEqual({ storage: "20Gi", clamped: false });
  });

  it("returns the cap verbatim when the request exceeds it", () => {
    expect(clampStorageRequest("50Gi", "20Gi")).toEqual({ storage: "20Gi", clamped: true });
  });

  it("trims whitespace-padded quantities — a padded value emitted verbatim fails CRD admission", () => {
    expect(clampStorageRequest("8Gi ", "20Gi")).toEqual({ storage: "8Gi", clamped: false });
    expect(clampStorageRequest(" 8Gi", "20Gi")).toEqual({ storage: "8Gi", clamped: false });
    expect(clampStorageRequest("50Gi", " 20Gi ")).toEqual({ storage: "20Gi", clamped: true });
  });

  it("compares across units (decimal request vs binary cap)", () => {
    // 3G = 3e9 bytes < 4Gi; 5G = 5e9 bytes > 4Gi (~4.29e9).
    expect(clampStorageRequest("3G", "4Gi")).toEqual({ storage: "3G", clamped: false });
    expect(clampStorageRequest("5G", "4Gi")).toEqual({ storage: "4Gi", clamped: true });
  });

  it("returns null on an unparseable request, cap, or non-positive value", () => {
    expect(clampStorageRequest("lots", "20Gi")).toBeNull();
    expect(clampStorageRequest("4Gi", "unlimited")).toBeNull();
    expect(clampStorageRequest("0", "20Gi")).toBeNull();
  });
});
