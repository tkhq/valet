// @vitest-environment jsdom
/**
 * Diagnostics on a line's page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D step 1.8): a closed disclosure with the intake trail for each
 * event and this line's decision, in words.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { EventReceiptWire, ListEventReceiptsResponse } from "@valet/api/wire";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const listEventReceipts = vi.fn<(params: { subscriptionId?: string; limit?: number }) => Promise<ListEventReceiptsResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, api: { ...actual.api, listEventReceipts: (params: { subscriptionId?: string; limit?: number }) => listEventReceipts(params) } };
});

import { Diagnostics, lastStageInWords, receiptLine } from "./diagnostics";

const RECEIPT: EventReceiptWire = {
  id: "rc-1", service: "github", externalId: null, metadata: {}, eventKey: "github.check_run.completed", eventId: "ev-1",
  stages: [
    { stage: "subscription_match", outcome: "filter_excluded", detail: "", at: 1_000 },
    { stage: "dispatch", outcome: "enqueued", detail: "", at: 1_001 },
  ],
  subscriptions: [{ id: "R4", ownerType: "user", ownerId: "u-001", target: "assistant", outcome: "filter_excluded" }],
  createdAt: 1_000, updatedAt: 1_000,
};

describe("Diagnostics", () => {
  it("reads a record as the event and this line's decision, and its last stage in words", () => {
    expect(receiptLine(RECEIPT, "R4")).toBe("Completed check · excluded by its filters");
    expect(receiptLine(RECEIPT, "other")).toBe("Completed check");
    expect(lastStageInWords(RECEIPT)).toBe("Send queue: Queued to send");
  });

  it("lists the records under a closed disclosure with its muted line", async () => {
    listEventReceipts.mockResolvedValue({ receipts: [RECEIPT], nextCursor: null, lastReceiptAt: 1_000, retentionDays: 7 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Diagnostics id="R4" name="CI failures" /></QueryClientProvider>);
    const details = screen.getByText("Diagnostics", { selector: "summary > span" }).closest("details");
    if (details === null) throw new Error("Diagnostics is not a disclosure");
    expect(details.open).toBe(false);
    expect(within(details).getByText("For organization admins: the intake trail for each event, stage by stage.")).toBeTruthy();
    expect(await within(details).findByText("Completed check · excluded by its filters")).toBeTruthy();
    expect(listEventReceipts).toHaveBeenCalledWith({ subscriptionId: "R4", limit: 10 });
  });
});
