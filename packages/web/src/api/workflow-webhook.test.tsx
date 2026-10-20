// @vitest-environment jsdom
/**
 * The workflow editor's webhook read. The server answers a workflow with no
 * webhook with 200 `{ webhook: null }`, so the editor's first load logs no
 * failed request.
 */
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";
import { useWorkflowWebhook } from "./workflows";

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={cache}>{children}</QueryClientProvider>;
}

it("reads a workflow with no webhook as null", async () => {
  vi.spyOn(api, "getWorkflowWebhook").mockResolvedValue({ webhook: null });
  const view = renderHook(() => useWorkflowWebhook("wf-1"), { wrapper });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(view.result.current.data).toBeNull();
});

it("reads a workflow's webhook from the webhook field", async () => {
  const webhook = { workflowId: "wf-1", hookId: "h".repeat(64), url: "https://valet.test/api/hooks/workflows/wf-1/h", createdAt: 1, updatedAt: 2 };
  vi.spyOn(api, "getWorkflowWebhook").mockResolvedValue({ webhook });
  const view = renderHook(() => useWorkflowWebhook("wf-1"), { wrapper });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(view.result.current.data).toEqual(webhook);
});
