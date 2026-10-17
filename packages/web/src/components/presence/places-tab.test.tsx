// @vitest-environment jsdom
/**
 * The Places tab (docs/specs/2026-10-16-presence-hub-design.md Part B; H2):
 * groups by service, parent rows, counts, and the **All listeners** toggle.
 * Review Focus 2: a listener over two channels counts once, on the
 * `Everywhere in Slack` row, not on each channel.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ListPresencePlacesResponse, PresencePlaceWire } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href}>{children}</a>;
  },
}));

const listPresencePlaces = vi.fn<(scope: string) => Promise<ListPresencePlacesResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, api: { ...actual.api, listPresencePlaces: (scope: string) => listPresencePlaces(scope) } };
});

let scopeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: scopeTeamId ?? "user", teamId: scopeTeamId, available: ["user"], setKey: () => {} }),
}));

vi.mock("./all-listeners-table", () => ({ AllListenersTable: () => <p>Listener table</p> }));
vi.mock("~/components/events/automation-wizard", () => ({ AutomationWizard: () => <p>Wizard</p> }));
vi.mock("~/components/events/team-slack-setup", () => ({
  ListenButton: ({ teamId, children }: { teamId: string; children: ReactNode }) => <button type="button">{children} for {teamId}</button>,
}));

import { PlacesTab, placeLines, type PlacesView } from "./places-tab";

function place(over: Partial<PresencePlaceWire> & Pick<PresencePlaceWire, "subject" | "label" | "service">): PresencePlaceWire {
  return { parent: null, listenerCount: 0, activeThreadCount: 0, lastActivityAt: null, ...over };
}

/** The acceptance universe: `#incidents` and `acme/api` with two subject threads. */
const PLACES: PresencePlaceWire[] = [
  place({ subject: "slack:T1", label: "Slack", service: "slack" }),
  place({ subject: "slack:T1/C900", label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 2, activeThreadCount: 1, lastActivityAt: 5_000 }),
  place({ subject: "github:acme/api", label: "acme/api", scopeLabel: "Across acme/api", service: "github", listenerCount: 2 }),
  place({ subject: "github:acme/api#12", label: "acme/api#12", service: "github", parent: "github:acme/api" }),
  place({ subject: "github:acme/api#13", label: "acme/api#13", service: "github", parent: "github:acme/api", activeThreadCount: 2 }),
];

function renderTab(view: PlacesView = "places", onViewChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PlacesTab view={view} onViewChange={onViewChange} /></QueryClientProvider>);
  return onViewChange;
}

/** A row's visible text, keyed by the place name it links. */
function row(name: string): string {
  const link = screen.getByRole("link", { name });
  return link.closest("div.flex.min-w-0.flex-col")?.textContent ?? "";
}

beforeEach(() => {
  scopeTeamId = undefined;
  listPresencePlaces.mockReset();
  listPresencePlaces.mockResolvedValue({ places: PLACES });
});

describe("PlacesTab", () => {
  it("groups places by service, in order, with counts and active threads (H2)", async () => {
    renderTab();
    await screen.findByRole("link", { name: "#incidents" });
    expect(listPresencePlaces).toHaveBeenCalledWith("user");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Slack", "GitHub", "Linear"]);

    const slack = within(screen.getByRole("region", { name: "Slack" }));
    expect(slack.getByRole("link", { name: "#incidents" }).getAttribute("href")).toBe("/presence/places/slack:T1/C900");
    expect(row("#incidents")).toContain("2 listeners · 1 active thread");
    expect(slack.getByText("Active")).toBeTruthy();
    // The Slack workspace row has nothing of its own, so the group heading stands for it.
    expect(slack.queryByRole("link", { name: "Slack" })).toBeNull();

    const github = within(screen.getByRole("region", { name: "GitHub" }));
    expect(github.getByRole("link", { name: "acme/api" })).toBeTruthy();
    expect(row("acme/api")).toContain("Across acme/api · 2 listeners · No active thread");
    expect(row("acme/api#12")).toContain("No listeners · No active thread");
    expect(row("acme/api#13")).toContain("No listeners · 2 active threads");

    expect(within(screen.getByRole("region", { name: "Linear" })).getByText("Valet is in no Linear team in this workspace yet.")).toBeTruthy();
  });

  it("nests a child row in a list inside its parent's item", async () => {
    renderTab();
    await screen.findByRole("link", { name: "acme/api" });
    const inside = screen.getByRole("list", { name: "Inside acme/api" });
    expect(within(inside).getAllByRole("listitem").map((item) => within(item).getByRole("link").textContent)).toEqual(["acme/api#12", "acme/api#13"]);
    // The parent's item holds the nested list.
    expect(screen.getByRole("link", { name: "acme/api" }).closest("li")?.contains(inside)).toBe(true);
  });

  it("lists a listener over two channels once, under Everywhere in Slack (Review Focus 2)", async () => {
    listPresencePlaces.mockResolvedValue({
      places: [
        place({ subject: "slack:T1", label: "Slack", scopeLabel: "Everywhere in Slack", service: "slack", listenerCount: 1 }),
        place({ subject: "slack:T1/C1", label: "#alerts", service: "slack", parent: "slack:T1", lastActivityAt: 1 }),
        place({ subject: "slack:T1/C2", label: "#deploys", service: "slack", parent: "slack:T1", lastActivityAt: 1 }),
      ],
    });
    renderTab();
    await screen.findByRole("link", { name: "Slack" });
    expect(screen.getAllByText(/Everywhere in Slack/)).toHaveLength(1);
    expect(row("Slack")).toContain("Everywhere in Slack · 1 listener");
    expect(row("#alerts")).toContain("No listeners");
    expect(row("#deploys")).toContain("No listeners");
  });

  it("reads the team workspace's places and offers its channel setup", async () => {
    scopeTeamId = "sre";
    renderTab();
    await screen.findByRole("link", { name: "#incidents" });
    expect(listPresencePlaces).toHaveBeenCalledWith("sre");
    expect(screen.getByRole("button", { name: "Listen in channels for sre" })).toBeTruthy();
  });

  it("switches to All listeners with a labelled toggle", async () => {
    const onViewChange = renderTab();
    const toggle = within(screen.getByRole("group", { name: "Places view" }));
    expect(toggle.getByRole("button", { name: "Places" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle.getByRole("button", { name: "All listeners" }));
    expect(onViewChange).toHaveBeenCalledWith("listeners");
  });

  it("shows the flat table in the All listeners view", () => {
    renderTab("listeners");
    expect(screen.getByText("Listener table")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Slack" })).toBeNull();
    expect(listPresencePlaces).not.toHaveBeenCalled();
  });

  it("shows the server's text when the read fails", async () => {
    listPresencePlaces.mockRejectedValue(new Error("boom"));
    renderTab();
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
  });
});

describe("placeLines", () => {
  it("nests children under a shown parent and promotes them under a hidden service row", () => {
    expect(placeLines(PLACES, "slack").map((l) => [l.place.label, l.depth])).toEqual([["#incidents", 0]]);
    expect(placeLines(PLACES, "github").map((l) => [l.place.label, l.depth])).toEqual([
      ["acme/api", 0], ["acme/api#12", 1], ["acme/api#13", 1],
    ]);
  });

  it("shows a service row that has an active thread", () => {
    const lines = placeLines([place({ subject: "linear:*", label: "Linear", service: "linear", activeThreadCount: 1 })], "linear");
    expect(lines.map((l) => l.place.label)).toEqual(["Linear"]);
  });
});
