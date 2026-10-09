// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ListWorkflowActionRequiredResponse, WorkflowActionRequiredItem } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { qk, useResolveDecisions } from "~/api/queries";
import { qkWorkflows, useResolveWorkflowApprovals } from "~/api/workflows";
import type { BulkTarget } from "./bulk-answers";
import { useBulkAnswerRun } from "./needs-action-header";

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}

function item(runId: string, nodeId: string): WorkflowActionRequiredItem {
  return { id: `${runId}:${nodeId}:0`, runId, workflowId: "wf", workflowName: "W", runCreatedAt: 1, owner: { type: "user", id: "me" },
    trigger: { type: "manual" }, gate: { kind: "approval", nodeId } };
}

beforeEach(() => vi.restoreAllMocks());

it("useResolveDecisions invalidates the session's gates and the bell inbox after each answer", async () => {
  const { client, wrapper } = harness();
  client.setQueryData(qk.decisions("s1"), { gates: [] });
  client.setQueryData(qk.decisions("s2"), { gates: [] });
  client.setQueryData(["notification-decisions", undefined], { items: [] });
  const resolve = vi.spyOn(api, "resolveDecision").mockResolvedValue({ ok: true });
  const { result } = renderHook(() => useResolveDecisions(), { wrapper });
  await act(() => result.current.mutateAsync({ sessionId: "s1", gateId: "g1", body: { actionId: "approve" } }));
  expect(resolve).toHaveBeenCalledWith("s1", "g1", { actionId: "approve" });
  expect(client.getQueryState(qk.decisions("s1"))?.isInvalidated).toBe(true);
  expect(client.getQueryState(qk.decisions("s2"))?.isInvalidated).toBe(false);
  expect(client.getQueryState(["notification-decisions", undefined])?.isInvalidated).toBe(true);
});

it("useResolveWorkflowApprovals removes an answered gate, and invalidates the list after an error", async () => {
  const { client, wrapper } = harness();
  const list: ListWorkflowActionRequiredResponse = { items: [item("r1", "a"), item("r1", "b")], count: 2 };
  client.setQueryData(qkWorkflows.actionRequired(), list);
  const resolve = vi.spyOn(api, "resolveWorkflowApproval")
    .mockResolvedValueOnce({ ok: true })
    .mockRejectedValueOnce(new ApiError(409, "POST → 409", { error: "this approval gate has already been resolved" }));
  const { result } = renderHook(() => useResolveWorkflowApprovals(), { wrapper });
  await act(() => result.current.mutateAsync({ runId: "r1", nodeId: "a", body: { approved: true } }));
  expect(client.getQueryData<ListWorkflowActionRequiredResponse>(qkWorkflows.actionRequired())?.items.map(i => i.gate.nodeId)).toEqual(["b"]);
  await act(async () => { await result.current.mutateAsync({ runId: "r1", nodeId: "b", body: { approved: true } }).catch(() => {}); });
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(client.getQueryState(qkWorkflows.actionRequired())?.isInvalidated).toBe(true);
});

it("ignores a second start while a run is in flight, and refreshes once at the end", async () => {
  const { wrapper } = harness();
  let release = () => {};
  const held = new Promise<void>(done => { release = done; });
  const resolve = vi.spyOn(api, "resolveDecision").mockImplementation(async () => { await held; return { ok: true }; });
  const refresh = vi.fn(async () => new Set<string>());
  const { result } = renderHook(() => useBulkAnswerRun(refresh), { wrapper });
  const targets: BulkTarget[] = [{ kind: "decision", key: "decision:g1", title: "G1", sessionId: "s", gateId: "g1" }];
  let first: Promise<void> = Promise.resolve();
  act(() => { first = result.current.start("approve", targets); void result.current.start("deny", targets); });
  release();
  await act(() => first);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledWith("s", "g1", { actionId: "approve" });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(result.current.summary).toBe("Approved 1.");
});
