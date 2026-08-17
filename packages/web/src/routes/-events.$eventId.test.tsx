// @vitest-environment jsdom
/**
 * `/events/$eventId` — one event at its own URL. Covers the page body
 * (header, deliveries, payload) and the Redeliver control, which confirms
 * before it runs because a redelivery can start real agent runs.
 *
 * `EventDetailBody` is exported so this suite renders it without router
 * context, the same split `RunDetailBody` uses. `~/api/events` is mocked the
 * way `-events.test.tsx` mocks it.
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
      target: { kind: "orchestrator" as const },
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
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/api/events", () => ({
  useEvent: () => ({ data: detailData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: subscriptionsData, isLoading: false, error: null }),
  useRedeliverEvent: () => ({ mutate: redeliverMutate, isPending: false, error: null }),
}));

import { EventDetailBody } from "./events.$eventId";

beforeEach(() => {
  redeliverMutate.mockReset();
});

describe("EventDetailBody", () => {
  it("renders the event header, its refs, and the payload", () => {
    render(<EventDetailBody data={detailData} />);
    expect(screen.getByText("PR #7 opened: fix login")).toBeTruthy();
    expect(screen.getByText("github.pr.opened")).toBeTruthy();
    expect(screen.getByText("repo: acme/app")).toBeTruthy();
    expect(screen.getByText(/"action": "opened"/)).toBeTruthy();
  });

  it("names the subscription and when the delivery retries", () => {
    render(<EventDetailBody data={detailData} />);
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.getByText(/Retries in 8 minutes/)).toBeTruthy();
    expect(screen.getByText("Error: workflow wf_1 not found in org acme")).toBeTruthy();
  });

  it("confirms before redelivering, naming the subscriptions and the runs", async () => {
    render(<EventDetailBody data={detailData} />);
    fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));

    expect(await screen.findByText(/matches up to 1 enabled subscription/)).toBeTruthy();
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

  it("says nothing was queued, and what to do, when no subscription matches", async () => {
    redeliverMutate.mockImplementation((_input: undefined, opts: { onSuccess: (r: { created: number }) => void }) => {
      opts.onSuccess({ created: 0 });
    });
    render(<EventDetailBody data={detailData} />);

    fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));
    const dialogButtons = await screen.findAllByRole("button", { name: "Redeliver" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    expect(screen.getByRole("status").textContent).toContain("Nothing was queued");
    expect(screen.getByRole("status").textContent).toContain("Subscriptions tab");
  });
});
