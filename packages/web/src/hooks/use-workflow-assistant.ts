/**
 * Resolves the session and thread the workflow editor's assistant panel
 * talks to.
 *
 * There is no per-workflow session kind. `wf:invoke:{invocationId}` is an
 * action-context id, not a session, and `signal:workflow:{runId}` is a
 * run-scoped thread the server mints — neither is an editor conversation.
 * The panel therefore uses the caller's own default assistant, resolved the
 * way `/chat` resolves it, and gives each workflow its own thread so the
 * editing conversation does not bury the user's main chat.
 *
 * Team-owned workflows need no team assistant: `patch_workflow` authorizes
 * on the acting user, who reaches team workflows through their live
 * memberships. Routing through the team assistant would be worse, since its
 * calls carry the session's stored principal rather than the person typing.
 *
 * The thread id is remembered client-side. `POST /threads` mints its own
 * key and does not persist the title it is given, so there is no server
 * handle to look the panel's thread up by on the next visit.
 *
 * The panel is the editor's right-hand column, so this resolves as soon as
 * the editor mounts rather than waiting for somebody to press a button.
 * That costs one agent turn for each workflow opened in a browser session:
 * the thread is created once and remembered, and the turn it costs is the
 * opening prompt below, which answers "what does this workflow do".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAssistants, useEnsureAssistantSession } from "~/api/assistants";
import { useEnsureOrchestrator, useOrchestratorInfo } from "~/api/orchestrator";
import { useCreateThread, useSendPrompt } from "~/api/queries";
import { groupAssistants, ownDefaultAssistant } from "~/components/session/assistant-rail";

export interface WorkflowAssistant {
  /** Present once the session is confirmed to exist. */
  sessionId?: string;
  /** Present once this workflow's thread exists. */
  threadId?: string;
  /** True while the session or thread is still being set up. */
  opening: boolean;
  /** Set when the panel cannot be opened, and names what to do about it. */
  error?: string;
  /** Runs the setup again from the step that failed. Always present, so the
   * panel can offer recovery without a page reload. */
  retry: () => void;
  /** The step that is still outstanding. Lets the panel say what it waits
   * for rather than showing one spinner for two different calls. */
  stage: "session" | "thread";
}

/**
 * A thread belongs to one session. Remembering the session beside the
 * thread is what stops a thread minted in one assistant's session from
 * being handed to another's, which reads as an empty conversation the user
 * cannot type into.
 */
interface PanelThread {
  sessionId: string;
  threadId: string;
}

function threadStorageKey(workflowId: string): string {
  return `workflow-assistant:${workflowId}`;
}

function isPanelThread(value: unknown): value is PanelThread {
  if (typeof value !== "object" || value === null) return false;
  if (!("sessionId" in value) || !("threadId" in value)) return false;
  return typeof value.sessionId === "string" && typeof value.threadId === "string";
}

/** sessionStorage throws in some privacy modes, and a record written by an
 * older build can be any shape. A remembered thread is a convenience, so
 * neither must break the panel — the caller just gets a fresh thread. */
