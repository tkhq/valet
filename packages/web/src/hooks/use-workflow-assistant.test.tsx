// @vitest-environment jsdom
/**
 * `useWorkflowAssistant` — the session and thread the editor's right-hand
 * column talks to.
 *
 * The panel shows "Opening the assistant…" until BOTH ids are set, so every
 * test here is about one question: does the panel reach that state, and does
 * it say something when it cannot? A hook that resolves neither id and
 * reports no error leaves a spinner on screen forever, which is what a
 * person reported and what these tests hold shut.
 *
 * The whole file runs under `StrictMode`, because `main.tsx` does, and the
 * effects below fire twice there.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowDefinition } from "@valet/workflow";
import type {
  CreateThreadResponse,
  EnsureAssistantSessionResponse,
  GetOrchestratorInfoResponse,
  ListAssistantsResponse,
  SendPromptResponse,
} from "@valet/api/wire";

const ASSISTANT_ID = "asst_1";
const SESSION = `assistant:${ASSISTANT_ID}`;
const OTHER_SESSION = "orchestrator:user-1";
const WORKFLOW = "wf_1";

const listAssistants = vi.fn<() => Promise<ListAssistantsResponse>>();
const getOrchestratorInfo = vi.fn<() => Promise<GetOrchestratorInfoResponse>>();
const ensureAssistantSession =
  vi.fn<(assistantId: string) => Promise<EnsureAssistantSessionResponse>>();
const ensureOrchestrator = vi.fn<() => Promise<{ sessionId: string }>>();
const createThread = vi.fn<(sessionId: string) => Promise<CreateThreadResponse>>();
const sendPrompt = vi.fn<(sessionId: string) => Promise<SendPromptResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      listAssistants: () => listAssistants(),
      getOrchestratorInfo: () => getOrchestratorInfo(),
      ensureAssistantSession: (assistantId: string) => ensureAssistantSession(assistantId),
      ensureOrchestrator: () => ensureOrchestrator(),
      createThread: (sessionId: string) => createThread(sessionId),
      sendPrompt: (sessionId: string) => sendPrompt(sessionId),
    },
  };
});

/** The conversation itself is the chat stack's business — a WS, a
 * transcript and a composer. What matters here is only whether the panel
 * gets far enough to mount it. */
vi.mock("~/components/session/session-view", () => ({
  SessionView: ({ sessionId, activeThreadId }: { sessionId: string; activeThreadId: string }) => (
    <div data-testid="session-view">{`${sessionId} ${activeThreadId}`}</div>
  ),
}));

import { useWorkflowAssistant } from "./use-workflow-assistant";
import { WorkflowAssistantPanel } from "~/components/workflows/editor/assistant-panel";

const DEFINITION: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/**
 * One client per TEST, shared by every mount inside it. The app has one
 * client for its whole lifetime, and the remount tests below are about what
 * survives an unmount — a fresh client for each mount would answer a
 * different question.
 */
function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

let wrapper = makeWrapper();

