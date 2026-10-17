// @vitest-environment jsdom
/**
 * The Presence rail (spec Part B): the order, the counts, the mid-grain
 * rows under a service-wide header, the dots, and the filter box past
 * eight places. The data hooks are mocked; `railGroups` is tested as a
 * pure function.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/presence";
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname } }),
  Link: ({ to, params, children, className, "aria-current": current }: {
    to: string; params?: Record<string, string>; children: ReactNode; className?: string; "aria-current"?: "page";
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, encodeURIComponent(value)), to);
    return <a href={path} className={className} aria-current={current}>{children}</a>;
  },
}));

function place(subject: string, label: string, service: PresencePlaceWire["service"], parent: string | null, listenerCount: number, activeThreadCount = 0, scopeLabel?: string): PresencePlaceWire {
  return { subject, label, service, parent, listenerCount, activeThreadCount, lastActivityAt: null, ...(scopeLabel ? { scopeLabel } : {}) };
}

const SLACK_ROOT = place("slack:T1", "Slack", "slack", null, 0);
const INCIDENTS = place("slack:T1/C900", "#incidents", "slack", "slack:T1", 2, 1);
const SLACK_THREAD = place("slack:T1/C900/1700.1", "Slack thread", "slack", "slack:T1/C900", 1);
const ACME_API = place("github:acme/api", "acme/api", "github", null, 3, 0, "Across acme/api");
const ACME_PR = place("github:acme/api#12", "acme/api#12", "github", "github:acme/api", 1);
const LINEAR_ROOT = place("linear:*", "Linear", "linear", null, 0);
const LINEAR_ISSUE = place("linear:ENG-42", "ENG-42", "linear", null, 1);

let places: PresencePlaceWire[] = [];
let problems = { count: 0, problemPlaces: new Set<string>() as ReadonlySet<string> };
const ROUTINE: WorkflowTriggerItem = {
  kind: "schedule", id: "S1", name: "S1", enabled: true,
  detail: { cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Hi.", nextFireAt: 1, lastFiredAt: null, ownerType: "user", ownerId: "u-001" },
};

vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => ({ ownerType: "user", ownerId: "u-001" }) }));
vi.mock("~/api/presence", () => ({ usePresencePlaces: () => ({ data: { places } }) }));
vi.mock("~/api/workflows", () => ({
  useWorkflowTriggers: () => ({ isSuccess: true, data: { triggers: [ROUTINE, { ...ROUTINE, id: "S2" }] } }),
}));
vi.mock("./use-problem-count", () => ({ useProblemCount: () => problems }));
vi.mock("~/components/workflows/trigger-dialog", () => ({
  TriggerDialog: ({ schedulesOnly }: { schedulesOnly?: boolean }) => <p>{schedulesOnly ? "Routine dialog" : "Other dialog"}</p>,
}));

import { PresenceRail, RAIL_FILTER_THRESHOLD, railGroups } from "./presence-rail";

beforeEach(() => {
  pathname = "/presence";
  places = [SLACK_ROOT, INCIDENTS, SLACK_THREAD, ACME_API, ACME_PR, LINEAR_ROOT, LINEAR_ISSUE];
  problems = { count: 0, problemPlaces: new Set() };
});

describe("railGroups", () => {
  it("keeps only mid-grain rows and puts the service-wide row as root", () => {
    const groups = railGroups(places, new Set());
    expect(groups.map((group) => group.service)).toEqual(["slack", "github"]);
    expect(groups[0]!.root).toBe(SLACK_ROOT);
    expect(groups[0]!.places.map((p) => p.subject)).toEqual(["slack:T1/C900"]);
    expect(groups[1]!.root).toBeUndefined();
    expect(groups[1]!.places.map((p) => p.subject)).toEqual(["github:acme/api"]);
  });

  it("drops a group with no mid-grain row and no line at its root, and keeps one whose root has lines", () => {
    expect(railGroups([LINEAR_ROOT, LINEAR_ISSUE], new Set())).toEqual([]);
    const busyRoot = { ...LINEAR_ROOT, listenerCount: 2 };
    expect(railGroups([busyRoot], new Set())).toEqual([{ service: "linear", root: busyRoot, places: [] }]);
  });

  it("sets the count, the active flag, and the problem flag", () => {
    const [slack] = railGroups(places, new Set(["slack:T1/C900"]));
    expect(slack!.places[0]).toEqual({ subject: "slack:T1/C900", label: "#incidents", service: "slack", count: 2, active: true, problem: true });
    const [github] = railGroups([ACME_API], new Set());
    expect(github!.places[0]).toMatchObject({ count: 3, active: false, problem: false });
  });
});

describe("PresenceRail", () => {
  it("lists New routine, Activity, Routines, then the groups in order", () => {
    problems = { count: 3, problemPlaces: new Set(["slack:T1/C900"]) };
    render(<PresenceRail />);
    const nav = screen.getByRole("navigation", { name: "Presence" });
    const text = nav.textContent ?? "";
    const order = ["New routine", "Activity", "Routines", "Everywhere in Slack", "#incidents", "Across GitHub", "acme/api"];
    const positions = order.map((word) => text.lastIndexOf(word));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(within(nav).queryByText("acme/api#12")).toBeNull();
    expect(within(nav).queryByText("ENG-42")).toBeNull();
    expect(within(nav).queryByText("Slack thread")).toBeNull();
  });

  it("shows the problem count as a badge, the routine count, and the place counts and dots", () => {
    problems = { count: 3, problemPlaces: new Set(["slack:T1/C900"]) };
    render(<PresenceRail />);
    const activity = screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/presence" && link.textContent?.startsWith("Activity"));
    expect(activity?.textContent).toBe("Activity3");
    expect(screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/presence/routines")?.textContent).toBe("Routines2");
    const incidents = screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/presence/places/${encodeURIComponent("slack:T1/C900")}`)!;
    expect(incidents.textContent).toBe("#incidents2");
    expect(within(incidents).getByRole("img", { name: "Active thread" })).toBeTruthy();
    expect(within(incidents).getByRole("img", { name: "Has a problem" })).toBeTruthy();
    const acme = screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/presence/places/${encodeURIComponent("github:acme/api")}`)!;
    expect(within(acme).queryByRole("img")).toBeNull();
  });

  it("hides the badge when there is no problem", () => {
    render(<PresenceRail />);
    const activity = screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/presence" && link.textContent?.startsWith("Activity"));
    expect(activity?.textContent).toBe("Activity");
  });

  it("links the group header to the service-wide place, and shows plain text when the list has none", () => {
    render(<PresenceRail />);
    const header = screen.getByRole("link", { name: "Everywhere in Slack" });
    expect(header.getAttribute("href")).toBe(`/presence/places/${encodeURIComponent("slack:T1")}`);
    expect(screen.getByText("Across GitHub").closest("a")).toBeNull();
  });

  it("marks the selected place", () => {
    pathname = `/presence/places/${encodeURIComponent("slack:T1/C900")}`;
    render(<PresenceRail />);
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["#incidents2"]);
  });

  it("opens the routine dialog for schedules from New routine", () => {
    render(<PresenceRail />);
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    expect(screen.getByText("Routine dialog")).toBeTruthy();
  });

  it("shows no filter box at the threshold", () => {
    places = Array.from({ length: RAIL_FILTER_THRESHOLD }, (_, i) => place(`github:acme/r${i}`, `acme/r${i}`, "github", null, 1));
    render(<PresenceRail />);
    expect(screen.queryByRole("searchbox", { name: "Filter places" })).toBeNull();
    expect(document.querySelector("details")).toBeNull();
  });

  it("past the threshold, shows the filter box, collapses the groups, and opens the selected group", () => {
    places = [
      SLACK_ROOT,
      INCIDENTS,
      ...Array.from({ length: RAIL_FILTER_THRESHOLD }, (_, i) => place(`github:acme/r${i}`, `acme/r${i}`, "github", null, 1)),
    ];
    pathname = `/presence/places/${encodeURIComponent("slack:T1/C900")}`;
    render(<PresenceRail />);
    const details = [...document.querySelectorAll("details")];
    expect(details.map((d) => [d.querySelector("summary")?.textContent, d.open])).toEqual([["Slack", true], ["GitHub", false]]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter places" }), { target: { value: "R3" } });
    const filtered = [...document.querySelectorAll("details")];
    expect(filtered.map((d) => [d.querySelector("summary")?.textContent, d.open])).toEqual([["GitHub", true]]);
    expect(screen.getByText("acme/r3")).toBeTruthy();
    expect(screen.queryByText("acme/r4")).toBeNull();
  });
});
