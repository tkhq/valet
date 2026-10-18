// @vitest-environment jsdom
/**
 * The Log merges this workspace's events and the organization's problems.
 * These cases pin the owner it asks for (it waits for the owner), the
 * chips (All, Problems, one per service), the receipts disclosure, and how
 * each kind of row reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventLogItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";

let lastParams: { owner: OwnerFilter | undefined; problems: boolean; diagnostics?: boolean; q?: string } | undefined;
let items: EventLogItem[] = [];
let owner: OwnerFilter | undefined = { ownerType: "user", ownerId: "u1" };
let role = "member";

vi.mock("~/api/events", () => ({
  useEventLog: (params: { owner: OwnerFilter | undefined; problems: boolean; diagnostics?: boolean; q?: string }) => {
    lastParams = params;
    const held = params.owner === undefined;
    return {
      data: held ? undefined : { pages: [{ items, nextCursor: null, lastEventAt: null, windowDays: 30 }] },
      isPending: held, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
    };
  },
  useEventSubscriptions: () => ({ data: { subscriptions: [] } }),
  useEventReceipts: () => ({ data: undefined, isPending: true, error: null, refetch: vi.fn() }),
}));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "u1", orgRole: role }, error: null, isError: false }) }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("./receipts-panel", () => ({ ReceiptsPanel: () => <p>Receipts list</p>, EventReceiptStages: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>
  ),
}));

import { EventLog, type LogFilter } from "./event-log";

afterEach(() => {
  cleanup();
  items = [];
  owner = { ownerType: "user", ownerId: "u1" };
  role = "member";
});

function renderLog(filter: LogFilter = "all") {
  const onFilterChange = vi.fn();
  render(<EventLog filter={filter} onFilterChange={onFilterChange} query="" onQueryChange={vi.fn()} />);
  return { onFilterChange };
}

const event: EventLogItem = {
  kind: "event", id: "ev_1", at: Date.now(), status: "failed", service: "github", eventKey: "github.pr.opened",
  summary: "PR #7 opened", actor: "octocat", reason: null, detail: null, deliveryCount: 2, place: "acme/app#7",
  deliveries: [{ id: "d1", subscriptionId: "sub_1", status: "dead", attempts: 4, lastError: "boom", deliveredAt: null }],
};
const problem: EventLogItem = {
  kind: "problem", id: "drop_1", at: Date.now() - 1000, status: "filtered", service: "slack", eventKey: "slack.message",
  summary: null, actor: null, reason: "filter_excluded", detail: "The text did not match.", deliveryCount: 0,
};

describe("EventLog", () => {
  it("asks for the workspace's Log and names the window", () => {
    renderLog();
    expect(lastParams).toMatchObject({ owner: { ownerType: "user", ownerId: "u1" }, problems: false });
    expect(screen.getByText(/last 30 days/)).toBeTruthy();
  });

  it("waits for the workspace owner before loading", () => {
    owner = undefined;
    renderLog();
    expect(lastParams?.owner).toBeUndefined();
    expect(screen.queryByText(/last 30 days/)).toBeNull();
  });

  it("asks for problems only on the Problems chip, and reports chip clicks", () => {
    const { onFilterChange } = renderLog("problems");
    expect(lastParams?.problems).toBe(true);
    expect(screen.getByRole("button", { name: "Problems" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });

  it("lists events as activity sentences and problems in one list, each with its status", () => {
    items = [event, problem];
    renderLog();
    expect(screen.getByRole("link", { name: "Pr opened in acme/app#7" }).getAttribute("href")).toBe("/presence/events/ev_1");
    expect(screen.getByText(/gave up after 4 attempts/)).toBeTruthy();
    expect(screen.getByText(/PR #7 opened · octocat/)).toBeTruthy();
    expect(screen.getByText(/The text did not match\./)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("keeps only a service's rows on its chip, and still asks for the whole Log", () => {
    items = [event, problem];
    renderLog("slack");
    expect(lastParams?.problems).toBe(false);
    expect(screen.getByRole("button", { name: "Slack" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("link", { name: "Pr opened in acme/app#7" })).toBeNull();
    expect(screen.getByText(/The text did not match\./)).toBeTruthy();
  });

  it("offers receipts to admins only, under a disclosure beside the list", () => {
    renderLog();
    expect(screen.queryByText("Receipts", { selector: "summary" })).toBeNull();
    cleanup();
    role = "admin";
    items = [event];
    renderLog();
    const disclosure = screen.getByText("Receipts", { selector: "summary" }).closest("details")!;
    expect(screen.queryByText("Receipts list")).toBeNull();
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(screen.getByText("Receipts list")).toBeTruthy();
    // The list stays, scoped to the workspace.
    expect(screen.getByRole("link", { name: "Pr opened in acme/app#7" })).toBeTruthy();
    expect(lastParams?.owner).toEqual({ ownerType: "user", ownerId: "u1" });
  });
});

it("opts into diagnostics and stops requesting them when switched off", () => {
  role = "admin";
  renderLog();
  expect(lastParams?.diagnostics).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Show diagnostics" }));
  expect(lastParams?.diagnostics).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Show diagnostics" }));
  expect(lastParams?.diagnostics).toBe(false);
});

describe("EventLog empty state", () => {
  function renderEmpty(props: { filter?: LogFilter; query?: string; place?: { key: string; name: string } }) {
    render(
      <EventLog
        filter={props.filter ?? "all"} onFilterChange={vi.fn()} query={props.query ?? ""} onQueryChange={vi.fn()}
        {...(props.place !== undefined ? { place: props.place.key, placeName: props.place.name } : {})}
      />,
    );
  }

  it("says nothing happened in the place when only the place filters", () => {
    renderEmpty({ place: { key: "github:acme/api", name: "acme/api" } });
    expect(screen.getByText("Nothing happened in acme/api in the last 30 days.")).toBeTruthy();
  });

  it("names the fix when a place and another filter match nothing", () => {
    renderEmpty({ filter: "problems", place: { key: "github:acme/api", name: "acme/api" } });
    expect(screen.getByText("Nothing matches. Choose All or remove the place.")).toBeTruthy();
    cleanup();
    renderEmpty({ query: "deploy" });
    expect(screen.getByText("Nothing matches. Choose All or clear Search.")).toBeTruthy();
  });

  it("says no activity yet only when nothing filters", () => {
    renderEmpty({});
    expect(screen.getByText(/^No activity yet\./)).toBeTruthy();
  });
});
