// @vitest-environment jsdom
/**
 * The Activity pane (spec 2026-10-16 presence hub, Part F): each stored event
 * leads with `<event in words> in <place> → <outcome>`, a thread in the
 * outcome links to the thread, and the deliveries and receipt stages stay
 * under a disclosure. The chips (`All`, `Problems`, one per service) and the
 * Place box live in the URL; receipts sit under a disclosure for admins. With
 * no place and no routine, the pane shows the onboarding cards (Part C step 8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EventDeliveryWire, EventLogItem, EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";

let items: EventLogItem[] = [];
let role = "admin";
const ONE_PLACE: PresencePlaceWire = {
  subject: "slack:T1:C900", label: "#incidents", service: "slack", parent: null, listenerCount: 1, activeThreadCount: 0, lastActivityAt: null,
};
let places: PresencePlaceWire[] | undefined = [ONE_PLACE];
let triggers: WorkflowTriggerItem[] | undefined = [];
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
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: { workflows: [{ id: "wf-1", name: "Triage failures" }] } }),
  useWorkflowTriggers: () => (triggers === undefined ? { isSuccess: false, data: undefined } : { isSuccess: true, data: { triggers } }),
}));
vi.mock("~/api/presence", () => ({
  usePresencePlaces: () => (places === undefined ? { isSuccess: false, data: undefined } : { isSuccess: true, data: { places } }),
}));
vi.mock("~/components/workflows/trigger-dialog", () => ({
  TriggerDialog: ({ schedulesOnly }: { schedulesOnly?: boolean }) => <p>{schedulesOnly ? "New routine dialog" : "Other dialog"}</p>,
}));
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

import { ActivityPane, readActivitySearch } from "./activity-pane";

afterEach(() => {
  cleanup();
  items = [];
  role = "admin";
  places = [ONE_PLACE];
  triggers = [];
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
  render(<ActivityPane search={search} onSearchChange={onSearchChange} />);
  return { onSearchChange };
}

/** The row's sentence: the title cell of the row whose lead links to `eventId`. */
function sentenceFor(eventId: string): HTMLElement {
  const lead = screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/presence/events/${eventId}`);
  if (!lead?.parentElement) throw new Error(`no row for ${eventId}`);
  return lead.parentElement;
}

describe("ActivityPane rows", () => {
  it.each([
    ["replied in <thread>", eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })]), "Mention in #incidents → replied in t-inc"],
    ["delivered to <thread>", eventItem("ev-check", "github.check_run.completed", "acme/api", [delivery({ thread: { sessionId: "s", threadId: "t-ci", title: "Platform CI" } })]), "Completed check in acme/api → delivered to Platform CI"],
    ["claimed by <thread>", eventItem("ev-message", "slack.message", "#incidents", [delivery({ status: "skipped", lastError: "Skipped, claimed by thread t-inc-id.", claimedBy: tInc })]), "Message in #incidents → claimed by t-inc"],
    ["started <workflow> run", eventItem("ev-run", "github.check_run.completed", "acme/api", [delivery({ subscriptionId: "sub-wf", runId: "run-1" })]), "Completed check in acme/api → started Triage failures run"],
    ["skipped: <reason>", eventItem("ev-skip", "github.check_run.completed", "acme/api", [delivery({ status: "skipped", lastError: "Skipped by delivery preferences" })]), "Completed check in acme/api → skipped: delivery preferences"],
    ["no listener", eventItem("ev-none", "github.check_run.completed", "acme/api", []), "Completed check in acme/api → no one listening"],
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
    expect(screen.getByRole("link", { name: "started Triage failures run" }).getAttribute("href")).toBe("/workflows/runs/run-1");
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
    const disclosure = screen.getByText("Deliveries and receipt stages").closest("details")!;
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
    const disclosure = screen.getByText("Deliveries and receipt stages").closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(within(disclosure).getByText("Receipt stages are available to organization administrators.")).toBeTruthy();
  });

  it("names its window in the Terminology words", () => {
    items = [eventItem("ev-none", "github.check_run.completed", "acme/api", [])];
    renderTab();
    expect(screen.getByText(/Activity from the last 30 days/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/subscription|trigger|automation/i);
  });
});

describe("ActivityPane search", () => {
  it("reads only the Log's filters and a service, and drops hand-edited values", () => {
    expect(readActivitySearch({ status: "problems", q: "boom", tab: "log" })).toEqual({ status: "problems", q: "boom" });
    expect(readActivitySearch({ service: "github", q: "acme" })).toEqual({ service: "github", q: "acme" });
    expect(readActivitySearch({ status: "everything", service: "jira", q: "" })).toEqual({});
    // The old Raw receipts filter opens the whole Log; receipts sit under their own disclosure.
    expect(readActivitySearch({ status: "receipts" })).toEqual({});
    expect(readActivitySearch(null)).toEqual({});
  });

  it("offers All, Problems, Slack, GitHub, and Linear", () => {
    renderTab({ service: "github" });
    const chips = within(screen.getByRole("group", { name: "Show" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["All", "Problems", "Slack", "GitHub", "Linear"]);
    expect(screen.getByRole("button", { name: "GitHub" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Problems sets the status, clears the service, and keeps the place", () => {
    const { onSearchChange } = renderTab({ service: "slack", q: "boom" });
    fireEvent.click(screen.getByRole("button", { name: "Problems" }));
    expect(onSearchChange).toHaveBeenCalledWith({ status: "problems", q: "boom" });
  });

  it("a service chip sets the service and clears the status", () => {
    const { onSearchChange } = renderTab({ status: "problems", q: "boom" });
    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(onSearchChange).toHaveBeenCalledWith({ service: "slack", q: "boom" });
  });

  it("All clears the status and the service", () => {
    const { onSearchChange } = renderTab({ service: "linear" });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onSearchChange).toHaveBeenCalledWith({});
  });

  it("a service chip keeps only that service's rows", () => {
    items = [
      eventItem("ev-mention", "slack.app_mention", "#incidents", [delivery({ thread: tInc })]),
      eventItem("ev-check", "github.check_run.completed", "acme/api", []),
    ];
    renderTab({ service: "github" });
    expect(screen.queryByRole("link", { name: "Mention in #incidents" })).toBeNull();
    expect(screen.getByRole("link", { name: "Completed check in acme/api" })).toBeTruthy();
  });

  it("the Place box writes q and keeps the chip", async () => {
    const { onSearchChange } = renderTab({ service: "github" });
    const box = screen.getByRole("searchbox", { name: "Place" });
    expect(box.getAttribute("placeholder")).toBe("Place");
    fireEvent.change(box, { target: { value: "acme/api" } });
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith({ service: "github", q: "acme/api" }));
  });
});

describe("ActivityPane receipts", () => {
  it("shows receipts under a disclosure for an admin", () => {
    renderTab();
    const disclosure = screen.getByText("Receipts", { selector: "summary" }).closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(within(disclosure).queryByText("Receipts list")).toBeNull();
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(within(disclosure).getByText("Receipts list")).toBeTruthy();
  });

  it("has no receipts disclosure for a member", () => {
    role = "member";
    renderTab();
    expect(screen.queryByText("Receipts", { selector: "summary" })).toBeNull();
  });
});

describe("ActivityPane onboarding (Part C step 8)", () => {
  it("shows the cards with no place and no routine", () => {
    places = [];
    triggers = [];
    renderTab();
    expect(screen.getByRole("heading", { level: 3, name: "Valet is not present anywhere yet." })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
  });

  it("shows the log with a place and no routine (Review Focus 1)", () => {
    places = [ONE_PLACE];
    triggers = [];
    renderTab();
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
  });

  it("shows the log with a routine and no place", () => {
    places = [];
    triggers = [{ kind: "schedule", id: "S1", name: "Morning summary", enabled: true, detail: {
      cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", nextFireAt: 1, lastFiredAt: null, ownerType: "user", ownerId: "u1",
    } }];
    renderTab();
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
  });

  it("shows the log while the places or the routines load", () => {
    places = undefined;
    triggers = [];
    renderTab();
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
    cleanup();
    places = [];
    triggers = undefined;
    renderTab();
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
  });
});
