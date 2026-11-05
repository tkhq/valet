// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChildWorkSummary, DecisionGate } from "@valet/api/wire";
import { afterEach, describe, expect, it, vi } from "vitest";

const listDecisions = vi.hoisted(() => vi.fn());
vi.mock("~/api/client", async importOriginal => ({ ...await importOriginal<typeof import("~/api/client")>(), api: { listDecisions } }));
vi.mock("./decision-gate-card", () => ({
  DecisionGateCard: ({ sessionId, gate }: { sessionId: string; gate: DecisionGate }) => <div data-testid="gate-card">{`${sessionId}:${gate.id}`}</div>,
}));

import { ChildGateCards } from "./child-gate-cards";

function gate(id: string, status: DecisionGate["status"] = "pending"): DecisionGate {
  return { id, sessionId: "child", threadId: "ct", queueItemId: "q", type: "approval", title: "Post the summary?", actions: [], status, createdAt: 1, updatedAt: 1 } as DecisionGate;
}
const child = (sessionId: string, over: Partial<ChildWorkSummary> = {}): ChildWorkSummary =>
  ({ sessionId, title: `Child ${sessionId}`, parentThreadId: "t1", status: "running", createdAt: 1, ...over });

function renderCards(children: ChildWorkSummary[], onOpenChild = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ChildGateCards children={children} threadId="t1" onOpenChild={onOpenChild} /></QueryClientProvider>);
  return onOpenChild;
}

afterEach(() => listDecisions.mockReset());

describe("ChildGateCards", () => {
  it("shows a running child's open request in the thread that started it, labeled and answerable against the child", async () => {
    listDecisions.mockImplementation(async (sessionId: string) => ({ gates: sessionId === "c1" ? [gate("g1"), gate("old", "resolved")] : [gate("g-other")] }));
    const open = renderCards([child("c1"), child("c2", { parentThreadId: "t2" }), child("c3", { status: "settled" })]);
    expect((await screen.findByTestId("gate-card")).textContent).toBe("c1:g1");
    expect(screen.getAllByTestId("gate-card")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Request from Child c1" }).textContent).toContain("From Child c1");
    fireEvent.click(screen.getByRole("button", { name: "Child c1" }));
    expect(open).toHaveBeenCalledWith("c1");
    // Only the open thread's running children are read.
    expect(listDecisions.mock.calls.map(([id]) => id)).toEqual(["c1"]);
  });

  it("shows nothing while no child waits", async () => {
    listDecisions.mockResolvedValue({ gates: [] });
    renderCards([child("c1")]);
    await vi.waitFor(() => expect(listDecisions).toHaveBeenCalled());
    expect(screen.queryByTestId("gate-card")).toBeNull();
  });
});
