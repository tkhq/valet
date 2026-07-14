import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEnsureOrchestrator, useOrchestratorInfo } from "~/api/orchestrator";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import { Spinner } from "~/components/primitives";

interface ChatSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Open child session id — renders `ChildPanel` as a slide-over. */
  child?: string;
}

/**
 * `/chat` — the assistant conversation (assistant-centered web UI,
 * decision 1/12/13). Mounts the shared `SessionView` for the assistant's
 * session id with `variant="full"` — the thread-tree sidebar (nested
 * children, decision 12) is swapped in by the root layout for this route
 * (see `__root.tsx`), not rendered here.
 */
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const info = useOrchestratorInfo();
  const { thread, child } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const ensure = useEnsureOrchestrator();

  const sessionId = info.data?.sessionId;

  // Decision 20 / brief: `GET /info` never creates the engine session — if
  // the assistant has a name but no session record yet, ensure it exists
  // before SessionView tries to open it. Idempotent; safe on every mount.
  useEffect(() => {
    if (sessionId) ensure.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // CRITICAL (Task 1 flag): signal entries (e.g. child.settled) only reach
  // the client via REST — no live WS event carries the signal payload.
  // `useMessages` has background refetch disabled, so without this the
  // chat page would never show a new signal until manually reloaded.
  useInvalidateMessagesOnQueueState(sessionId, thread);

  function closeChild() {
    navigate({ search: (prev) => ({ ...prev, child: undefined }) });
  }

  function openChild(childId: string) {
    navigate({ search: (prev) => ({ ...prev, child: childId }) });
  }

  if (info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (info.error || !sessionId) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn't load your assistant.
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => info.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <SessionView
        sessionId={sessionId}
        variant="full"
        activeThreadId={thread}
        onOpenChild={openChild}
      />
      {child && <ChildPanel childId={child} onClose={closeChild} />}
    </>
  );
}
