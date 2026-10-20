// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "~/api/client";
import { ENSURE_CONVERSATION_MUTATION, WorkspaceAssistantDock, WorkspaceAssistantProvider, useWorkspaceAssistant } from "./workspace-assistant";

vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ key: "user" }) }));
vi.mock("~/components/session/assistant-panel", () => ({
  AssistantPanel: ({ sessionId, threadId }: { sessionId?: string; threadId?: string }) => <p>Conversation {sessionId}/{threadId}</p>,
}));

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

function OpenButton() {
  const assistant = useWorkspaceAssistant();
  return <button onClick={() => assistant.open()}>Ask Valet</button>;
}

function renderAt(path: string) {
  const root = createRootRoute({ component: () => <WorkspaceAssistantProvider><OpenButton /><Outlet /><WorkspaceAssistantDock /></WorkspaceAssistantProvider> });
  const routes = ["/chat", "/workflows/$workflowId"].map(route => createRoute({ getParentRoute: () => root, path: route, component: () => null }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("Ask Valet conversation request", () => {
  // With the default network mode, an offline open paused and never settled,
  // so the panel showed neither an error nor Retry.
  it("fails at once while the browser is offline, so the panel can offer Retry", async () => {
    onlineManager.setOnline(false);
    const observer = new MutationObserver(new QueryClient(), {
      ...ENSURE_CONVERSATION_MUTATION,
      mutationFn: () => Promise.reject(new Error("Failed to fetch")),
    });
    const settled = observer.mutate().then(() => "resolved", (error: Error) => error.message);
    const timeout = new Promise((resolve) => setTimeout(() => resolve("paused"), 200));
    expect(await Promise.race([settled, timeout])).toBe("Failed to fetch");
  });
});

describe("Ask Valet panel", () => {
  // The panel shares one socket per session with the open thread, so it
  // docks beside Threads instead of replacing the open thread.
  it("docks beside the open thread on /chat", async () => {
    vi.spyOn(api, "ensureWorkspaceConversation").mockResolvedValue({ sessionId: "s1", threadId: "assistant" });
    const router = renderAt("/chat?thread=work");
    await userEvent.click(await screen.findByRole("button", { name: "Ask Valet" }));
    expect(await screen.findByText("Conversation s1/assistant")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Valet assistant" })).toBeTruthy();
    expect(router.state.location.search).toEqual({ thread: "work" });
  });

  it("opens a workflow's own conversation in Threads", async () => {
    vi.spyOn(api, "ensureWorkflowConversation").mockResolvedValue({ sessionId: "s1", threadId: "workflow-thread" });
    vi.spyOn(api, "getSession").mockResolvedValue({ owner: { type: "user", id: "u1" } } as Awaited<ReturnType<typeof api.getSession>>);
    const router = renderAt("/workflows/wf1");
    await userEvent.click(await screen.findByRole("button", { name: "Ask Valet" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(router.state.location.search).toEqual({ workspace: "user", thread: "workflow-thread" });
    expect(screen.queryByRole("complementary", { name: "Valet assistant" })).toBeNull();
  });
});
