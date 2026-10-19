// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "~/api/client";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { ENSURE_CONVERSATION_MUTATION, WorkspaceAssistantDock, WorkspaceAssistantProvider, useWorkspaceAssistant } from "./workspace-assistant";

vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ key: "user" }) }));
vi.mock("~/components/session/assistant-panel", () => ({
  AssistantPanel: ({ sessionId, threadId, actions }: { sessionId?: string; threadId?: string; actions?: React.ReactNode }) => <div><p>Conversation {sessionId}/{threadId}</p>{actions}</div>,
}));

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  useComposerDraftStore.setState({ byKey: {} });
});

function OpenButton() {
  const assistant = useWorkspaceAssistant();
  return <>
    <button onClick={() => assistant.open()}>Ask Valet</button>
    <button onClick={() => assistant.open("Summarize this page")}>Try in chat</button>
    <button onClick={assistant.close}>Close Valet</button>
  </>;
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

describe("Ask Valet conversation rule", () => {
  const draft = (threadId: string) => useComposerDraftStore.getState().byKey[draftKey("s1", threadId)]?.text;

  it("starts a new conversation each time the panel opens from closed", async () => {
    const ensure = vi.spyOn(api, "ensureWorkspaceConversation")
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "first" })
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "second" });
    renderAt("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Ask Valet" }));
    expect(await screen.findByText("Conversation s1/first")).toBeTruthy();
    expect(ensure).toHaveBeenLastCalledWith("user", { fresh: true, unlessBusy: true });
    // Asking again while the panel is open keeps the open conversation.
    await userEvent.click(screen.getByRole("button", { name: "Ask Valet" }));
    expect(ensure).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close Valet" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask Valet" }));
    expect(await screen.findByText("Conversation s1/second")).toBeTruthy();
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("puts a contextual prompt in a new conversation, or in the open one", async () => {
    const ensure = vi.spyOn(api, "ensureWorkspaceConversation")
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "contextual" })
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "open" });
    renderAt("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Try in chat" }));
    expect(await screen.findByText("Conversation s1/contextual")).toBeTruthy();
    expect(ensure).toHaveBeenLastCalledWith("user", { fresh: true });
    expect(draft("contextual")).toBe("Summarize this page");

    await userEvent.click(screen.getByRole("button", { name: "Close Valet" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask Valet" }));
    expect(await screen.findByText("Conversation s1/open")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try in chat" }));
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(draft("open")).toBe("Summarize this page");
  });

  it("starts a new chat from the header and reopens a recent conversation", async () => {
    const ensure = vi.spyOn(api, "ensureWorkspaceConversation")
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "older" })
      .mockResolvedValueOnce({ sessionId: "s1", threadId: "newer" });
    vi.spyOn(api, "listWorkspaceConversations").mockResolvedValue({ sessionId: "s1", conversations: [
      { threadId: "newer", createdAt: 2, lastUserActivityAt: 2, busy: false },
      { threadId: "older", title: "Rename my account", createdAt: 1, lastUserActivityAt: 1, busy: true },
    ] });
    renderAt("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Ask Valet" }));
    await userEvent.click(await screen.findByRole("button", { name: "New chat" }));
    expect(await screen.findByText("Conversation s1/newer")).toBeTruthy();
    expect(ensure).toHaveBeenLastCalledWith("user", { fresh: true });

    await userEvent.click(screen.getByRole("button", { name: "Recent conversations" }));
    expect((await screen.findByRole("menuitem", { name: /New conversation/ })).getAttribute("aria-current")).toBe("true");
    await userEvent.click(screen.getByRole("menuitem", { name: /Rename my account/ }));
    expect(await screen.findByText("Conversation s1/older")).toBeTruthy();
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
