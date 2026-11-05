// @vitest-environment jsdom
/**
 * The Activity timeline (docs/specs/2026-10-16-presence-hub-design.md Part
 * D step 1.7): grouped by day, a filled mark for acted and a hollow one for
 * skipped, chips that filter the kinds, and `Show earlier`.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityTimeline, dayHeading, groupByDay, type TimelineEntry } from "./line-activity";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

// Noon today, so the entries a minute or two before it never cross midnight.
const NOW = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
const ENTRIES: TimelineEntry[] = [
  { id: "d-2", kind: "acted", at: NOW - 60_000, parts: [{ kind: "text", text: "Completed check on acme/api#14 → worked in Platform CI" }], took: "2 min" },
  { id: "receipt:r-1", kind: "skipped", at: NOW - 120_000, parts: [{ kind: "text", text: "Completed check on acme/web#8 → skipped, not for this line: the repository filter" }] },
  { id: "d-1", kind: "acted", at: NOW - 86_400_000 - 60_000, parts: [{ kind: "text", text: "Completed check on acme/api#12 → could not reach Platform CI, it is archived" }], took: "gave up", tookDanger: true },
];

function rows(): HTMLElement[] {
  return Array.from(screen.getByRole("region", { name: "Activity" }).querySelectorAll<HTMLElement>("li"));
}

describe("ActivityTimeline", () => {
  it("groups by day with a filled mark for acted and a hollow mark for skipped", () => {
    render(<ActivityTimeline entries={ENTRIES} />);
    const section = screen.getByRole("region", { name: "Activity" });
    const headings = within(section).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe(dayHeading(NOW - 60_000));
    expect(rows().map((row) => row.dataset.kind)).toEqual(["acted", "skipped", "acted"]);
    expect(rows()[0]?.querySelector("[data-mark]")?.className).toMatch(/\bbg-moss\b/);
    expect(rows()[1]?.querySelector("[data-mark]")?.className).toMatch(/border-muted/);
    expect(within(rows()[0]!).getByText("2 min")).toBeTruthy();
    expect(within(rows()[2]!).getByText("gave up").className).toMatch(/text-danger-500/);
  });

  it("keeps only the chosen kind", () => {
    render(<ActivityTimeline entries={ENTRIES} />);
    const chips = screen.getByRole("group", { name: "Show" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Acted", "Skipped"]);
    fireEvent.click(within(chips).getByRole("button", { name: "Skipped" }));
    expect(rows().map((row) => row.dataset.kind)).toEqual(["skipped"]);
    fireEvent.click(within(chips).getByRole("button", { name: "Acted" }));
    expect(rows().map((row) => row.dataset.kind)).toEqual(["acted", "acted"]);
    fireEvent.click(within(chips).getByRole("button", { name: "All" }));
    expect(rows()).toHaveLength(3);
  });

  it("names how to see every entry when a chip hides them all", () => {
    render(<ActivityTimeline entries={[ENTRIES[0]!]} />);
    fireEvent.click(screen.getByRole("button", { name: "Skipped" }));
    expect(screen.getByText("Nothing skipped here yet. Choose All to see every entry.")).toBeTruthy();
  });

  it("loads the next page from Show earlier", () => {
    const onShowEarlier = vi.fn();
    render(<ActivityTimeline entries={ENTRIES} hasMore onShowEarlier={onShowEarlier} />);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(onShowEarlier).toHaveBeenCalledTimes(1);
  });

  it("says what appears here when nothing happened yet", () => {
    render(<ActivityTimeline entries={[]} />);
    expect(screen.getByText("Nothing yet. Activity appears here when an event reaches this line.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
  });

  it("points to Show earlier when the loaded pages are empty but older ones exist (S13)", () => {
    render(<ActivityTimeline entries={[]} hasMore onShowEarlier={() => {}} />);
    expect(screen.getByText("Nothing in the newest entries. To look further back, select Show earlier.")).toBeTruthy();
    expect(screen.queryByText("Nothing yet. Activity appears here when an event reaches this line.")).toBeNull();
    expect(screen.getByRole("button", { name: "Show earlier" })).toBeTruthy();
  });

  it("hides the chips for a timeline with no skipped entries", () => {
    render(<ActivityTimeline entries={[ENTRIES[0]!]} chips={false} />);
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
  });
});

describe("dayHeading and groupByDay", () => {
  it("reads Today, Yesterday, then the date", () => {
    const now = new Date(2026, 9, 18, 9, 0).getTime();
    expect(dayHeading(new Date(2026, 9, 18, 0, 5).getTime(), now)).toBe("Today");
    expect(dayHeading(new Date(2026, 9, 17, 23, 55).getTime(), now)).toBe("Yesterday");
    expect(dayHeading(new Date(2026, 9, 10, 12).getTime(), now)).not.toMatch(/Today|Yesterday/);
    expect(groupByDay(ENTRIES, NOW).map((g) => g.entries.map((e) => e.id))).toEqual([["d-2", "receipt:r-1"], ["d-1"]]);
  });
});
