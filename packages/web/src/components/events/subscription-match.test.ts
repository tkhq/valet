// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UiFilterRow } from "./filter-editor";
import { restorePinnedRows, useSubscriptionMatch, type CatalogService } from "./subscription-match";

const SERVICES: CatalogService[] = [{
  service: "slack",
  entries: [
    { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
    { key: "slack.team_join", description: "Member joined" },
  ],
}];

const PIN: UiFilterRow = { id: "pin-channel", field: "channel", op: "eq", value: "C900", label: "incidents" };

function render() {
  return renderHook(() => useSubscriptionMatch(SERVICES, ["slack.message"], () => [PIN], [PIN]));
}

describe("useSubscriptionMatch pinned rows", () => {
  it("brings back a pinned row that an event change pruned", () => {
    const { result } = render();
    act(() => result.current.toggleKey("slack.team_join"));
    expect(result.current.filterRows).toEqual([PIN]);
    // Only an event without the channel field is left: pruning drops the pin.
    act(() => result.current.toggleKey("slack.message"));
    expect(result.current.filterRows).toEqual([]);
    act(() => result.current.toggleKey("slack.message"));
    expect(result.current.filterRows).toEqual([PIN]);
  });

  it("keeps a pinned row the reader removed out on a later event change", () => {
    const { result } = render();
    act(() => result.current.setFilterRows([]));
    act(() => result.current.toggleKey("slack.team_join"));
    act(() => result.current.toggleKey("slack.message"));
    act(() => result.current.toggleKey("slack.message"));
    expect(result.current.filterRows).toEqual([]);
  });
});

describe("restorePinnedRows", () => {
  it("adds a pin only when a field allows it and no row holds its field", () => {
    expect(restorePinnedRows([], [PIN], [])).toEqual([]);
    expect(restorePinnedRows([], [PIN], [{ field: "channel" }])).toEqual([PIN]);
    const own: UiFilterRow = { id: "own", field: "channel", op: "eq", value: "C1" };
    expect(restorePinnedRows([own], [PIN], [{ field: "channel" }])).toEqual([own]);
  });
});
