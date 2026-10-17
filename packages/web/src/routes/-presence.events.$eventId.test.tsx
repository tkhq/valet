// @vitest-environment jsdom
/**
 * `/presence/events/$eventId`: one event at its own URL. Covers the page
 * body (the activity sentence, deliveries, receipt stages, payload) and the
 * Redeliver control, which confirms before it runs because a redelivery can
 * start real agent runs.
 *
 * `EventDetailBody` is exported so this suite renders it without router
 * context, the same split `RunDetailBody` uses.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { GetEventResponse } from "@valet/api/wire";

const RETRY_IN_8_MIN = Date.now() + 8 * 60_000 + 30_000;

const detailData: GetEventResponse = {
  event: {
    id: "evt_1",
    service: "github",
    eventKey: "github.pr.opened",
    summary: "PR #7 opened: fix login",
    refs: { repo: "acme/app" },
    actor: { externalId: "u-ext", login: "octocat" },
    occurredAt: 1_723_200_000_000,
    receivedAt: 1_723_200_000_000,
    payload: { action: "opened", number: 7 },
  },
  deliveries: [
    {
      id: "d1",
      subscriptionId: "sub_1",
      subscriptionName: "PR alerts",
      status: "failed",
      attempts: 2,
      lastError: "Error: workflow wf_1 not found in org acme",
      deliveredAt: null,
      nextAttemptAt: RETRY_IN_8_MIN,
    },
  ],
};

const subscriptionsData = {
  subscriptions: [
    {
      id: "sub_1",
      name: "PR alerts",
      ownerType: "user" as const,
      ownerId: "u1",
      eventKeys: ["github.pr.*"],
      filters: [],
      target: { kind: "assistant" as const },
      enabled: true,
      createdBy: "u1",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const redeliverMutate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to?: string; params?: Record<string, string> }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

const receiptsQuery = vi.fn();
vi.mock("~/api/events", () => ({
  useEvent: () => ({ data: detailData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: subscriptionsData, isLoading: false, error: null }),
  useRedeliverEvent: () => ({ mutate: redeliverMutate, isPending: false, error: null }),
  useEventReceipts: (...args: unknown[]) => {
    receiptsQuery(...args);
    return {
      data: { receipts: [{ id: "rc_1", service: "github", externalId: null, eventKey: "github.pr.opened", eventId: "evt_1", metadata: {},
        stages: [{ stage: "persistence", outcome: "stored", detail: "Event stored", at: 1000 }], subscriptions: [], createdAt: 1000, updatedAt: 1000 }],
        nextCursor: null, lastReceiptAt: 1000, retentionDays: 7 },
      isPending: false, error: null, refetch: vi.fn(),
    };
  },
}));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "u1", orgId: "org-1", orgRole: "admin" }, error: null }) }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => ({ ownerType: "user", ownerId: "u1" }) }));

import { EventDetailBody } from "./presence.events.$eventId";

beforeEach(() => {
  redeliverMutate.mockReset();
});

describe("EventDetailBody", () => {
  it("leads with the activity sentence, then the event's key, refs, and payload", () => {
    render(<EventDetailBody data={detailData} />);
    expect(screen.getByRole("link", { name: "Pr opened in acme/app" }).getAttribute("href")).toBe("/presence/events/evt_1");
    expect(screen.getByText(/→ retries in 8 minutes, after 2 attempts/)).toBeTruthy();
    expect(screen.getByText("github.pr.opened")).toBeTruthy();
    expect(screen.getByText("repo: acme/app")).toBeTruthy();
    expect(screen.getByText(/"action": "opened"/)).toBeTruthy();
  });

  it("names the listener and when the delivery retries", () => {
    render(<EventDetailBody data={detailData} />);
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.getByText(/Retries in 8 minutes/)).toBeTruthy();
    expect(screen.getByText("Error: workflow wf_1 not found in org acme")).toBeTruthy();
  });

  it("links each delivery to the thread or the run it reached", () => {
    const reached = { subscriptionId: "sub_1", status: "delivered" as const, attempts: 1, lastError: null, deliveredAt: 1_723_200_000_000 };
    render(
      <EventDetailBody
        data={{
          ...detailData,
          deliveries: [
            ...detailData.deliveries,
            { ...reached, id: "d2", subscriptionName: "Triage", thread: { sessionId: "sess_1", threadId: "th_1" } },
            { ...reached, id: "d3", subscriptionName: "Release flow", runId: "wfrun_evt_d3" },
          ],
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Delivered to thread" }).getAttribute("href")).toBe("/threads/th_1");
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("/workflows/runs/wfrun_evt_d3");
    // The sentence links the same thread and run.
    expect(screen.getByRole("link", { name: "a thread" }).getAttribute("href")).toBe("/threads/th_1");
    expect(screen.getByRole("link", { name: "started a workflow run" }).getAttribute("href")).toBe("/presence/runs/wfrun_evt_d3");
  });

  it("confirms before redelivering, naming the listeners and the runs", async () => {
    render(<EventDetailBody data={detailData} />);
    fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));

    expect(await screen.findByText(/matches up to 1 enabled listener/)).toBeTruthy();
    expect(screen.getByText(/can start up to 1 run/)).toBeTruthy();
    // One delivery is still on the dispatcher's list, so the press can run
    // the same work twice — the dialog has to say so.
    expect(screen.getByText(/still scheduled to retry/)).toBeTruthy();
    expect(redeliverMutate).not.toHaveBeenCalled();
  });

  it("redelivers on confirm and reports how many deliveries were queued", async () => {
    redeliverMutate.mockImplementation((_input: undefined, opts: { onSuccess: (r: { created: number }) => void }) => {
      opts.onSuccess({ created: 2 });
    });
    render(<EventDetailBody data={detailData} />);

    fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));
    const dialogButtons = await screen.findAllByRole("button", { name: "Redeliver" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    expect(redeliverMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(
      "Queued 2 deliveries. The result appears in this list.",
    );
  });

  it("says nothing was queued, and what to do, when no listener matches", async () => {
    redeliverMutate.mockImplementation((_input: undefined, opts: { onSuccess: (r: { created: number }) => void }) => {
      opts.onSuccess({ created: 0 });
    });
    render(<EventDetailBody data={detailData} />);

    fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));
    const dialogButtons = await screen.findAllByRole("button", { name: "Redeliver" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    expect(screen.getByRole("status").textContent).toContain("Nothing was queued");
    expect(screen.getByRole("status").textContent).toContain("Turn on or edit a listener in Presence");
  });

  it("keeps the receipt stages under a disclosure and loads them when it opens", () => {
    receiptsQuery.mockClear();
    render(<EventDetailBody data={detailData} />);
    const disclosure = screen.getByText("Receipt stages").closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(receiptsQuery).toHaveBeenLastCalledWith("org-1", { q: "evt_1", limit: 5 }, false);
    expect(screen.queryByText("Event stored")).toBeNull();
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(receiptsQuery).toHaveBeenLastCalledWith("org-1", { q: "evt_1", limit: 5 }, true);
    expect(screen.getByText("Event stored")).toBeTruthy();
  });
});
