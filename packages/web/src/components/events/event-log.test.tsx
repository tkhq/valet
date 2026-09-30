// @vitest-environment jsdom
/**
 * The Log merges stored events and recorded problems. These cases pin the
 * owner it asks for (an owner-less request is the whole org, so "This
 * workspace" waits for the owner), the status chips, and how each kind of row
 * reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventLogItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";

let lastParams: { owner?: OwnerFilter; status?: string; q?: string } | undefined;
let lastEnabled: boolean | undefined;
let items: EventLogItem[] = [];
let owner: OwnerFilter | undefined = { ownerType: "user", ownerId: "u1" };
let role = "member";

vi.mock("~/api/events", () => ({
  useEventLog: (params: { owner?: OwnerFilter; status?: string; q?: string }, opts: { enabled?: boolean }) => {
    lastParams = params;
    lastEnabled = opts.enabled;
    const held = opts.enabled === false;
    return {
      data: held ? undefined : { pages: [{ items, nextCursor: null, lastEventAt: null, windowDays: params.owner ? 30 : null }] },
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

import { EventLog, type LogFilter, type LogScope } from "./event-log";

afterEach(() => {
  cleanup();
  items = [];
  owner = { ownerType: "user", ownerId: "u1" };
  role = "member";
});

function renderLog(props: { scope?: LogScope; filter?: LogFilter } = {}) {
  const onFilterChange = vi.fn();
  render(<EventLog scope={props.scope ?? "workspace"} onScopeChange={vi.fn()} filter={props.filter ?? "all"}
    onFilterChange={onFilterChange} query="" onQueryChange={vi.fn()} />);
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
  it("asks for the workspace's events, and holds until the owner resolves", () => {
    renderLog();
    expect(lastParams?.owner).toEqual({ ownerType: "user", ownerId: "u1" });
    expect(lastEnabled).toBe(true);
    cleanup();
    owner = undefined;
    renderLog();
    expect(lastEnabled).toBe(false);
  });

  it("drops the owner on All, and names the window only for a workspace", () => {
    renderLog({ scope: "all" });
    expect(lastParams?.owner).toBeUndefined();
    expect(screen.queryByText(/last 30 days/)).toBeNull();
    cleanup();
    renderLog();
    expect(screen.getByText(/last 30 days/)).toBeTruthy();
  });

  it("sends the chosen status and reports chip clicks to the route", () => {
    const { onFilterChange } = renderLog({ filter: "failed" });
    expect(lastParams?.status).toBe("failed");
    expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Filtered out" }));
    expect(onFilterChange).toHaveBeenCalledWith("filtered");
  });

  it("lists events and problems in one list, each with its status", () => {
    items = [event, problem];
    renderLog();
    expect(screen.getByRole("link", { name: "PR #7 opened" }).getAttribute("href")).toBe("/events/$eventId");
    expect(screen.getByText("The text did not match.")).toBeTruthy();
    expect(screen.getAllByText("Filtered out").length).toBeGreaterThan(1);
    expect(screen.getByText(/2 deliveries/)).toBeTruthy();
  });

  it("offers raw receipts to admins only, in place of the list", () => {
    renderLog();
    expect(screen.queryByRole("button", { name: "Raw receipts" })).toBeNull();
    cleanup();
    role = "admin";
    renderLog({ filter: "receipts" });
    expect(screen.getByText("Receipts list")).toBeTruthy();
    expect(lastEnabled).toBe(false);
  });
});