function readStoredThread(workflowId: string): PanelThread | null {
  try {
    const raw = sessionStorage.getItem(threadStorageKey(workflowId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPanelThread(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeThread(workflowId: string, thread: PanelThread): void {
  try {
    sessionStorage.setItem(threadStorageKey(workflowId), JSON.stringify(thread));
  } catch {
    // Ignored on purpose — see `readStoredThread`.
  }
}

/**
 * The thread creations that are in flight, keyed by session and workflow.
 *
 * `POST /threads` mints a thread on every call, so this hook must call it
 * at most once for each session and workflow. A ref cannot hold that rule:
 * a ref belongs to one mounted component, and the editor page can unmount
 * and mount again while the call is in flight — each new instance then
 * finds an empty ref and an empty sessionStorage, and mints another thread
 * that nothing ever reads. The promise is shared at module scope because
 * the rule outlives the component that starts the call.
 */
const openingThreads = new Map<string, Promise<string>>();

/**
 * Gets this workflow's thread in this session, creating it once.
 *
 * The result is written to sessionStorage HERE rather than in the caller's
 * state setter, because the write must happen even when the component that
 * asked for it is gone. That is the difference between a remount picking
 * the thread back up and a remount minting a second one.
 */
function openThread(
  sessionId: string,
  workflowId: string,
  create: () => Promise<{ id: string }>,
  sendOpeningPrompt: (threadId: string) => void,
): Promise<string> {
  const key = `${sessionId} ${workflowId}`;
  const running = openingThreads.get(key);
  if (running !== undefined) return running;

  const started = create()
    .then((thread) => {
      storeThread(workflowId, { sessionId, threadId: thread.id });
      sendOpeningPrompt(thread.id);
      return thread.id;
    })
    .finally(() => openingThreads.delete(key));
  openingThreads.set(key, started);
  return started;
}

/**
 * Drops the remembered attempt for this session and workflow.
 *
 * The map above is keyed on the rule "create this thread once". A caller
 * that wants a genuinely new attempt — the retry control — must remove the
 * old entry first, or `openThread` returns the previous promise and no
 * request is made. Deletion is safe because the entry is only an
 * optimisation: the worst case is a second create, which the guards in the
 * hook already prevent for the normal path.
 */
function forgetOpeningThread(sessionId: string, workflowId: string): void {
  openingThreads.delete(`${sessionId} ${workflowId}`);
}

/**
 * The message that opens a new panel thread.
 *
 * The prompt carries the workflow id because there is nowhere else to put
 * it: `SendPromptRequest` is `{ text, threadId }` with no context field,
 * and a thread has no system prompt hook. It asks for a summary rather than
 * an acknowledgement so the turn it costs produces something the user
 * wanted anyway — an orientation on the workflow they just opened.
 *
 * It carries the id and nothing else. A first-turn message decays as the
 * conversation grows, so the rule that the agent must APPLY an edit rather
 * than describe it does not live here — it lives in the description of the
 * pinned `workflows__patch_workflow` tool (`api/src/plugins/pinned-actions.ts`),
 * which the model receives again on every turn. Each suggestion chip also
 * re-states the id, so the id itself is repeated as the thread grows.
 */
export function openingPrompt(workflowId: string, workflowName: string): string {
  return [
    `I am editing the workflow "${workflowName}" (\`${workflowId}\`) in the visual editor.`,
    `Read it, then tell me in two sentences what it does.`,
    `Every change I ask for after this is a change to \`${workflowId}\`.`,
  ].join(" ");
}

export function useWorkflowAssistant(
  workflowId: string,
  workflowName: string,
): WorkflowAssistant {
  const assistantsQ = useAssistants();
  const info = useOrchestratorInfo();
  const ensureAssistantSession = useEnsureAssistantSession();
  const ensureOrchestrator = useEnsureOrchestrator();
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null);
  // Both take the session up front. The empty string stands in until the
  // session resolves; the effects below only fire once `openedSessionId` is
  // set, and that same render binds these to the real id.
  const createThread = useCreateThread(openedSessionId ?? "");
  const sendPrompt = useSendPrompt(openedSessionId ?? "");

  const [thread, setThread] = useState<PanelThread | null>(() => readStoredThread(workflowId));
  const [error, setError] = useState<string | undefined>(undefined);
  // Bumped by `retry` below. Both effects depend on it, because their own
  // guards are refs: clearing a ref does not re-run an effect, so without a
  // dependency that actually changes the retry would do nothing.
  const [attempt, setAttempt] = useState(0);

  const own = ownDefaultAssistant(groupAssistants(assistantsQ.data?.assistants, []));
  // `GET /api/orchestrator/info` is the cold-load fallback, exactly as on
  // `/chat`: it still answers when the assistants list fails.
  //
  // It is a fallback and not a head start. `/info` answers first, and
  // acting on its id while the list is still loading opens whichever
  // session answers first — then the list names the default assistant's
  // session and the panel moves to it, stranding the thread just minted on
  // the other one. So nothing resolves until the list has settled.
  const sessionId = assistantsQ.isPending
    ? undefined
    : (own?.sessionId ?? info.data?.sessionId);

  // Both reads have answered and neither named a session. Nothing is in
  // flight and nothing will retry, so the panel has to say so — a spinner
  // here claims work that is not happening.
  const identityFailed = sessionId === undefined && !assistantsQ.isPending && !info.isPending;

  // Neither the assistants list nor `GET /info` creates an engine session,
  // so mounting the conversation on the id they report would 404 with no
  // retry path. Every call here is idempotent.
  /**
   * The session id this mount last called ensure for.
   *
   * It is not cleared on success, because success sets `openedSessionId` and
   * the first guard below then stops the effect before this one is read.
   *
   * It IS re-armed when identity changes — the assistants list settling on a
   * different default after a reconnect. A second ensure is correct there,
   * since the new assistant needs its own session. What is not correct is
   * letting the FIRST call's answer land afterwards: it would write the old
   * assistant's session id over the new one, and the panel would open a
   * conversation belonging to an assistant the user has moved off. The
   * handlers below therefore check that this ref still names the call they
   * belong to before they write anything.
   */
  const ensuringRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || openedSessionId === sessionId) return;
    if (ensuringRef.current === sessionId) return;
    ensuringRef.current = sessionId;
    /** The identity this call is for; compared against the ref on settle. */
    const requested = sessionId;
    // `mutateAsync`, not `mutate` with per-call callbacks. React Query only
    // delivers those callbacks while the observer still has listeners, so an
    // editor page that unmounts while the call is in flight loses the one
    // write of `openedSessionId` and the panel waits for a result that has
    // already arrived. The promise is not gated that way.
    const ensure: Promise<{ sessionId: string }> = own?.id
      ? ensureAssistantSession.mutateAsync(own.id)
      : ensureOrchestrator.mutateAsync(undefined);
    ensure.then(
      (res) => {
        // A late answer for an assistant this hook has moved off must not
        // write its session id over the current one.
        if (ensuringRef.current !== requested) return;
        // The server's own answer, not the id this render guessed from the
        // assistants list.
        setOpenedSessionId(res.sessionId);
      },
      () => {
        // Same staleness check: a superseded call's failure is not this
        // assistant's failure, and clearing the latch here would re-arm the
        // effect for an identity that is no longer current.
        if (ensuringRef.current !== requested) return;
        // Release the latch. It is set before the call and was cleared on no
        // path, so one failed ensure stopped this mount from ever opening a
        // session again.
        ensuringRef.current = null;
        setError("Cannot open your assistant. Use Retry below to try again.");
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, openedSessionId, own?.id, attempt]);

  // One thread per workflow, created on first open and reused after that.
  // The ref holds the SESSION being opened, not a flag: a change of session
  // needs its own thread, and a boolean latch would leave the new session
  // without one.
  const creatingRef = useRef<string | null>(null);
  useEffect(() => {
    if (openedSessionId === null) return;
    if (thread !== null && thread.sessionId === openedSessionId) return;
    if (creatingRef.current === openedSessionId) return;
    creatingRef.current = openedSessionId;
    openThread(
      openedSessionId,
      workflowId,
      () => createThread.mutateAsync({}),
      (threadId) =>
        // Fire and forget. `mutate` swallows its own errors, and a thread
        // that opens without its summary is a conversation the user can
        // still type into — not a reason to replace the panel with an
        // error.
        sendPrompt.mutate({ text: openingPrompt(workflowId, workflowName), threadId }),
    ).then(
      (threadId) => setThread({ sessionId: openedSessionId, threadId }),
      () => {
        creatingRef.current = null;
        setError("Cannot start the assistant conversation. Use Retry below to try again.");
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedSessionId, thread, workflowId, workflowName, attempt]);

  /**
   * Starts the whole sequence again, from whichever step failed.
   *
   * Both guards are refs and the remembered attempt is module state, so all
   * three must be released together. Clearing any one of them alone leaves
   * the panel in the same stuck state it was already in.
   */
  const retry = useCallback(() => {
    setError(undefined);
    ensuringRef.current = null;
    creatingRef.current = null;
    if (openedSessionId !== null) forgetOpeningThread(openedSessionId, workflowId);
    setAttempt((n) => n + 1);
  }, [openedSessionId, workflowId]);

  const threadId =
    thread !== null && thread.sessionId === openedSessionId ? thread.threadId : undefined;
  const ready = openedSessionId !== null && threadId !== undefined;
  const shown =
    error ?? (identityFailed ? "Cannot find your assistant. Use Retry below to try again." : undefined);
  return {
    ...(openedSessionId !== null ? { sessionId: openedSessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    opening: !ready && shown === undefined,
    ...(shown !== undefined ? { error: shown } : {}),
    // Named the same way whether the session or the thread failed: the panel
    // offers one control, and the hook knows which step to resume.
    retry,
    // Which step is outstanding. The panel showed one spinner for both, so a
    // stall gave no clue which call was outstanding.
    stage: openedSessionId === null ? "session" : "thread",
  };
}
