// @vitest-environment jsdom
/**
 * The Activity tab (spec 2026-10-16 presence hub, Part E): each stored event
 * leads with `<event in words> in <place> → <outcome>`, a thread in the
 * outcome links to the thread, and the deliveries and receipt stages stay
 * under a disclosure. The filters live in the URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EventDeliveryWire, EventLogItem, EventSubscriptionWire } from "@valet/api/wire";

let items: EventLogItem[] = [];
let role = "admin";
const receiptsQuery = vi.fn();

const workflowListener: EventSubscriptionWire = {
  id: "sub-wf", name: "Run triage", ownerType: "user", ownerId: "u1", eventKeys: ["github.check_run.completed"], filters: [],
  target: { kind: "workflow", workflowId: "wf-1" }, enabled: true, createdBy: "u1", createdAt: 1, updatedAt: 1,
};

vi.mock("~/api/events", () => ({
  useEventLog: () => ({
    data: { pages: [{ items, nextCursor: null, lastEventAt: null, windowDays: 30 }] },
    isPending: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
  }),
  useEventSubscriptions: () => ({ data: { subscriptions: [workflowListener] } }),
  useEventReceipts: (...args: unknown[]) => {
    receiptsQuery(...args);
    return {
      data: { receipts: [{ id: "rc-1", service: "slack", externalId: "Ev1", eventKey: "slack.app_mention", eventId: "ev-mention", metadata: {},
        stages: [{ stage: "classification", outcome: "accepted", detail: "Mention classified", at: 1000 }], subscriptions: [], createdAt: 1000, updatedAt: 1000 }],
        nextCursor: null, lastReceiptAt: 1000, retentionDays: 7 },
      isPending: false, error: null, refetch: vi.fn(),
    };
  },
}));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [{ id: "wf-1", name: "Triage failures" }] } }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "u1", orgId: "org-1", orgRole: role }, error: null, isError: false }) }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => ({ ownerType: "user", ownerId: "u1" }) }));
vi.mock("~/components/events/receipts-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/events/receipts-panel")>();
  return { ...actual, ReceiptsPanel: () => <p>Receipts list</p> };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: { children: ReactNode; to: string; params?: Record<string, string>; className?: string }) => (
    <a className={className} href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>
  ),
}));

import { ActivityTab, readActivitySearch } from "./activity-tab";

afterEach(() => {
  cleanup();
  items = [];
  role = "admin";
  receiptsQuery.mockClear();
});

function delivery(over: Partial<EventDeliveryWire>): EventDeliveryWire {
  return { id: "d-1", subscriptionId: "sub-1", subscriptionName: "Incidents", status: "delivered", attempts: 1, lastError: null, deliveredAt: 1, ...over };
}

function eventItem(id: string, eventKey: string, place: string | undefined, deliveries: EventDeliveryWire[]): EventLogItem {
  return {
    kind: "event", id, at: Date.now(), status: "delivered", service: eventKey.split(".")[0] ?? null, eventKey,
    summary: `summary of ${id}`, actor: "octocat", reason: null, detail: null, deliveryCount: deliveries.length,
    ...(place !== undefined ? { place } : {}), deliveries,
  };
}

const tInc = { sessionId: "s", threadId: "t-inc-id", title: "t-inc" };

function renderTab(search = {}) {
  const onSearchChange = vi.fn();
  render(<ActivityTab search={search} onSearchChange={onSearchChange} />);
  return { onSearchChange };
}

/** The row's sentence: the title cell of the row whose lead links to `eventId`. */
function sentenceFor(eventId: string): HTMLElement {
  const lead = screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/presence/events/${eventId}`);
  if (!lead?.parentElement) throw new Error(`no row for ${eventId}`);
  return lead.parentElement;
}

describe("ActivityTab rows", () => {
  it.each([
    ["replied in <thread>", eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })]), "Mention in #incidents → replied in t-inc"],
    ["delivered to <thread>", eventItem("ev-check", "github.check_run.completed", "acme/api", [delivery({ thread: { sessionId: "s", threadId: "t-ci", title: "Platform CI" } })]), "Completed check in acme/api → delivered to Platform CI"],
    ["claimed by <thread>", eventItem("ev-message", "slack.message", "#incidents", [delivery({ status: "skipped", lastError: "Skipped, claimed by thread t-inc-id.", claimedBy: tInc })]), "Message in #incidents → claimed by t-inc"],
    ["started <workflow> run", eventItem("ev-run", "github.check_run.completed", "acme/api", [delivery({ subscriptionId: "sub-wf", runId: "run-1" })]), "Completed check in acme/api → started Triage failures run"],
    ["skipped: <reason>", eventItem("ev-skip", "github.check_run.completed", "acme/api", [delivery({ status: "skipped", lastError: "Skipped by delivery preferences" })]), "Completed check in acme/api → skipped: delivery preferences"],
    ["no listener", eventItem("ev-none", "github.check_run.completed", "acme/api", []), "Completed check in acme/api → no listener"],
  ])("reads %s", (_name, item, sentence) => {
    items = [item];
    renderTab();
    expect(sentenceFor(item.id).textContent).toBe(sentence);
  });

  it("links the lead to the event page, a thread to its thread, and a run to its run", () => {
    items = [
      eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })]),
      eventItem("ev-run", "github.check_run.completed", "acme/api", [delivery({ subscriptionId: "sub-wf", runId: "run-1" })]),
    ];
    renderTab();
    expect(screen.getByRole("link", { name: "Mention in #incidents" }).getAttribute("href")).toBe("/presence/events/ev-mention");
    expect(screen.getByRole("link", { name: "t-inc" }).getAttribute("href")).toBe("/threads/t-inc-id");
    expect(screen.getByRole("link", { name: "started Triage failures run" }).getAttribute("href")).toBe("/presence/runs/run-1");
  });

  it("names a claim by a thread the viewer may not open as another thread, never by id", () => {
    items = [eventItem("ev-message", "slack.message", "#incidents", [delivery({ status: "skipped", lastError: "Skipped, claimed by another thread." })])];
    renderTab();
    expect(sentenceFor("ev-message").textContent).toBe("Message in #incidents → claimed by another thread");
    // An older server still sends the thread's id in the skip text.
    cleanup();
    items = [eventItem("ev-message", "slack.message", "#incidents", [delivery({ status: "skipped", lastError: "Skipped, claimed by thread t-secret." })])];
    renderTab();
    expect(sentenceFor("ev-message").textContent).toBe("Message in #incidents → claimed by another thread");
    expect(document.body.textContent).not.toContain("t-secret");
  });

  it("keeps a claim by a thread archived later, with a disabled link (Review Focus 4)", () => {
    const archived = { sessionId: "s", threadId: "t-old-id", title: "t-old", archived: true as const };
    items = [eventItem("ev-message", "slack.message", "#incidents", [delivery({ status: "skipped", lastError: "Skipped, claimed by thread t-old-id.", claimedBy: archived })])];
    renderTab();
    expect(sentenceFor("ev-message").textContent).toBe("Message in #incidents → claimed by t-old");
    const link = screen.getByRole("link", { name: "t-old" });
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.getAttribute("href")).toBeNull();
  });

  it("keeps the deliveries and the receipt stages under a disclosure", () => {
    items = [eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })])];
    renderTab();
    const disclosure = screen.getByText("Receipt stages").closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(within(disclosure).queryByText("Incidents")).toBeNull();
    expect(receiptsQuery).not.toHaveBeenCalled();
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(within(disclosure).getByText("Incidents")).toBeTruthy();
    expect(receiptsQuery).toHaveBeenLastCalledWith("org-1", { q: "ev-mention", limit: 5 }, true);
    const stages = within(within(disclosure).getByRole("region", { name: "Processing timeline" })).getAllByRole("listitem");
    expect(stages[0]?.textContent).toContain("Mention classified");
  });

  it("tells a member that receipt stages are for administrators", () => {
    role = "member";
    items = [eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })])];
    renderTab();
    const disclosure = screen.getByText("Receipt stages").closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(within(disclosure).getByText("Receipt stages are available to organization administrators.")).toBeTruthy();
  });

  it("names its window in the Terminology words", () => {
    items = [eventItem("ev-none", "github.check_run.completed", "acme/api", [])];
    renderTab();
    expect(screen.getByText(/Listener activity from the last 30 days/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/subscription|trigger|automation/i);
  });
});

describe("ActivityTab search", () => {
  it("reads only the Log's filters, and drops a hand-edited status", () => {
    expect(readActivitySearch({ status: "problems", q: "boom", tab: "log" })).toEqual({ status: "problems", q: "boom" });
    expect(readActivitySearch({ status: "everything", q: "" })).toEqual({});
    expect(readActivitySearch(null)).toEqual({});
  });

  it("writes a filter change and keeps the search", () => {
    const { onSearchChange } = renderTab({ q: "boom" });
    fireEvent.click(screen.getByRole("button", { name: "Problems" }));
    expect(onSearchChange).toHaveBeenCalledWith({ status: "problems", q: "boom" });
  });

  it("writes the whole Log as no status", () => {
    const { onSearchChange } = renderTab({ status: "problems" });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onSearchChange).toHaveBeenCalledWith({});
  });
});
