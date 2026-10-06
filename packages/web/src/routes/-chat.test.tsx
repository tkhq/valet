// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import "./chat";
const capture = vi.hoisted(() => ({ page: undefined as (() => ReactElement) | undefined }));
const createThread = vi.fn();
const navigate = vi.fn();
let data: { sessionId: string } | undefined;
let error: Error | null = null;
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: () => ReactElement }) => {
    capture.page = config.component; return { ...config, fullPath: "/chat", useSearch: () => ({ thread: "thread-a" }) };
  }, useNavigate: () => navigate,
}));
vi.mock("~/hooks/use-workspace-conversation", () => ({ useWorkspaceConversation: () => ({ data, error, refetch: vi.fn() }) }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ key: "team-a", teamId: "team-a" }) }));
let teamMetadata = true;
vi.mock("~/api/settings", () => ({ useTeams: () => ({ data: teamMetadata ? { teams: [{ id: "team-a", name: "Platform" }] } : undefined }) }));
let threadKey: string | undefined = "web:default";
let empty = false;
vi.mock("~/api/queries", () => ({
  useThreads: () => ({ data: { threads: empty ? [] : [{ id: "thread-a", sessionId: "shared-execution", key: threadKey, createdAt: 1 }] } }),
  useCreateThread: () => ({ mutateAsync: createThread, isPending: false }),
}));
vi.mock("~/hooks/use-invalidate-messages-on-queue-state", () => ({ useInvalidateMessagesOnQueueState: vi.fn() }));
vi.mock("~/components/session/session-view", () => ({ SessionView: ({ sessionId, activeThreadId, scopeNotice }: { sessionId: string; activeThreadId?: string; scopeNotice?: string }) => <div data-testid="conversation" data-scope-notice={scopeNotice}>{sessionId}:{activeThreadId}</div> }));
vi.mock("~/components/session/child-panel", () => ({ ChildPanel: () => null }));
beforeEach(() => { data = { sessionId: "team-session" }; error = null; empty = false; teamMetadata = true; vi.clearAllMocks(); createThread.mockResolvedValue({ id: "created" }); });
function show() { if (!capture.page) throw new Error("missing route"); const Page = capture.page; return render(<Page />); }
it("opens the resolved workspace thread and labels its audience", () => {
  show(); expect(screen.getByTestId("conversation").textContent).toBe("shared-execution:thread-a");
  expect(screen.getByTestId("conversation").getAttribute("data-scope-notice")).toBe("Shared with Platform. Members can read and reply.");
});
it("offers a new thread instead of mounting a read-only root when no conversation is available", async () => {
  empty = true; teamMetadata = false; show();
  expect(screen.queryByTestId("conversation")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New thread" }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(createThread).toHaveBeenCalledTimes(1);
});
it("tells a helper thread's person that only they can see it", () => {
  threadKey = "app-assistant:me"; show();
  expect(screen.getByTestId("conversation").getAttribute("data-scope-notice")).toBe("Only you can see this thread.");
  threadKey = "web:default";
});
it("does not read a conversation before its session is ensured", () => {
  data = undefined; show(); expect(screen.queryByTestId("conversation")).toBeNull();
  expect(screen.getByText("Opening threads…")).toBeTruthy();
});
it("shows errors without silently substituting a personal conversation", () => {
  data = undefined; error = new Error("not found"); show();
  expect(screen.queryByTestId("conversation")).toBeNull(); expect(screen.getByRole("alert")).toBeTruthy();
});
