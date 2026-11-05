// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { encode } from "@toon-format/toon";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";
import { setToolCardDefault } from "~/lib/preferences";
import type { StreamMessage } from "~/stores/stream";
import { MessageItem } from "../message-item";

const started = {
  runId: "wfrun_1",
  workflowId: "wf_1",
  status: "pending",
  followUp: { registered: true, status: "awaiting_settlement" },
};

function run(overrides: Partial<WorkflowRunDetail["run"]> = {}): WorkflowRunDetail {
  return {
    run: {
      runId: "wfrun_1",
      workflowId: "wf_1",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      waitingOn: [],
      definition: null,
      params: {},
      ...overrides,
    },
    owner: { type: "user", id: "u1" },
    checkpoints: [],
    signals: [],
    pendingGates: [],
  };
}

function message({
  toolName = "call_tool",
  action = "start_run",
  status = "completed",
  result = { text: encode(started) },
  error,
}: {
  toolName?: string;
  action?: string;
  status?: "running" | "completed" | "error";
  result?: unknown;
  error?: string;
} = {}): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content: "",
    createdAt: 1,
    completed: status === "completed",
    parts: [{
      kind: "tool_call",
      callId: "c1",
      toolName,
      args: toolName === "call_tool"
        ? { tool_id: `workflows.${action}`, params: { workflow_id: "wf_1" } }
        : { workflow_id: "wf_1" },
      status,
      result,
      error,
    }],
  };
}

function renderMessage(initialMessage = message()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workflows/runs/$runId" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([runRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  function tree(value: StreamMessage) {
    return (
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <TooltipProvider><MessageItem message={value} ratings={false} /></TooltipProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  }
  const view = render(tree(initialMessage));
  return { ...view, rerenderMessage: (value: StreamMessage) => view.rerender(tree(value)) };
}

async function advance(milliseconds = 10) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

describe("workflow start run preview", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.spyOn(api, "getWorkflowRun").mockResolvedValue(run());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps polling after the start tool auto-collapses and stops when the run settles", async () => {
    const view = renderMessage(message({ status: "running", result: null }));
    expect(screen.queryByRole("status", { name: "Workflow run status" })).toBeNull();

    view.rerenderMessage(message());
    await advance();
    const header = screen.getByRole("button", { name: /call tool/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(within(header).getByText("done")).toBeTruthy();
    const preview = screen.getByRole("status", { name: "Workflow run status" });
    expect(preview.closest("section")).toBeNull();
    expect(within(preview).getByText("running")).toBeTruthy();
    expect(within(preview).getByText("Completion follow-up registered.")).toBeTruthy();
    expect(within(preview).getByRole("link", { name: "Open run" }).getAttribute("href"))
      .toBe("/workflows/runs/wfrun_1");

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(screen.getByRole("status", { name: "Workflow run status" })).toBe(preview);

    vi.mocked(api.getWorkflowRun).mockResolvedValue(run({ status: "settled", outcome: "failed" }));
    await advance(5_010);
    expect(within(preview).getByText("failed")).toBeTruthy();
    expect(within(preview).queryByText("running")).toBeNull();
    expect(within(preview).getByText("Completion follow-up registered.")).toBeTruthy();
    expect(within(preview).queryByText(/delivered|sent|notified/i)).toBeNull();
    const requestsAtSettlement = vi.mocked(api.getWorkflowRun).mock.calls.length;
    await advance(15_000);
    expect(vi.mocked(api.getWorkflowRun).mock.calls.length).toBe(requestsAtSettlement);
  });

  it.each([
    ["call_tool", { text: JSON.stringify(started) }],
    ["call_tool", { content: [{ type: "text", text: encode(started) }] }],
    ["workflows__start_run", encode(started)],
  ])("restores a collapsed %s run from persisted result text", async (toolName, result) => {
    setToolCardDefault("always-collapsed");
    const persisted = message({ toolName, result });
    const view = renderMessage(persisted);
    await advance();
    expect(screen.getByRole("status", { name: "Workflow run status" }).textContent).toContain("running");
    view.unmount();

    vi.mocked(api.getWorkflowRun).mockResolvedValue(run({ status: "settled", outcome: "completed" }));
    renderMessage(structuredClone(persisted));
    await advance();
    expect(screen.getByRole("status", { name: "Workflow run status" }).textContent).toContain("completed");
    expect(screen.getByRole("button", { name: /start.run|call tool/i }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it.each([
    [{ status: "pending" }, "pending"],
    [{ status: "parked" }, "parked"],
    [{ status: "terminalizing" }, "terminalizing"],
    [{ status: "terminalizing", outcome: "completed" }, "terminalizing"],
    [{ status: "settled", outcome: "completed" }, "completed"],
    [{ status: "settled", outcome: "cancelled" }, "cancelled"],
  ] satisfies [Partial<WorkflowRunDetail["run"]>, string][])("shows the current run state %j", async (overrides, label) => {
    vi.mocked(api.getWorkflowRun).mockResolvedValue(run(overrides));
    renderMessage();
    await advance();
    expect(within(screen.getByRole("status", { name: "Workflow run status" })).getByText(label)).toBeTruthy();
  });

  it.each([false, undefined, "true"])("does not promise follow-up when registered is %s", async (registered) => {
    renderMessage(message({ result: { text: JSON.stringify({ ...started, followUp: { registered } }) } }));
    await advance();
    const preview = screen.getByRole("status", { name: "Workflow run status" });
    expect(within(preview).getByText("running")).toBeTruthy();
    expect(within(preview).queryByText("Completion follow-up registered.")).toBeNull();
    if (registered === false) {
      expect(within(preview).getByText("No automatic chat follow-up registered.")).toBeTruthy();
    }
  });

  it("shows loading without claiming the persisted pending state is current", () => {
    vi.mocked(api.getWorkflowRun).mockImplementation(() => new Promise(() => {}));
    renderMessage();
    const preview = screen.getByRole("status", { name: "Workflow run status" });
    expect(within(preview).getByText("Loading run status…")).toBeTruthy();
    expect(within(preview).queryByText("pending")).toBeNull();
  });

  it.each([
    [500, "Run status unavailable. Open the run to try again."],
    [404, "Run not found or no longer accessible. Open the run to check access."],
  ])("reports a %s fetch failure without calling the run complete", async (status, text) => {
    vi.mocked(api.getWorkflowRun).mockRejectedValue(new ApiError(status, "request failed"));
    renderMessage();
    await advance();
    const preview = screen.getByRole("status", { name: "Workflow run status" });
    expect(within(preview).getByText(text)).toBeTruthy();
    expect(within(preview).queryByText("running")).toBeNull();
    expect(within(preview).getByRole("link", { name: "Open run" })).toBeTruthy();
  });

  it.each([
    { status: "error", error: "Start failed. Retry." },
    { action: "get_run" },
    { result: { text: "workflows.start_run failed: workflow not found" } },
    { result: { text: JSON.stringify({ ...started, runId: "" }) } },
  ] satisfies Parameters<typeof message>[0][])("does not show a background run for %j", async (options) => {
    setToolCardDefault("always-collapsed");
    renderMessage(message(options));
    await advance();
    expect(screen.queryByRole("status", { name: "Workflow run status" })).toBeNull();
  });
});
