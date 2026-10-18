// @vitest-environment jsdom
/**
 * One line of presence on its page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D; acceptance P7, P8): the place breadcrumb, the sentence as the
 * title, the fact strip with Edit, enable or disable, the problem with the
 * picker, the delivery list, this line's receipts for an administrator, and
 * the paused copy.
 *
 * The api client is mocked at the transport, so the real query hooks run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  EventSubscriptionWire,
  ListEventReceiptsResponse,
  ListEventSubscriptionsResponse,
  ListSubscriptionDeliveriesResponse,
  ListThreadsResponse,
  PatchEventSubscriptionRequest,
  ThreadAddress,
} from "@valet/api/wire";
import type { AssistantThreadPolicy } from "@valet/shared";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return <a href={href} className={className}>{children}</a>;
  },
}));

type ListThreadsOpts = { threadId?: string; archived?: boolean };
const listEventSubscriptions = vi.fn<() => Promise<ListEventSubscriptionsResponse>>();
const listSubscriptionDeliveries = vi.fn<(id: string, limit?: number) => Promise<ListSubscriptionDeliveriesResponse>>();
const listEventReceipts = vi.fn<(params: { subscriptionId?: string }) => Promise<ListEventReceiptsResponse>>();
const listThreads = vi.fn<(sessionId: string, opts?: ListThreadsOpts) => Promise<ListThreadsResponse>>();
const getThreadAddress = vi.fn<(id: string) => Promise<ThreadAddress>>();
const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listEventSubscriptions: () => listEventSubscriptions(),
      listSubscriptionDeliveries: (id: string, limit?: number) => listSubscriptionDeliveries(id, limit),
      listEventReceipts: (params: { subscriptionId?: string }) => listEventReceipts(params),
      listThreads: (sessionId: string, opts?: ListThreadsOpts) => listThreads(sessionId, opts),
      getThreadAddress: (id: string) => getThreadAddress(id),
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
      listPresencePlaces: async () => ({ places: [] }),
    },
  };
});

vi.mock("~/api/workflows", () => ({
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
  useWorkflows: () => ({ data: { workflows: [] } }),
}));

let orgRole: "admin" | "member" = "admin";
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-001", orgId: "acme", orgRole } }),
}));

/** The dialog is its own suite's (its Runs in is tested there); here it
 * records the listener it opened on. */
vi.mock("~/components/events/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: ({ sub }: { sub: EventSubscriptionWire }) => <p>Editing {sub.name}</p>,
}));

/** The picker lists real threads in its own suite; here one pick stands in. */
vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ workspace, onPick }: {
    workspace: string;
    onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void;
  }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-ws", threadId: "t-ops" }, "Platform Ops")}>
      Pick Platform Ops from {workspace}
    </button>
  ),
}));

import { RulePage } from "./rule-page";

const PIN_TEXT = "Pick another thread for this rule in Presence.";

function listener(over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id: "R4",
    name: "Failed checks",
    ownerType: "user",
    ownerId: "u-001",
    eventKeys: ["github.check_run.completed"],
    filters: [{ field: "repo", op: "eq", value: "acme/api" }],
    target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ci" } },
    enabled: true,
    createdBy: "u-001",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const EVENT = {
  id: "ev-1", service: "github", eventKey: "github.check_run.completed", summary: "CI failed on main",
  refs: { repo: "acme/api" }, actor: null, occurredAt: 1_000, receivedAt: 1_000,
};

function renderPage(id = "R4") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RulePage id={id} /></QueryClientProvider>);
}

