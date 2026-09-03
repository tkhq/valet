/**
 * `clampStorageRequest` unit coverage (create-time workspace sizing,
 * TKAI-385). Parse/format coverage lives in workspace-pvc.test.ts, which
 * exercises the same functions through their re-export.
 */
import { describe, expect, it } from "vitest";
import { clampStorageRequest } from "../src/quantity.js";

describe("clampStorageRequest", () => {
  it("returns the request verbatim when it fits under the cap", () => {
    expect(clampStorageRequest("4Gi", "20Gi")).toEqual({ storage: "4Gi", clamped: false });
    expect(clampStorageRequest("20Gi", "20Gi")).toEqual({ storage: "20Gi", clamped: false });
  });

  it("returns the cap verbatim when the request exceeds it", () => {
    expect(clampStorageRequest("50Gi", "20Gi")).toEqual({ storage: "20Gi", clamped: true });
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
