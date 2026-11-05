// @vitest-environment jsdom
/**
 * The pure conversion helpers behind the editor's conditions: form rows to
 * the wire shape and back, plus the provider-populated value picker's render
 * behavior. The editor's add and remove interactions are covered by
 * presence/editor/when-section.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The picker queries option lists through this hook. The tests drive its
// return value per case, so no react-query provider or network is needed.
const useFilterOptions = vi.fn();
vi.mock("~/api/events", () => ({
  useFilterOptions: (args: unknown, opts: unknown) => useFilterOptions(args, opts),
}));

import {
  FilterValuePicker,
  fromWireFilters,
  pruneFilterRows,
  sameWireFilters,
  toWireFilters,
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

describe("`in` labels round trip", () => {
  // Reply-created subscriptions store multi-channel filters as `in` values
  // with aligned display labels. An edit that leaves the list alone must
  // round-trip the labels, or later surfaces regress to raw C… ids.
  it("keeps the labels while the value list is unchanged", () => {
    const wire = [
      { field: "channel", op: "in", value: ["C1", "C2"], labels: ["#general", "#ops"] },
    ];
    expect(toWireFilters(fromWireFilters(wire))).toEqual(wire);
  });

  it("drops the labels when the list is edited (labels no longer align)", () => {
    const rows = fromWireFilters([
      { field: "channel", op: "in", value: ["C1", "C2"], labels: ["#general", "#ops"] },
    ]);
    rows[0] = { ...rows[0], value: "C1, C3" };
    expect(toWireFilters(rows)).toEqual([{ field: "channel", op: "in", value: ["C1", "C3"] }]);
  });

  it("ignores stored labels that do not align with the values", () => {
    const rows = fromWireFilters([
      { field: "channel", op: "in", value: ["C1", "C2"], labels: ["#general"] },
    ]);
    expect(toWireFilters(rows)).toEqual([{ field: "channel", op: "in", value: ["C1", "C2"] }]);
  });

  it("drops the labels when the field is switched (labels bind to the stored field)", () => {
    const rows = fromWireFilters([
      { field: "channel", op: "in", value: ["C1", "C2"], labels: ["#general", "#ops"] },
    ]);
    rows[0] = { ...rows[0], field: "user" };
    expect(toWireFilters(rows)).toEqual([{ field: "user", op: "in", value: ["C1", "C2"] }]);
  });
});

describe("sameWireFilters", () => {
  it("treats jsonb-reordered keys as the same rule", () => {
    expect(
      sameWireFilters(
        [{ op: "eq", field: "channel", label: "#general", value: "C1" }],
        [{ field: "channel", op: "eq", value: "C1", label: "#general" }],
      ),
    ).toBe(true);
  });

  it("treats a stored corner the form cannot represent as unchanged", () => {
    // A comma inside one `in` value re-splits through the form round trip;
    // both sides go through the same trip, so the rule still reads as equal.
    const stored = [{ field: "text", op: "in", value: ["a,b", "c"] }];
    expect(sameWireFilters(toWireFilters(fromWireFilters(stored)), stored)).toBe(true);
  });

  it("sees a real value change", () => {
    expect(
      sameWireFilters(
        [{ field: "channel", op: "eq", value: "C1" }],
        [{ field: "channel", op: "eq", value: "C2" }],
      ),
    ).toBe(false);
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

/** The picker for one field, as the editor's Add a condition renders it. */
function renderPicker(over: Partial<Parameters<typeof FilterValuePicker>[0]> = {}) {
  const onPick = vi.fn();
  const onFreeText = vi.fn();
  const utils = render(
    <FilterValuePicker source="slack.users" deps={{}} value="" onPick={onPick} onFreeText={onFreeText} {...over} />,
  );
  return { onPick, onFreeText, ...utils };
}

describe("FilterValuePicker", () => {
  it("queries the source and hands back the picked id plus its label", () => {
    useFilterOptions.mockReturnValue(
      optionsResult({ data: { options: [{ id: "U1", label: "Alice", hint: "@alice" }] } }),
    );
    const { onPick } = renderPicker();
    expect(useFilterOptions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack.users" }),
      expect.objectContaining({ enabled: true }),
    );
    // The results are a focus-driven popover: focus opens it, then the option
    // shows its label, not the raw id.
    fireEvent.focus(screen.getByLabelText("Filter value search"));
    fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
    expect(onPick).toHaveBeenCalledWith("U1", "Alice");
  });

  it("shows the stored label as the selection, not the raw id", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    const { container } = renderPicker({ value: "U1", label: "Alice" });
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(container.textContent).not.toContain("U1");
  });

  // An empty channel picker used to say only "No matches", which read as
  // "private channels are not supported". They are: the app has to be invited
  // to one first, because Slack sends no events for a channel it is not in.
  it("tells a reader how to reach a private channel when the list is empty", async () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    renderPicker({ source: "slack.channels" });
    fireEvent.focus(screen.getByLabelText("Filter value search"));
    const listbox = await screen.findByRole("listbox", { name: "Filter value options" });
    expect(listbox.textContent).toContain("invite the app to it in Slack");
  });

  // A rejected lookup settles with no data and an empty list, the same shape
  // as a real empty answer. Inviting the app cannot fix an outage.
  it("does not blame a missing invite when the lookup failed", async () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: undefined }));
    renderPicker({ source: "slack.channels" });
    fireEvent.focus(screen.getByLabelText("Filter value search"));
    const listbox = await screen.findByRole("listbox", { name: "Filter value options" });
    expect(listbox.textContent).toContain("Could not load the options");
    expect(listbox.textContent).not.toContain("invite the app");
  });

  it("keeps the plain answer for a source with no single fix", async () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    renderPicker();
    fireEvent.focus(screen.getByLabelText("Filter value search"));
    const listbox = await screen.findByRole("listbox", { name: "Filter value options" });
    expect(listbox.textContent).toContain("No matches");
    expect(listbox.textContent).not.toContain("invite the app");
  });

  it("disables the picker until every dependsOn value is present", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    renderPicker({ source: "slack.channels", dependsOn: ["repo"], deps: {} });
    const search = screen.getByLabelText("Filter value search") as HTMLInputElement;
    expect(search.disabled).toBe(true);
    expect(search.getAttribute("placeholder")).toContain("repo");
    expect(useFilterOptions).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack.channels" }),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("passes a present dependsOn value as a dep and enables the picker", () => {
    useFilterOptions.mockReturnValue(optionsResult({ data: { options: [] } }));
    renderPicker({ source: "slack.channels", dependsOn: ["repo"], deps: { repo: "acme/web" } });
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
    const { onFreeText } = renderPicker();
    expect(screen.getByText(/Connect the Slack integration/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "U9" } });
    expect(onFreeText).toHaveBeenCalledWith("U9");
  });
});