describe("useWorkflowAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    wrapper = makeWrapper();
    listAssistants.mockResolvedValue({
      assistants: [
        {
          id: ASSISTANT_ID,
          owner: { type: "user", id: "user-1" },
          sessionId: SESSION,
          isDefault: true,
          createdAt: 1,
        },
      ],
    });
    getOrchestratorInfo.mockResolvedValue({
      sessionId: SESSION,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });
    ensureAssistantSession.mockResolvedValue({ sessionId: SESSION });
    ensureOrchestrator.mockResolvedValue({ sessionId: SESSION });
    createThread.mockResolvedValue({ id: "thread_1", sessionId: SESSION, createdAt: 1 });
    sendPrompt.mockResolvedValue({ messageId: "m1", threadId: "thread_1" });
  });

  it("reaches the ready state once the session opens and the thread exists", async () => {
    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });

    await waitFor(() => expect(result.current.threadId).toBe("thread_1"));
    expect(result.current.sessionId).toBe(SESSION);
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("mints one thread when the editor mounts again while the first call is in flight", async () => {
    let settle: (thread: CreateThreadResponse) => void = () => {};
    createThread.mockImplementation(
      () => new Promise<CreateThreadResponse>((resolve) => (settle = resolve)),
    );

    const first = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));

    // The editor page goes away mid-call and comes back. The second mount
    // has an empty ref and an empty sessionStorage, so nothing it owns can
    // tell it a thread is already on its way.
    first.unmount();
    const second = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });
    await waitFor(() => expect(second.result.current.sessionId).toBe(SESSION));
    expect(createThread).toHaveBeenCalledTimes(1);

    // React Query drops the callbacks passed to `mutate` when the observer
    // loses its listeners, so a thread remembered from one of those
    // callbacks would be lost with the first mount.
    settle({ id: "thread_1", sessionId: SESSION, createdAt: 1 });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread_1"));
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("opens the remembered thread again without a second call", async () => {
    const first = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });
    await waitFor(() => expect(first.result.current.threadId).toBe("thread_1"));
    first.unmount();

    const second = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread_1"));
    expect(createThread).toHaveBeenCalledTimes(1);
  });

  it("waits for the assistants list, so the thread lands in the session the panel opens", async () => {
    let settleList: () => void = () => {};
    listAssistants.mockImplementation(
      () =>
        new Promise<ListAssistantsResponse>((resolve) => {
          settleList = () =>
            resolve({
              assistants: [
                {
                  id: ASSISTANT_ID,
                  owner: { type: "user", id: "user-1" },
                  sessionId: SESSION,
                  isDefault: true,
                  createdAt: 1,
                },
              ],
            });
        }),
    );
    // `GET /info` answers first and names a different session.
    getOrchestratorInfo.mockResolvedValue({
      sessionId: OTHER_SESSION,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });
    ensureOrchestrator.mockResolvedValue({ sessionId: OTHER_SESSION });

    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });
    await waitFor(() => expect(getOrchestratorInfo).toHaveBeenCalled());
    expect(createThread).not.toHaveBeenCalled();

    settleList();
    await waitFor(() => expect(result.current.threadId).toBe("thread_1"));
    expect(result.current.sessionId).toBe(SESSION);
    expect(createThread).toHaveBeenCalledExactlyOnceWith(SESSION);
  });

  it("says so when neither read can name an assistant", async () => {
    listAssistants.mockRejectedValue(new Error("Failed to fetch"));
    getOrchestratorInfo.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    // The spinner claims work in progress. Nothing is in flight here and
    // nothing retries, so the panel must not show one.
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toContain("Reload the page");
    expect(createThread).not.toHaveBeenCalled();
  });

  it("says so when the thread cannot be created", async () => {
    createThread.mockRejectedValue(new Error("500"));

    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.opening).toBe(false);
  });
});

describe("WorkflowAssistantPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    wrapper = makeWrapper();
    listAssistants.mockResolvedValue({
      assistants: [
        {
          id: ASSISTANT_ID,
          owner: { type: "user", id: "user-1" },
          sessionId: SESSION,
          isDefault: true,
          createdAt: 1,
        },
      ],
    });
    getOrchestratorInfo.mockResolvedValue({
      sessionId: SESSION,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });
    ensureAssistantSession.mockResolvedValue({ sessionId: SESSION });
    createThread.mockResolvedValue({ id: "thread_1", sessionId: SESSION, createdAt: 1 });
    sendPrompt.mockResolvedValue({ messageId: "m1", threadId: "thread_1" });
  });

  it("replaces the opening spinner with the conversation", async () => {
    function Panel() {
      const assistant = useWorkflowAssistant(WORKFLOW, "Deploy");
      return (
        <WorkflowAssistantPanel
          assistant={assistant}
          definition={DEFINITION}
          workflowId={WORKFLOW}
        />
      );
    }
    render(<Panel />, { wrapper });

    expect(screen.getByText(/Opening the assistant/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("session-view").textContent).toBe(`${SESSION} thread_1`),
    );
    expect(screen.queryByText(/Opening the assistant/)).toBeNull();
  });
});
