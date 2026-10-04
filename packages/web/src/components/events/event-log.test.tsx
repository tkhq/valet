// @vitest-environment jsdom
/**
 * The Log merges this workspace's events and the organization's problems.
 * These cases pin the owner it asks for (it waits for the owner), the two
 * chips, and how each kind of row reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventLogItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";

let lastParams: { owner: OwnerFilter | undefined; problems: boolean; q?: string } | undefined;
let items: EventLogItem[] = [];
let owner: OwnerFilter | undefined = { ownerType: "user", ownerId: "u1" };
let role = "member";

vi.mock("~/api/events", () => ({
  useEventLog: (params: { owner: OwnerFilter | undefined; problems: boolean; q?: string }) => {
    lastParams = params;
    const held = params.owner === undefined;
    return {
      data: held ? undefined : { pages: [{ items, nextCursor: null, lastEventAt: null, windowDays: 30 }] },
      isPending: held, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
    };
  },
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "u1", orgRole: role }, error: null, isError: false }) }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("./receipts-panel", () => ({ ReceiptsPanel: () => <p>Receipts list</p> }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
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
  summary: "PR #7 opened", actor: "octocat", reason: null, detail: null, deliveryCount: 2,
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

  it("lists events and problems in one list, each with its status", () => {
    items = [event, problem];
    renderLog();
    expect(screen.getByRole("link", { name: "PR #7 opened" }).getAttribute("href")).toBe("/events/$eventId");
    expect(screen.getByText(/The text did not match\./)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/2 deliveries/)).toBeTruthy();
  });

  it("offers raw receipts to admins only, in place of the list", () => {
    renderLog();
    expect(screen.queryByRole("button", { name: "Raw receipts" })).toBeNull();
    cleanup();
    role = "admin";
    renderLog("receipts");
    expect(screen.getByText("Receipts list")).toBeTruthy();
    expect(lastParams?.owner).toBeUndefined();
  });
});
