// @vitest-environment jsdom
/**
 * The pure conversion helpers behind the filter picker: form rows to the wire
 * shape and back — plus the provider-populated value picker's render behavior.
 * The picker's add/remove/edit interactions are covered end to end by
 * trigger-dialog.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The picker queries option lists through this hook. The tests drive its
// return value per case, so no react-query provider or network is needed.
const useFilterOptions = vi.fn();
vi.mock("~/api/events", () => ({
  useFilterOptions: (args: unknown, opts: unknown) => useFilterOptions(args, opts),
}));

import {
  FilterEditor,
  fromWireFilters,
  incompleteFilterRow,
  pruneFilterRows,
  toWireFilters,
  type FilterField,
  type UiFilterRow,
} from "./filter-editor";

/** A row literal with the required view-only `id`. The pure helpers ignore
 * `id`; a fixed value keeps the literals terse. */
function row(over: Partial<UiFilterRow> & Pick<UiFilterRow, "field" | "op" | "value">): UiFilterRow {
  return { id: "r", ...over };
}

describe("toWireFilters", () => {
  it("drops rows with no field or a blank value", () => {
    expect(
      toWireFilters([
        row({ field: "", op: "eq", value: "x" }),
        row({ field: "channel", op: "eq", value: "" }),
        row({ field: "channel", op: "eq", value: "   " }),
      ]),
    ).toEqual([]);
  });

  it("trims the value for eq, prefix, and contains", () => {
    expect(toWireFilters([row({ field: "channel", op: "eq", value: "  C1 " })])).toEqual([
      { field: "channel", op: "eq", value: "C1" },
    ]);
  });

  it("splits an `in` value into a list and drops blank entries", () => {
    expect(toWireFilters([row({ field: "reaction", op: "in", value: "tada, , rocket ," })])).toEqual([
      { field: "reaction", op: "in", value: ["tada", "rocket"] },
    ]);
  });

  it("does not emit the view-only id on the wire", () => {
    const wire = toWireFilters([row({ id: "abc", field: "channel", op: "eq", value: "C1" })]);
    expect(wire).toEqual([{ field: "channel", op: "eq", value: "C1" }]);
    expect(wire[0]).not.toHaveProperty("id");
  });

  it("drops an `in` row whose list is empty after splitting", () => {
    expect(toWireFilters([row({ field: "reaction", op: "in", value: " , " })])).toEqual([]);
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
    const rows = fromWireFilters([null, 42, { field: "x" }, { field: "y", op: "bogus", value: 3 }]);
    // Each rebuilt row carries a fresh, view-only id; assert the shape without it.
    expect(rows.map(({ id: _id, ...rest }) => rest)).toEqual([
      { field: "x", op: "eq", value: "" },
      { field: "y", op: "eq", value: "" },
    ]);
  });

  it("assigns a fresh, distinct id to each rebuilt row", () => {
    const rows = fromWireFilters([
      { field: "channel", op: "eq", value: "C1" },
      { field: "reaction", op: "in", value: ["tada"] },
    ]);
    expect(rows[0].id).toBeTruthy();
    expect(rows[1].id).toBeTruthy();
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});

describe("incompleteFilterRow", () => {
  it("returns the field of the first row with a field but no value", () => {
    expect(
      incompleteFilterRow([
        row({ field: "channel", op: "eq", value: "C1" }),
        row({ field: "user", op: "eq", value: "  " }),
      ]),
    ).toBe("user");
  });

  it("treats an `in` row with only separators as incomplete", () => {
    expect(incompleteFilterRow([row({ field: "reaction", op: "in", value: " , " })])).toBe("reaction");
  });

  it("ignores a blank-field row and returns null when every row is complete", () => {
    expect(
      incompleteFilterRow([
        row({ field: "", op: "eq", value: "" }),
        row({ field: "channel", op: "eq", value: "C1" }),
      ]),
    ).toBeNull();
  });
});

describe("pruneFilterRows", () => {
  it("drops rows whose field is not among the available fields, keeping blank-field rows, and keeps each id", () => {
    const rows = [
      row({ id: "r1", field: "channel", op: "eq", value: "C1" }),
      row({ id: "r2", field: "branch", op: "eq", value: "main" }),
      row({ id: "r3", field: "", op: "eq", value: "" }),
    ];
    expect(pruneFilterRows(rows, [{ field: "channel" }])).toEqual([
      { id: "r1", field: "channel", op: "eq", value: "C1" },
      { id: "r3", field: "", op: "eq", value: "" },
    ]);
  });
});

describe("label + regex round trip", () => {
  it("emits the label on a non-`in` row and reads it back", () => {
    const rows: UiFilterRow[] = [row({ field: "user", op: "eq", value: "U1", label: "Alice" })];
    const wire = toWireFilters(rows);
    expect(wire).toEqual([{ field: "user", op: "eq", value: "U1", label: "Alice" }]);
    // `fromWireFilters` mints a fresh id, so compare the shape without it.
    const rebuilt = fromWireFilters(wire).map(({ id: _id, ...rest }) => rest);
    expect(rebuilt).toEqual([{ field: "user", op: "eq", value: "U1", label: "Alice" }]);
  });

  it("drops the label on an `in` row (multi-value has no single label)", () => {
    expect(toWireFilters([row({ field: "user", op: "in", value: "U1, U2", label: "Alice" })])).toEqual([
      { field: "user", op: "in", value: ["U1", "U2"] },
    ]);
  });

  it("round-trips the regex op", () => {
    const wire = [{ field: "branch", op: "regex", value: "^release/" }];
    expect(toWireFilters(fromWireFilters(wire))).toEqual(wire);
  });
});

/** A `useFilterOptions` return the component accepts. Only the fields the
 * picker reads are set; the mock stands in for the react-query result. */
function optionsResult(over: {
  data?: { options: { id: string; label: string; hint?: string }[]; reason?: string };
  isLoading?: boolean;
}) {
  return { data: over.data, isLoading: over.isLoading ?? false };
}

describe("FilterEditor value picker", () => {
  it("queries the source and stores the picked id plus its label", () => {
    useFilterOptions.mockReturnValue(
      optionsResult({ data: { options: [{ id: "U1", label: "Alice", hint: "@alice" }] } }),
    );
    const fields: FilterField[] = [{ field: "user", options: { source: "slack.users" } }];
    const rows: UiFilterRow[] = [row({ id: "r1", field: "user", op: "eq", value: "" })];
    const onChange = vi.fn();
    render(<FilterEditor fields={fields} rows={rows} onChange={onChange} />);

    // The hook is queried for the field's source (enabled — no dependsOn gap).
    expect(useFilterOptions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack.users" }),
      expect.objectContaining({ enabled: true }),
    );

    // The option shows its label, not the raw id. An update preserves the row id.
    fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
    expect(onChange).toHaveBeenCalledWith([
      { id: "r1", field: "user", op: "eq", value: "U1", label: "Alice" },
    ]);
  });

  it("shows the stored label as the selection, not the raw id", () => {
    // No `@testing-library/jest-dom` in this package, so assertions read raw
    // DOM state (`textContent`, `disabled`, `getAttribute`).
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    const fields: FilterField[] = [{ field: "user", options: { source: "slack.users" } }];
    const rows: UiFilterRow[] = [row({ field: "user", op: "eq", value: "U1", label: "Alice" })];
    const { container } = render(<FilterEditor fields={fields} rows={rows} onChange={vi.fn()} />);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(container.textContent).not.toContain("U1");
  });

  it("disables the picker until every dependsOn value is present", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    const fields: FilterField[] = [
      { field: "repo", description: "Repository" },
      { field: "channel", options: { source: "slack.channels", dependsOn: ["repo"] } },
    ];
    const rows: UiFilterRow[] = [
      row({ id: "r-repo", field: "repo", op: "eq", value: "" }),
      row({ id: "r-chan", field: "channel", op: "eq", value: "" }),
    ];
    render(<FilterEditor fields={fields} rows={rows} onChange={vi.fn()} />);

    // The picker is disabled and names the field to fill first.
    const search = screen.getByLabelText("Filter value search") as HTMLInputElement;
    expect(search.disabled).toBe(true);
    expect(search.getAttribute("placeholder")).toContain("repo");
    // The disabled picker does not query the provider.
    expect(useFilterOptions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack.channels" }),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("passes a present dependsOn value as a dep and enables the picker", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    const fields: FilterField[] = [
      { field: "repo", description: "Repository" },
      { field: "channel", options: { source: "slack.channels", dependsOn: ["repo"] } },
    ];
    const rows: UiFilterRow[] = [
      row({ id: "r-repo", field: "repo", op: "eq", value: "acme/web" }),
      row({ id: "r-chan", field: "channel", op: "eq", value: "" }),
    ];
    render(<FilterEditor fields={fields} rows={rows} onChange={vi.fn()} />);
    const search = screen.getByLabelText("Filter value search") as HTMLInputElement;
    expect(search.disabled).toBe(false);
    expect(useFilterOptions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack.channels", deps: { repo: "acme/web" } }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("falls back to free text and shows the reason when the source cannot resolve", () => {
    useFilterOptions.mockReturnValue(
      optionsResult({ data: { options: [], reason: "Connect the Slack integration in Settings." } }),
    );
    const fields: FilterField[] = [{ field: "user", options: { source: "slack.users" } }];
    const rows: UiFilterRow[] = [row({ id: "r1", field: "user", op: "eq", value: "" })];
    const onChange = vi.fn();
    render(<FilterEditor fields={fields} rows={rows} onChange={onChange} />);

    expect(screen.getByText(/Connect the Slack integration/)).toBeTruthy();
    // The fallback is a plain value input that writes straight to the row.
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "U9" } });
    expect(onChange).toHaveBeenCalledWith([
      { id: "r1", field: "user", op: "eq", value: "U9", label: undefined },
    ]);
  });

  it("renders a plain text input for a field with no option source", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    const fields: FilterField[] = [{ field: "branch", description: "Base branch" }];
    const rows: UiFilterRow[] = [row({ id: "r1", field: "branch", op: "eq", value: "" })];
    const onChange = vi.fn();
    render(<FilterEditor fields={fields} rows={rows} onChange={onChange} />);
    // No search box; the plain value input is present.
    expect(screen.queryByLabelText("Filter value search")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    expect(onChange).toHaveBeenCalledWith([
      { id: "r1", field: "branch", op: "eq", value: "main", label: undefined },
    ]);
  });
});
