/**
 * Unit tests for the shared jsonb read/write helpers. The read helpers MUST
 * pass driver-parsed values through verbatim — the regression they pin is a
 * read-time re-parse of a top-level jsonb string, which throws on non-JSON
 * text and silently changes the type of JSON-shaped text ("123" → 123).
 * Round-trips through real drivers are covered by the workflow store
 * conformance suites (packages/api/src/workflows/pg-store.test.ts).
 */
import { describe, expect, it } from "vitest";
import { fromJsonbColumn, jsonbToParam, requiredJsonbColumn } from "../src/helpers.js";

describe("jsonbToParam", () => {
  it("maps undefined to SQL NULL", () => {
    expect(jsonbToParam(undefined)).toBeNull();
  });

  it("stringifies every other value, including null and strings", () => {
    expect(jsonbToParam(null)).toBe("null");
    expect(jsonbToParam("tasks[10]:\n  - not json")).toBe(JSON.stringify("tasks[10]:\n  - not json"));
    expect(jsonbToParam({ a: 1 })).toBe('{"a":1}');
  });
});

describe("fromJsonbColumn", () => {
  it("maps null/undefined to undefined", () => {
    expect(fromJsonbColumn(null)).toBeUndefined();
    expect(fromJsonbColumn(undefined)).toBeUndefined();
  });

  it("passes a top-level string through verbatim (no re-parse)", () => {
    const text = "records[50]:\n  - record_id: 04b39761 (not JSON)";
    expect(fromJsonbColumn<string>(text)).toBe(text);
  });

  it("keeps a JSON-shaped string a string (no silent type change)", () => {
    expect(fromJsonbColumn<string>("123")).toBe("123");
    expect(fromJsonbColumn<string>("true")).toBe("true");
    expect(fromJsonbColumn<string>('{"a":1}')).toBe('{"a":1}');
  });

  it("passes objects and arrays through verbatim", () => {
    const obj = { a: 1, nested: { b: [2, 3] } };
    expect(fromJsonbColumn(obj)).toBe(obj);
  });
});

describe("requiredJsonbColumn", () => {
  it("throws on null/undefined, naming the field", () => {
    expect(() => requiredJsonbColumn(null, "params")).toThrow("expected jsonb value for params");
    expect(() => requiredJsonbColumn(undefined, "params")).toThrow("expected jsonb value for params");
  });

  it("passes a top-level string through verbatim", () => {
    expect(requiredJsonbColumn<string>("123", "result")).toBe("123");
  });
});
