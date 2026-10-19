// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";
import { isWorkflowRunsKey, qkWorkflows, useRunScheduleNow } from "./workflows";

afterEach(() => {
  vi.restoreAllMocks();
});

it("matches a workflow's runs keys and no other workflow key", () => {
  expect(isWorkflowRunsKey(qkWorkflows.runs("wf-1"))).toBe(true);
  expect(isWorkflowRunsKey(qkWorkflows.runs("wf-1", { limit: 50 }))).toBe(true);
  expect(isWorkflowRunsKey(qkWorkflows.detail("wf-1"))).toBe(false);
  expect(isWorkflowRunsKey(qkWorkflows.run("run-1"))).toBe(false);
  expect(isWorkflowRunsKey(qkWorkflows.triggers())).toBe(false);
});

it("Fire now refreshes the workflow runs a routine page reads (S4)", async () => {
  vi.spyOn(api, "runWorkflowScheduleNow").mockResolvedValue({ ok: true });
  const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const runsKey = qkWorkflows.runs("wf-1", { limit: 50 });
  cache.setQueryData(runsKey, { runs: [] });
  cache.setQueryData(qkWorkflows.detail("wf-1"), { id: "wf-1" });
  const view = renderHook(() => useRunScheduleNow(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  });
  await act(async () => {
    await view.result.current.mutateAsync("wfsched_1");
  });
  expect(cache.getQueryState(runsKey)?.isInvalidated).toBe(true);
  expect(cache.getQueryState(qkWorkflows.detail("wf-1"))?.isInvalidated).toBe(false);
});
