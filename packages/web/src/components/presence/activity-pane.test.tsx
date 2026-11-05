// @vitest-environment jsdom
/**
 * The Activity pane (spec 2026-10-16 presence hub, Part F): each stored event
 * leads with `<event in words> in <place> → <outcome>`, a thread in the
 * outcome links to the thread, and the deliveries and receipt stages stay
 * under a disclosure. The chips (`All`, `Problems`, one per service) and the
 * Place box live in the URL; receipts sit under a disclosure for admins. The
 * page sits under the breadcrumb `Presence › Activity`. The overview owns the
 * onboarding paragraphs; with no place and no routine, Activity keeps the log
 * and offers its own Add.
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
let lines: "default" | EventSubscriptionWire[] | undefined = "default";
const receiptsQuery = vi.fn();
const logQuery = vi.fn();

const workflowListener: EventSubscriptionWire = {
  id: "sub-wf", name: "Run triage", ownerType: "user", ownerId: "u1", eventKeys: ["github.check_run.completed"], filters: [],
  target: { kind: "workflow", workflowId: "wf-1" }, enabled: true, createdBy: "u1", createdAt: 1, updatedAt: 1,
};

vi.mock("~/api/events", () => ({
  useEventLog: (params: unknown) => (logQuery(params), {
    data: { pages: [{ items, nextCursor: null, lastEventAt: null, windowDays: 30 }] },
    isPending: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
  }),
  useEventSubscriptions: () => (lines === undefined
    ? { isSuccess: false, data: undefined }
    : { isSuccess: true, data: { subscriptions: lines === "default" ? [workflowListener] : lines } }),
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
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);
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
  lines = "default";
  receiptsQuery.mockClear();
  logQuery.mockClear();
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
  it("reads a row's verb from its line's stored action, and from the event key when the line is gone", () => {
    const line = (id: string, follow: boolean): EventSubscriptionWire => ({
      id, name: id, ownerType: "user", ownerId: "u1", eventKeys: ["slack.app_mention"], filters: [],
      target: { kind: "assistant", ...(follow ? { follow: true } : {}) }, enabled: true, createdBy: "u1", createdAt: 1, updatedAt: 1,
    });
    lines = [workflowListener, line("sub-work", false), line("sub-reply", true)];
    items = [
      eventItem("ev-work", "slack.app_mention", "#incidents", [delivery({ subscriptionId: "sub-work", thread: tInc })]),
      eventItem("ev-reply", "slack.message", "#incidents", [delivery({ subscriptionId: "sub-reply", thread: tInc })]),
      eventItem("ev-gone", "slack.app_mention", "#incidents", [delivery({ subscriptionId: "sub-gone", thread: tInc })]),
    ];
    renderTab();
    expect(sentenceFor("ev-work").textContent).toBe("Mention in #incidents → delivered to t-inc");
    expect(sentenceFor("ev-reply").textContent).toBe("Message in #incidents → replied in t-inc");
    expect(sentenceFor("ev-gone").textContent).toBe("Mention in #incidents → replied in t-inc");
  });

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
    const disclosure = screen.getByText("Attempts and intake stages").closest("details")!;
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
    const disclosure = screen.getByText("Attempts and intake stages").closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(within(disclosure).getByText("Intake stages are available to organization administrators.")).toBeTruthy();
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

  it("the Search box writes q and keeps the chip and the place", async () => {
    const { onSearchChange } = renderTab({ service: "github", place: "github:acme/api" });
    const box = screen.getByRole("searchbox", { name: "Search" });
    expect(box.getAttribute("placeholder")).toBe("Search activity");
    fireEvent.change(box, { target: { value: "deploy" } });
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith({ service: "github", place: "github:acme/api", q: "deploy" }));
  });
});

describe("ActivityPane place filter (spec Part C step 7)", () => {
  const incidents: PresencePlaceWire = {
    subject: "slack:T1/C900", label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 1, activeThreadCount: 0, lastActivityAt: null,
  };

  it("reads place from the search, and drops a blank one", () => {
    expect(readActivitySearch({ place: "slack:T1/C900", q: "x" })).toEqual({ place: "slack:T1/C900", q: "x" });
    expect(readActivitySearch({ place: "" })).toEqual({});
  });

  it("asks the Log for the place's events", () => {
    renderTab({ place: "slack:T1/C900" });
    expect(logQuery).toHaveBeenLastCalledWith(expect.objectContaining({ place: "slack:T1/C900" }));
  });

  it("shows a removable chip that names the place, and Remove clears only the place", () => {
    places = [incidents];
    const { onSearchChange } = renderTab({ place: "slack:T1/C900", service: "slack", q: "boom" });
    expect(screen.getByText("In #incidents")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove the place filter In #incidents" }));
    expect(onSearchChange).toHaveBeenCalledWith({ service: "slack", q: "boom" });
  });

  it("names a place the list does not hold by the last part of its key", () => {
    places = [];
    renderTab({ place: "github:acme/api" });
    expect(screen.getByText("In api")).toBeTruthy();
  });

  it("names a service-wide place by its own name", () => {
    places = [{ ...incidents, subject: "github:*", label: "Across GitHub", service: "github", parent: null }];
    renderTab({ place: "github:*" });
    expect(screen.getByText("Across GitHub")).toBeTruthy();
  });

  it("keeps the place when a chip changes", () => {
    const { onSearchChange } = renderTab({ place: "slack:T1/C900" });
    fireEvent.click(screen.getByRole("button", { name: "Problems" }));
    expect(onSearchChange).toHaveBeenCalledWith({ status: "problems", place: "slack:T1/C900" });
  });

  it("puts the service mark on each service chip", () => {
    renderTab();
    const slack = screen.getByRole("button", { name: "Slack" });
    expect(slack.querySelector('[data-service="slack"][data-size="sm"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "All" }).querySelector("[data-service]")).toBeNull();
  });
});

describe("ActivityPane diagnostics (L8)", () => {
  function disclosure(): HTMLDetailsElement {
    const summary = screen.getByText("Diagnostics").closest("summary");
    const details = summary?.closest("details");
    if (!(details instanceof HTMLDetailsElement)) throw new Error("no Diagnostics disclosure");
    return details;
  }

  it("has one diagnostics control, the disclosure, and no checkbox", () => {
    renderTab();
    expect(disclosure().open).toBe(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/Show diagnostics/)).toBeNull();
  });

  it("writes diagnostics=1 to the URL when it opens, and drops it when it closes", () => {
    const { onSearchChange } = renderTab({ status: "problems", q: "boom" });
    const details = disclosure();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(onSearchChange).toHaveBeenLastCalledWith({ status: "problems", q: "boom", diagnostics: 1 });
    cleanup();
    const reopened = renderTab({ status: "problems", q: "boom", diagnostics: 1 });
    const open = disclosure();
    expect(open.open).toBe(true);
    open.open = false;
    fireEvent(open, new Event("toggle"));
    expect(reopened.onSearchChange).toHaveBeenLastCalledWith({ status: "problems", q: "boom" });
  });

  it("asks the Log for diagnostics and shows an admin the receipts while open", () => {
    renderTab({ diagnostics: 1 });
    expect(logQuery).toHaveBeenLastCalledWith(expect.objectContaining({ diagnostics: true }));
    expect(within(disclosure()).getByText("Receipts list")).toBeTruthy();
    cleanup();
    renderTab();
    expect(logQuery).toHaveBeenLastCalledWith(expect.objectContaining({ diagnostics: false }));
    expect(screen.queryByText("Receipts list")).toBeNull();
  });

  it("gives a member the disclosure for the organization's problems, with no receipts", () => {
    role = "member";
    renderTab({ diagnostics: 1 });
    expect(disclosure().open).toBe(true);
    expect(logQuery).toHaveBeenLastCalledWith(expect.objectContaining({ diagnostics: true }));
    expect(screen.queryByText("Receipts list")).toBeNull();
  });

  it("keeps diagnostics open when a chip, Search, or the place changes", () => {
    const { onSearchChange } = renderTab({ place: "slack:T1/C900", diagnostics: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Problems" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ status: "problems", place: "slack:T1/C900", diagnostics: 1 });
    fireEvent.click(screen.getByRole("button", { name: /^Remove the place filter/ }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ diagnostics: 1 });
  });

  it("reads diagnostics=1 from the URL, as the router's number or as text", () => {
    expect(readActivitySearch({ diagnostics: 1 })).toEqual({ diagnostics: 1 });
    expect(readActivitySearch({ diagnostics: "1" })).toEqual({ diagnostics: 1 });
    expect(readActivitySearch({ diagnostics: 0 })).toEqual({});
    expect(readActivitySearch({ diagnostics: true })).toEqual({});
  });
});

describe("ActivityPane page", () => {
  it("sits under the breadcrumb Presence › Activity, titled Activity", () => {
    renderTab();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›Activity");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(within(crumbs).getByText("Activity").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
  });
});

describe("ActivityPane with no place and no routine", () => {
  it("keeps the log, shows no onboarding paragraphs, and offers its own Add", () => {
    places = [];
    triggers = [];
    lines = [];
    renderTab();
    expect(screen.queryByText("Valet is not present anywhere yet.")).toBeNull();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
    expect(screen.queryByTestId("line-editor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create");
  });

  it("offers no Add with a line on a row (Review Focus 1)", () => {
    places = [ONE_PLACE];
    triggers = [];
    renderTab();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("offers its Add when only threads and events touched the places, as the overview shows onboarding", () => {
    places = [ONE_PLACE];
    triggers = [];
    lines = [];
    renderTab();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("offers no Add with a routine and no place", () => {
    places = [];
    lines = [];
    triggers = [{ kind: "schedule", id: "S1", name: "Morning summary", enabled: true, detail: {
      cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", nextFireAt: 1, lastFiredAt: null, lastFiredThread: null, ownerType: "user", ownerId: "u1",
    } }];
    renderTab();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("offers no Add while the places or the routines load", () => {
    places = undefined;
    triggers = [];
    renderTab();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    cleanup();
    places = [];
    triggers = undefined;
    renderTab();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    cleanup();
    triggers = [];
    lines = undefined;
    renderTab();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});
