// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { api } from "./client";
import { useRunDetail, useUpdateWorkflow } from "./workflows";
import { RunDetailBody } from "../routes/workflows.runs.$runId";

afterEach(() => vi.restoreAllMocks());

function detail(): WorkflowRunDetail {
  return {
    run: { runId: "run", workflowId: "workflow", status: "settled", outcome: "completed", createdAt: 1, updatedAt: 1,
      waitingOn: [], definition: { version: "dag/v1", nodes: [], edges: [] }, params: {} },
    owner: { type: "user", id: "person" }, checkpoints: [], signals: [], pendingGates: [],
    rerunSteps: [], rerunDefinitionVersionId: "version-1",
  };
}

function showRun() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Page() {
    const query = useRunDetail("run");
    const update = useUpdateWorkflow("workflow");
    return <>
      <button onClick={() => update.mutate({ name: "Edited" })}>Save workflow</button>
      {query.data && <RunDetailBody runId="run" data={query.data} onCancel={() => {}} cancelPending={false}
        onRetry={() => {}} retryPending={false} onRefreshRerun={async () => (await query.refetch()).data} />}
    </>;
  }
  render(<Page />, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  return client;
}

it("refreshes a completed run on card focus so a newly edited step becomes available", async () => {
  let saved = detail();
  vi.spyOn(api, "getWorkflowRun").mockImplementation(async () => saved);
  const client = showRun();
  await screen.findByText("Completed");
  expect(screen.queryByRole("button", { name: "Re-run changed steps" })).toBeNull();
  saved = { ...saved, rerunDefinitionVersionId: "version-2", rerunSteps: [{ nodeId: "summary" }] };
  act(() => window.dispatchEvent(new Event("focus")));
  fireEvent.click(await screen.findByRole("button", { name: "Re-run changed steps" }));
  expect(await screen.findByText("These steps run again: summary. Every other step keeps this run's result.")).toBeTruthy();
  client.clear();
});

it("refreshes completed previews after a local save and refreshes again before confirmation", async () => {
  let saved = detail();
  vi.spyOn(api, "getWorkflowRun").mockImplementation(async () => saved);
  vi.spyOn(api, "updateWorkflow").mockImplementation(async () => {
    saved = { ...saved, rerunDefinitionVersionId: "version-2", rerunSteps: [{ nodeId: "summary" }] };
    return { id: "workflow", name: "Edited", definition: {}, createdAt: 1, updatedAt: 2, ownerType: "user", ownerId: "person" };
  });
  const client = showRun();
  await screen.findByText("Completed");
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  const rerun = await screen.findByRole("button", { name: "Re-run changed steps" });
  saved = { ...saved, rerunDefinitionVersionId: "version-3", rerunSteps: [{ nodeId: "notify", action: "slack.send_message" }] };
  fireEvent.click(rerun);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByText("These tool steps do their action: notify (slack.send_message).")).toBeTruthy());
  client.clear();
});