beforeEach(() => {
  orgRole = "admin";
  for (const mock of [listEventSubscriptions, listSubscriptionDeliveries, listEventReceipts, listThreads, getThreadAddress, patchEventSubscription]) {
    mock.mockReset();
  }
  listSubscriptionDeliveries.mockResolvedValue({ deliveries: [] });
  listEventReceipts.mockResolvedValue({ receipts: [], nextCursor: null, lastReceiptAt: null, retentionDays: 7 });
  listThreads.mockImplementation(async (_sessionId, opts) => ({
    threads: opts?.archived
      ? [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 5 }]
      : [{ id: "t-other", sessionId: "s-ws", title: "Something else", createdAt: 1, lastUserActivityAt: 1 }],
  }));
  patchEventSubscription.mockImplementation(async (id, body) => ({ ...listener({}), id, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) }));
});

describe("RulePage", () => {
  it("reads the sentence with the pinned thread's title, from the archived list when the open list misses it", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByText("When a check completes on acme/api, work in the Platform CI thread.")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci" });
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci", archived: true });
  });

  it("reads an open pin's title from the first read alone", async () => {
    listThreads.mockResolvedValue({
      threads: [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1 }],
    });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByText("When a check completes on acme/api, work in the Platform CI thread.")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("turns the listener off and on", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.getByText("On")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { enabled: false }));
  });

  it("turns a paused listener on", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ enabled: false })] });
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: "Turn on Failed checks" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", { enabled: true }));
  });

  it("opens the edit dialog on this listener", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByText("Editing Failed checks")).toBeTruthy();
  });

  it("shows the place breadcrumb, the sentence as the title, and the fact strip (P7)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const title = await screen.findByRole("heading", { level: 1, name: "When a check completes on acme/api, work in the Platform CI thread." });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›acme/api›Failed checks");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(within(crumbs).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe("/presence/places/github:acme/api");

    const facts = screen.getByLabelText("Facts");
    expect(title.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const pairs = [...facts.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(pairs).toEqual([
      ["When", "Completed check"],
      ["Do", "work in the Platform CI thread"],
      ["Runs in", "The thread Platform CI"],
      ["Appears as", "Valet"],
    ]);
  });

  it("names the appearance in the fact strip and joins events by or", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        id: "M", name: "Mentions",
        eventKeys: ["github.check_run.completed", "github.pull_request_review.submitted"],
        target: { kind: "assistant", appearance: { displayName: "SRE Bot" }, thread: { mode: "new" } },
      })],
    });
    renderPage("M");
    const facts = await screen.findByLabelText("Facts");
    const value = (term: string) => [...facts.querySelectorAll("dt")].find((dt) => dt.textContent === term)?.nextElementSibling?.textContent;
    expect(value("When")).toMatch(/ or /);
    expect(value("Runs in")).toBe("A new thread each time");
    expect(value("Appears as")).toBe("SRE Bot");
  });

  it("links a Slack channel line's breadcrumb to its channel", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }],
        target: { kind: "assistant", thread: { mode: "new" } },
      })],
    });
    renderPage();
    const link = await screen.findByRole("link", { name: "#incidents" });
    expect(link.getAttribute("href")).toBe("/presence/places/slack:C900");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Presence›#incidents›Failed checks");
  });

  it("puts only Presence before the line for a line with no one place", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ filters: [] })] });
    renderPage();
    await screen.findByRole("heading", { level: 1, name: /^When a check completes on any repository/ });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›Failed checks");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
  });

  it("lists deliveries by reason: delivered to, claimed by, and the dead-letter text", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    const base = { subscriptionId: "R4", subscriptionName: "Failed checks", attempts: 1, deliveredAt: null, lastError: null, event: EVENT };
    listSubscriptionDeliveries.mockResolvedValue({
      deliveries: [
        { ...base, id: "d1", status: "delivered", deliveredAt: 1_100, thread: { sessionId: "s-ws", threadId: "t-ci", title: "Platform CI" } },
        { ...base, id: "d2", status: "skipped", lastError: "Skipped, claimed by thread t-inc.", claimedBy: { sessionId: "s-ws", threadId: "t-inc", title: "Incident 42", archived: true } },
        { ...base, id: "d3", status: "dead", lastError: PIN_TEXT },
      ],
    });
    renderPage();
    const deliveries = await screen.findByRole("region", { name: "Deliveries" });
    expect((await within(deliveries).findByRole("link", { name: "Delivered to Platform CI" })).getAttribute("href")).toBe("/threads/t-ci");
    expect((await within(deliveries).findByRole("link", { name: "Claimed by Incident 42" })).getAttribute("href")).toBe("/threads/t-inc");
    expect(within(deliveries).getByText(PIN_TEXT)).toBeTruthy();
    expect(within(deliveries).getAllByRole("link", { name: "CI failed on main" })[0]!.getAttribute("href")).toBe("/presence/events/ev-1");
    expect(listSubscriptionDeliveries).toHaveBeenCalledWith("R4", 25);
    // The delivery refs carry the titles; the page reads no thread again.
    expect(getThreadAddress).not.toHaveBeenCalled();
  });

  it("lists this listener's receipts for an administrator", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    listEventReceipts.mockResolvedValue({
      receipts: [{
        id: "rc-1", service: "github", externalId: null, metadata: {}, eventKey: "github.check_run.completed", eventId: "ev-1",
        stages: [{ stage: "subscription_match", outcome: "filter_excluded", detail: "", at: 1_000 }],
        subscriptions: [{ id: "R4", ownerType: "user", ownerId: "u-001", target: "assistant", outcome: "filter_excluded" }],
        createdAt: 1_000, updatedAt: 1_000,
      }],
      nextCursor: null, lastReceiptAt: 1_000, retentionDays: 7,
    });
    renderPage();
    const summary = await screen.findByText("Receipts", { selector: "summary" });
    const receipts = summary.closest("details");
    if (receipts === null) throw new Error("Receipts is not a disclosure");
    expect(receipts.open).toBe(false);
    expect(await within(receipts).findByText("Completed check · excluded by its filters")).toBeTruthy();
    // The last stage reads in words, not as its identifier.
    expect(within(receipts).getByText(/Presence matching: Excluded by filters/)).toBeTruthy();
    expect(within(receipts).queryByText(/filter_excluded/)).toBeNull();
    expect(listEventReceipts).toHaveBeenCalledWith({ subscriptionId: "R4", limit: 10 });
  });

  it("shows a member no receipts, and reads none", async () => {
    orgRole = "member";
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.queryByText("Receipts")).toBeNull();
    expect(listEventReceipts).not.toHaveBeenCalled();
  });

  it("shows the archived text and the picker; a pick repins the line (P7, P8)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    renderPage();
    const problem = await screen.findByRole("region", { name: "Problem" });
    expect(await within(problem).findByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    fireEvent.click(within(problem).getByRole("button", { name: "Pick Platform Ops from user" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R4", {
      thread: { mode: "existing", sessionId: "s-ws", threadId: "t-ops" },
    }));
  });

  it("lists a team listener's threads in the picker and shows no problem without one", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ ownerType: "team", ownerId: "sre", problem: PIN_TEXT })] });
    renderPage();
    expect(await screen.findByRole("button", { name: "Pick Platform Ops from sre" })).toBeTruthy();
  });

  it("shows no problem for a healthy listener", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    await screen.findByRole("switch", { name: "Turn off Failed checks" });
    expect(screen.queryByRole("region", { name: "Problem" })).toBeNull();
    expect(screen.queryByText("Thread archived")).toBeNull();
  });

  it("says a team listener paused this personal listener", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [listener({ enabled: false, target: { kind: "assistant", thread: { mode: "new" }, overlapPausedAt: 5 } })],
    });
    renderPage();
    expect(await screen.findByText("Paused: the team already listens for this.")).toBeTruthy();
  });

  it("names the fix when the listener is not in the list", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderPage("gone");
    expect(await screen.findByText("This page does not exist, or you cannot see it. Open Presence and pick the place again.")).toBeTruthy();
  });
});
