// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import { api } from "./client";
import { useSetWorkflowEnabled } from "./workflows";

afterEach(() => vi.restoreAllMocks());

const event = (id: string, enabled: boolean) => ({ kind: "event", id, workflowId: "wf", name: id, enabled, detail: {} }) as WorkflowTriggerItem;

function renderToggle() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return renderHook(() => useSetWorkflowEnabled(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  }).result;
}

it("turns on every trigger except a proposal still waiting for review", async () => {
  const update = vi.spyOn(api, "updateWorkflowEventTrigger").mockResolvedValue({} as never);
  const toggle = renderToggle();
  await act(() => toggle.current.mutateAsync({ triggers: [event("evt-1", false), event("proposal-abc", false)], enabled: true }));
  expect(update.mock.calls.map(([id]) => id)).toEqual(["evt-1"]);
});

it("reports how many triggers did not save", async () => {
  vi.spyOn(api, "updateWorkflowEventTrigger").mockImplementation(async (id) => {
    if (id === "evt-2") throw new Error("offline");
    return {} as never;
  });
  const toggle = renderToggle();
  await expect(act(() => toggle.current.mutateAsync({ triggers: [event("evt-1", true), event("evt-2", true)], enabled: false })))
    .rejects.toThrow("1 of 2 triggers did not save.");
});
