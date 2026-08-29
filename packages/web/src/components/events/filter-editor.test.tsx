// @vitest-environment jsdom
/**
 * The pure conversion helpers behind the filter picker: form rows to the wire
 * shape and back. The picker's add/remove/edit interactions are covered end to
 * end by trigger-dialog.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { fromWireFilters, incompleteFilterRow, pruneFilterRows, toWireFilters } from "./filter-editor";

describe("toWireFilters", () => {
  it("drops rows with no field or a blank value", () => {
    expect(
      toWireFilters([
        { field: "", op: "eq", value: "x" },
        { field: "channel", op: "eq", value: "" },
        { field: "channel", op: "eq", value: "   " },
      ]),
    ).toEqual([]);
  });

  it("trims the value for eq, prefix, and contains", () => {
    expect(toWireFilters([{ field: "channel", op: "eq", value: "  C1 " }])).toEqual([
      { field: "channel", op: "eq", value: "C1" },
    ]);
  });

  it("splits an `in` value into a list and drops blank entries", () => {
    expect(toWireFilters([{ field: "reaction", op: "in", value: "tada, , rocket ," }])).toEqual([
      { field: "reaction", op: "in", value: ["tada", "rocket"] },
    ]);
  });

  it("drops an `in` row whose list is empty after splitting", () => {
    expect(toWireFilters([{ field: "reaction", op: "in", value: " , " }])).toEqual([]);
  });
});

describe("fromWireFilters", () => {
  it("round-trips eq and in through toWireFilters", () => {
    const wire = [
      { field: "channel", op: "eq", value: "C1" },
      { field: "reaction", op: "in", value: ["tada", "rocket"] },
    ];
    expect(toWireFilters(fromWireFilters(wire))).toEqual(wire);
  });

  it("tolerates malformed stored filters", () => {
    expect(
      fromWireFilters([null, 42, { field: "x" }, { field: "y", op: "bogus", value: 3 }]),
    ).toEqual([
      { field: "x", op: "eq", value: "" },
      { field: "y", op: "eq", value: "" },
    ]);
  });
});

describe("incompleteFilterRow", () => {
  it("returns the field of the first row with a field but no value", () => {
    expect(
      incompleteFilterRow([
        { field: "channel", op: "eq", value: "C1" },
        { field: "user", op: "eq", value: "  " },
      ]),
    ).toBe("user");
  });

  it("treats an `in` row with only separators as incomplete", () => {
    expect(incompleteFilterRow([{ field: "reaction", op: "in", value: " , " }])).toBe("reaction");
  });

  it("ignores a blank-field row and returns null when every row is complete", () => {
    expect(
      incompleteFilterRow([
        { field: "", op: "eq", value: "" },
        { field: "channel", op: "eq", value: "C1" },
      ]),
    ).toBeNull();
  });
});

describe("pruneFilterRows", () => {
  it("drops rows whose field is not among the available fields, keeping blank-field rows", () => {
    const rows = [
      { field: "channel", op: "eq" as const, value: "C1" },
      { field: "branch", op: "eq" as const, value: "main" },
      { field: "", op: "eq" as const, value: "" },
    ];
    expect(pruneFilterRows(rows, [{ field: "channel" }])).toEqual([
      { field: "channel", op: "eq", value: "C1" },
      { field: "", op: "eq", value: "" },
    ]);
  });
});
