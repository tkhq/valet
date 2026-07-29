import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, ExternalLink } from "lucide-react";
import {
  useDecisions,
  useMessages,
  useSession,
  useThreads,
} from "~/api/queries";
import { useSessionWebSocket } from "~/api/ws";
import {
  useSessionStream,
  useStreamStore,
  usePendingGateForThread,
} from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { SandboxTabs, type SandboxTabId } from "~/components/session/sandbox-tabs";
import { SessionHeader } from "~/components/session/session-header";
import { Button, Spinner } from "~/components/primitives";

export type SessionViewVariant = "full" | "panel" | "standalone";

/**
 * Reusable session view (assistant-centered web UI, decisions 13/14):
 * threads/gates/tool cards/WS resume/optimistic messages — everything the
 * old `/sessions/$sessionId` route did inline — now lives here so `/chat`,
 * the child slide-over, and the standalone session page all share one
 * implementation instead of three copies.
 *
 * Variant controls header chrome only. The threads/thread-tree *sidebar*
 * is NOT rendered here — it's a root-layout concern (`__root.tsx` swaps
 * `ThreadTree`/nothing based on the current route), because the sidebar
 * lives outside this component's DOM subtree in the app shell's `<aside>`.
 * "full" (used by `/chat`) gets the thread-tree sidebar from the root
 * layout; "standalone" (`/sessions/$sessionId`) and "panel" (`ChildPanel`)
 * get no sidebar at all (decisions 14/13).
 *
 * - `full` / `standalone`: identical body — the existing `SessionHeader`
 *   (title, model picker, sandbox/connection/status chips, delete).
 * - `panel`: compact header (title + "open full page" + ✕ close) instead,
 *   no delete/model-picker chrome — this is a lightweight peek, not the
 *   session's home.
 */
export function SessionView({
  sessionId,
  variant,
  activeThreadId,
  onClose,
  onOpenChild,
  activeTab,
  onTabChange,
}: {
  sessionId: string;
  variant: SessionViewVariant;
  /**
   * Controlled active thread id, typically derived from the host route's
   * `?thread=` search param (full/standalone). When omitted (panel), the
   * view falls back to the session's first/default thread.
   */
  activeThreadId?: string;
  /** panel-only: closes the slide-over. Required when variant === "panel". */
  onClose?: () => void;
  /**
   * Called when a child-card signal is clicked. When omitted, `SignalCard`
   * falls back to a plain link to the child's full-page session view.
   */
  onOpenChild?: (childSessionId: string) => void;
  /**
   * Controlled active tab (Chat/Terminal/VS Code), typically derived from
   * the host route's `?tab=` search param (standalone). When omitted
   * (full/panel), this view falls back to internal state defaulting to
   * "chat" — those hosts don't have a `?tab=` search param of their own.
   */
  activeTab?: SandboxTabId;
  /** Required alongside a controlled `activeTab`; ignored otherwise. */
  onTabChange?: (tab: SandboxTabId) => void;
}) {
  const session = useSession(sessionId);
  const [localTab, setLocalTab] = useState<SandboxTabId>("chat");
  const tab = activeTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const threads = useThreads(sessionId);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

  const effectiveThreadId = activeThreadId ?? threads.data?.threads[0]?.id ?? undefined;

  // Load this thread's persisted messages from REST and pipe into the
  // stream store. Background refetches are disabled (see `useMessages`) so
  // this never wipes live state mid-session.
  const messagesQ = useMessages(sessionId, effectiveThreadId);
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (!effectiveThreadId || !messagesQ.data) return;
    setThreadMessages(sessionId, effectiveThreadId, messagesQ.data.messages);
  }, [sessionId, effectiveThreadId, messagesQ.data, setThreadMessages]);

  // Bootstrap pending decision gates from REST so the card shows
  // immediately on load; subsequent gates arrive via the wire.
  const decisionsQ = useDecisions(sessionId);
  const setPendingGates = useStreamStore((s) => s.setPendingGates);
  useEffect(() => {
    if (!decisionsQ.data) return;
    setPendingGates(
      sessionId,
      decisionsQ.data.gates.filter((g) => g.status === "pending"),
    );
  }, [sessionId, decisionsQ.data, setPendingGates]);

  const pendingGate = usePendingGateForThread(sessionId, effectiveThreadId);

  if (session.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading session…
      </div>
    );
  }
  if (session.error || !session.data) {
    return (
      <div className="flex-1 grid place-items-center text-center text-sm text-danger-500 p-8">
        Failed to load session
        <div className="text-xs text-muted mt-1">{(session.error as Error)?.message}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {variant === "panel" ? (
        <PanelHeader sessionId={sessionId} title={session.data.title} onClose={onClose} />
      ) : (
        <SessionHeader
          session={session.data}
          agentStatus={stream.agentStatus}
          conn={stream.conn}
          sandbox={stream.sandbox}
        />
      )}
      <SandboxTabs
        sessionId={sessionId}
        profile={session.data.profile}
        activeTab={tab}
        onTabChange={setTab}
        sandbox={stream.sandbox}
      />
      {tab === "chat" ? (
        <>
          <MessageList
            messages={stream.messages}
            threadId={effectiveThreadId}
            onOpenChild={onOpenChild}
            agentBusy={stream.agentStatus !== "idle" && stream.agentStatus !== "error"}
          />
          {stream.error && (
            <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
              <span className="font-medium">{stream.error.code}:</span> {stream.error.message}
            </div>
          )}
          {pendingGate && <DecisionGateCard sessionId={sessionId} gate={pendingGate} />}
          <Composer sessionId={sessionId} threadId={effectiveThreadId} agentStatus={stream.agentStatus} />
        </>
      ) : null}
    </div>
  );
}

function PanelHeader({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title?: string;
  onClose?: () => void;
}) {
  return (
    <header className="border-b border-line px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold tracking-tight truncate text-ink">
          {title || "Untitled session"}
        </div>
      </div>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId }}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-moss"
        aria-label="Open full page"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        open full page
      </Link>
      <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
        <X className="h-4 w-4" />
      </Button>
    </header>
  );
}
