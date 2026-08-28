// @vitest-environment jsdom
/**
 * The pure conversion helpers behind the filter picker: form rows to the wire
 * shape and back. The picker's add/remove/edit interactions are covered end to
 * end by trigger-dialog.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { fromWireFilters, toWireFilters } from "./filter-editor";

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
