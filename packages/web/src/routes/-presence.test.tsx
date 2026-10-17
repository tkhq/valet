// @vitest-environment jsdom
/**
 * The Presence section frame (spec Part A): the title, the subtitle, and the
 * five tabs in order. Detail pages (a place, a listener, an event, a
 * workflow, a run) render without the tab frame.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/components/workspace-clause", () => ({ WorkspaceClause: () => null }));

import { PRESENCE_TABS, PresenceTabsFrame, presenceTabFor } from "./presence";

describe("presenceTabFor", () => {
  it.each([
    ["/presence", "places"],
    ["/presence/", "places"],
    ["/presence/routines", "routines"],
    ["/presence/activity", "activity"],
    ["/presence/workflows", "workflows"],
    ["/presence/workflows/", "workflows"],
    ["/presence/runs", "runs"],
  ])("reads %s as the %s tab", (pathname, tab) => {
    expect(presenceTabFor(pathname)).toBe(tab);
  });

  it.each([
    "/presence/places/slack%3AC1",
    "/presence/listeners/sub-1",
    "/presence/events/ev-1",
    "/presence/workflows/wf-1",
    "/presence/runs/run-1",
  ])("reads the detail page %s as no tab", (pathname) => {
    expect(presenceTabFor(pathname)).toBeUndefined();
  });
});

describe("PresenceTabsFrame", () => {
  it("names the section, states its subtitle, and lists the tabs in order", () => {
    render(<PresenceTabsFrame active="places" onSelect={() => {}}><p>places body</p></PresenceTabsFrame>);
    expect(screen.getByRole("heading", { level: 1, name: "Presence" })).toBeTruthy();
    expect(screen.getByText("Where Valet is, and what it does there.")).toBeTruthy();
    const tabs = within(screen.getByRole("tablist", { name: "Presence sections" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Places", "Routines", "Activity", "Workflows", "Runs"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("places body");
  });

  it("selects a tab by id", async () => {
    const onSelect = vi.fn();
    render(<PresenceTabsFrame active="places" onSelect={onSelect}><p /></PresenceTabsFrame>);
    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(onSelect).toHaveBeenCalledWith("runs");
  });

  it("maps every tab to its own route", () => {
    expect(PRESENCE_TABS.map((tab) => tab.to)).toEqual([
      "/presence",
      "/presence/routines",
      "/presence/activity",
      "/presence/workflows",
      "/presence/runs",
    ]);
  });
});
