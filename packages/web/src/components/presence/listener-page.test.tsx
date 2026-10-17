// @vitest-environment jsdom
/**
 * The listener page (docs/specs/2026-10-16-presence-hub-design.md Part C
 * steps 4 to 6; acceptance H7): the sentence, enable or disable, edit,
 * **Appears as**, the delivery list, this listener's receipts, the problem
 * badge with the picker inline, and the paused copy.
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

import { ListenerPage } from "./listener-page";

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
  return render(<QueryClientProvider client={qc}><ListenerPage id={id} /></QueryClientProvider>);
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

describe("ListenerPage", () => {
  it("reads the sentence with the pinned thread's title, from the archived list when the open list misses it", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByText("Listens on acme/api for completed checks · works in the thread Platform CI")).toBeTruthy();
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci" });
    expect(listThreads).toHaveBeenCalledWith("s-ws", { threadId: "t-ci", archived: true });
  });

  it("reads an open pin's title from the first read alone", async () => {
    listThreads.mockResolvedValue({
      threads: [{ id: "t-ci", sessionId: "s-ws", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1 }],
    });
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    expect(await screen.findByText("Listens on acme/api for completed checks · works in the thread Platform CI")).toBeTruthy();
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

  it("shows Appears as, with the default when the listener sets none", async () => {
    listEventSubscriptions.mockResolvedValue({
      subscriptions: [
        listener({ id: "M", name: "Mentions", target: { kind: "assistant", appearance: { displayName: "SRE Bot" }, thread: { mode: "new" } } }),
        listener({}),
      ],
    });
    renderPage("M");
    const appears = await screen.findByRole("region", { name: "Appears as" });
    expect(within(appears).getByText("SRE Bot")).toBeTruthy();
    expect(screen.getByText("Listens on acme/api for completed checks · works in a new thread each time · as SRE Bot")).toBeTruthy();
  });

  it("names Valet in Appears as when the listener sets no appearance", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const appears = await screen.findByRole("region", { name: "Appears as" });
    expect(within(appears).getByText("Valet")).toBeTruthy();
  });

  it("lists deliveries by reason: delivered to, claimed by, and the dead-letter text", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    const base = { subscriptionId: "R4", subscriptionName: "Failed checks", attempts: 1, deliveredAt: null, lastError: null, event: EVENT };
    listSubscriptionDeliveries.mockResolvedValue({
      deliveries: [
        { ...base, id: "d1", status: "delivered", deliveredAt: 1_100, thread: { sessionId: "s-ws", threadId: "t-ci" } },
        { ...base, id: "d2", status: "skipped", lastError: "Skipped, claimed by thread t-inc.", claimedBy: { sessionId: "s-ws", threadId: "t-inc" } },
        { ...base, id: "d3", status: "dead", lastError: PIN_TEXT },
      ],
    });
    getThreadAddress.mockImplementation(async (id) => ({
      id, sessionId: "s-ws", title: id === "t-ci" ? "Platform CI" : "Incident 42", createdAt: 1, archivedAt: null,
    }));
    renderPage();
    const deliveries = await screen.findByRole("region", { name: "Deliveries" });
    expect((await within(deliveries).findByRole("link", { name: "Delivered to Platform CI" })).getAttribute("href")).toBe("/threads/t-ci");
    expect((await within(deliveries).findByRole("link", { name: "Claimed by Incident 42" })).getAttribute("href")).toBe("/threads/t-inc");
    expect(within(deliveries).getByText(PIN_TEXT)).toBeTruthy();
    expect(within(deliveries).getAllByRole("link", { name: "CI failed on main" })[0]!.getAttribute("href")).toBe("/presence/events/ev-1");
    expect(listSubscriptionDeliveries).toHaveBeenCalledWith("R4", 25);
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
    const receipts = await screen.findByRole("region", { name: "Receipts" });
    expect(await within(receipts).findByText("Completed check · excluded by this listener's filters")).toBeTruthy();
    // The last stage reads in words, not as its identifier.
    expect(within(receipts).getByText(/Listener matching: Excluded by filters/)).toBeTruthy();
    expect(within(receipts).queryByText(/filter_excluded/)).toBeNull();
    expect(listEventReceipts).toHaveBeenCalledWith({ subscriptionId: "R4", limit: 10 });
  });

  it("tells a member that receipts are for administrators, and reads none", async () => {
    orgRole = "member";
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({})] });
    renderPage();
    const receipts = await screen.findByRole("region", { name: "Receipts" });
    expect(within(receipts).getByText("Receipts are available to organization administrators.")).toBeTruthy();
    expect(listEventReceipts).not.toHaveBeenCalled();
  });

  it("shows the problem badge, the archived text, and the picker inline; a pick repins the listener (H7)", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [listener({ problem: PIN_TEXT })] });
    renderPage();
    expect(await screen.findByText("Thread archived")).toBeTruthy();
    const problem = screen.getByRole("region", { name: "Problem" });
    expect(within(problem).getByText("This listener's thread is archived. Pick another thread.")).toBeTruthy();
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
    expect(await screen.findByText("Paused: a team listener covers the same events.")).toBeTruthy();
  });

  it("names the fix when the listener is not in the list", async () => {
    listEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderPage("gone");
    expect(await screen.findByText("This listener does not exist, or you cannot see it. Open Places and pick a listener.")).toBeTruthy();
  });
});
