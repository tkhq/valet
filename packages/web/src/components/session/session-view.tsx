import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  qk,
  useMessages,
  useSession,
  useThreads,
} from "~/api/queries";
import { api } from "~/api/client";
import { useSessionWebSocket } from "~/api/ws";
import {
  queueBusy,
  useSessionStream,
  useStreamStore,
  usePendingGateForThread,
  useQueueStateForThread,
  useThreadLiveStatus,
  useErrorForThread,
} from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import {
  ComposerDropContext,
  type ComposerDropChannel,
  type ComposerDropIntake,
} from "~/components/session/composer-drop-context";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { PageDropTarget } from "~/components/session/page-drop-target";
import { SandboxTabs, type SandboxTabId } from "~/components/session/sandbox-tabs";
import { SessionHeader } from "~/components/session/session-header";
import { useMe } from "~/api/settings";
import { useInvalidateSessionOnModelSwitch } from "~/hooks/use-invalidate-session-on-model-switch";
import { usePendingGatesSeed } from "~/hooks/use-pending-gates-seed";
import { Button, Spinner } from "~/components/primitives";

/**
 * Reusable session view (assistant-centered web UI, decisions 13/14):
 * threads/gates/tool cards/WS resume/optimistic messages — everything the
 * old `/sessions/$sessionId` route did inline — now lives here so `/chat`,
 * the child slide-over, and the standalone session page all share one
 * implementation instead of three copies.
 *
 * `panel` selects the header chrome, and nothing else. The threads/
 * thread-tree *sidebar* is NOT rendered here — it's a root-layout concern
 * (`__root.tsx` swaps `ThreadTree`/nothing based on the current route),
 * because the sidebar lives outside this component's DOM subtree in the
 * app shell's `<aside>`.
 *
 * - default: the existing `SessionHeader` (title, model picker,
 *   sandbox/connection/status chips, delete).
 * - `panel`: compact header (title, "open full page", and a ✕ close for a
 *   host that passes `onClose`) instead, with no delete/model-picker
 *   chrome — this is a lightweight peek, not the session's home.
 */
export function SessionView({
  sessionId,
  panel,
  activeThreadId,
  onClose,
  onOpenChild,
  activeTab,
  onTabChange,
}: {
  sessionId: string;
  /** Renders the compact slide-over header instead of `SessionHeader`. */
  panel?: boolean;
  /**
   * Controlled active thread id, typically derived from the host route's
   * `?thread=` search param (full/standalone). When omitted (panel), the
   * view falls back to the session's first/default thread.
   */
  activeThreadId?: string;
  /**
   * panel-only: closes the slide-over. Omitted by a host whose panel is
   * permanent — the workflow editor's assistant column is the surface
   * itself, so a ✕ there would offer to close something that must stay.
   */
  onClose?: () => void;
  /**
   * Called when a child-card signal is clicked. When omitted, `SignalCard`
   * falls back to a plain link to the child's full-page session view.
   */
  onOpenChild?: (childSessionId: string) => void;
  /**
   * Controlled active tab (Chat/Terminal/VS Code), typically derived from
   * the host route's `?tab=` search param (`/sessions/$sessionId`). When
   * omitted, this view falls back to internal state defaulting to "chat" —
   * the other hosts have no `?tab=` search param of their own.
   */
  activeTab?: SandboxTabId;
  /** Required alongside a controlled `activeTab`; ignored otherwise. */
  onTabChange?: (tab: SandboxTabId) => void;
}) {
  const session = useSession(sessionId);
  // Keep the header's model picker honest for switches this client did not
  // make itself (/model command, other tabs, direct API).
  useInvalidateSessionOnModelSwitch(sessionId);
  const [localTab, setLocalTab] = useState<SandboxTabId>("chat");
  const tab = activeTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const threads = useThreads(sessionId);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

  // No explicit ?thread → land on the MOST RECENT thread (matches the
  // sidebar's newest-first ordering), not the oldest.
  const newestThreadId = threads.data?.threads.reduce<{ id: string; createdAt: number } | undefined>(
    (best, t) => (best === undefined || t.createdAt > best.createdAt ? { id: t.id, createdAt: t.createdAt } : best),
    undefined,
  )?.id;
  const effectiveThreadId = activeThreadId ?? newestThreadId ?? undefined;

  // Load this thread's persisted messages from REST and pipe into the
  // stream store. Background refetches are disabled (see `useMessages`) so
  // this never wipes live state mid-session.
  const messagesQ = useMessages(sessionId, effectiveThreadId);
  // Viewer identity, for message attribution: the list renders another
  // member's user messages under their name instead of "You".
  const me = useMe();
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (!effectiveThreadId || !messagesQ.data) return;
    setThreadMessages(sessionId, effectiveThreadId, messagesQ.data.messages);
  }, [sessionId, effectiveThreadId, messagesQ.data, setThreadMessages]);

  usePendingGatesSeed(sessionId);

  const pendingGate = usePendingGateForThread(sessionId, effectiveThreadId);
  const threadError = useErrorForThread(sessionId, effectiveThreadId);

  // "Agent is busy" for the header badge and the transcript indicator, from
  // the same two signals the composer's Stop/Escape affordance uses: the
  // live `status` events plus the durable queue state (which the WS
  // handshake seeds, so it survives a mid-turn page load or reconnect).
  const threadQueueState = useQueueStateForThread(sessionId, effectiveThreadId);
  const threadStatus = useThreadLiveStatus(sessionId, effectiveThreadId);
  const agentBusy =
    (threadStatus.status !== "idle" && threadStatus.status !== "error") ||
    queueBusy(threadQueueState);

  // Auto-title: fire whenever we see an assistant reply on either an
  // un-titled session OR an un-titled active thread. The orchestrator's
  // own session ships with a fixed "Assistant" title, so a session-only
  // gate would never trigger there and no thread would ever get named —
  // hence the split gate. Server is idempotent (already_titled → no-op)
  // and may return `no_messages` if REST hasn't caught up with the live
  // stream, so we only latch on real writes. `inFlightRef` prevents
  // double-firing during a request; the key includes the threadId so
  // switching threads re-runs the effect for that thread's naming pass.
  const qc = useQueryClient();
  const autoTitleInFlightRef = useRef<Set<string>>(new Set());
  const sessionTitle = session.data?.title?.trim();
  const sessionUntitled = !sessionTitle || sessionTitle === "Untitled session";
  const activeThreadSummary = threads.data?.threads.find((t) => t.id === effectiveThreadId);
  const activeThreadTitle = activeThreadSummary?.title?.trim();
  const activeThreadUntitled = !activeThreadTitle;
  const assistantReplyCount = stream.messages.filter(
    (m) =>
      m.role === "assistant" &&
      (m.threadId === effectiveThreadId || !effectiveThreadId) &&
      (m.content || m.parts.length > 0),
  ).length;
  useEffect(() => {
    if (!session.data) return;
    if (assistantReplyCount === 0) return;
    if (!sessionUntitled && !activeThreadUntitled) return;
    const key = `${sessionId}::${effectiveThreadId ?? ""}`;
    if (autoTitleInFlightRef.current.has(key)) return;
    autoTitleInFlightRef.current.add(key);
    api
      .autoTitleSession(sessionId, effectiveThreadId)
      .then((result) => {
        if (result.sessionTitle) {
          qc.invalidateQueries({ queryKey: qk.session(sessionId) });
          qc.invalidateQueries({ queryKey: qk.sessions() });
        }
        if (result.threadTitle) {
          qc.invalidateQueries({ queryKey: qk.threads(sessionId) });
        }
      })
      .catch((err) => {
        console.warn("auto-title failed:", err);
      })
      .finally(() => {
        // Clear the in-flight flag either way — once the server actually
        // writes a title, the invalidation flips the corresponding
        // `*Untitled` gate to false and the effect stops re-running for
        // that (session, thread) pair.
        autoTitleInFlightRef.current.delete(key);
      });
  }, [
    session.data,
    sessionUntitled,
    activeThreadUntitled,
    assistantReplyCount,
    sessionId,
    effectiveThreadId,
    qc,
  ]);

  // Composer publishes its intake pipeline into this ref. The page-level
  // drop target reads it on drop — SessionView is the closest common
  // ancestor of Composer and the chat body, so it owns the handshake. Ref,
  // not state, so a republish (composer's `intakeBlocked` flip) doesn't
  // re-render the drop target and re-attach its `document` listeners.
  const dropIntakeRef = useRef<ComposerDropIntake | null>(null);
  const dropChannel = useMemo<ComposerDropChannel>(
    () => ({
      // The proxy intake reads through the ref on each call. Its identity
      // is stable across renders, so PageDropTarget's `useEffect` doesn't
      // re-attach listeners when the composer republishes.
      intake: {
        addFiles: (files) => dropIntakeRef.current?.addFiles(files),
        // Blocked-by-default: no composer published yet means no intake.
        get blocked() {
          return dropIntakeRef.current?.blocked ?? true;
        },
        get ownedEl() {
          return dropIntakeRef.current?.ownedEl ?? null;
        },
      },
      publish: (next) => {
        dropIntakeRef.current = next;
      },
    }),
    [],
  );

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
    <ComposerDropContext.Provider value={dropChannel}>
    <div className="flex-1 flex flex-col min-h-0">
      {panel ? (
        <PanelHeader sessionId={sessionId} title={session.data.title} onClose={onClose} />
      ) : (
        <SessionHeader
          session={session.data}
          agentStatus={threadStatus.status}
          turnStartedAt={threadStatus.turnStartedAt}
          conn={stream.conn}
          sandbox={stream.sandbox}
          threadId={effectiveThreadId}
          messages={stream.messages}
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
        <PageDropTarget>
          <MessageList
            messages={stream.messages}
            threadId={effectiveThreadId}
            onOpenChild={onOpenChild}
            agentBusy={agentBusy}
            pendingIds={threadQueueState?.pendingIds}
            viewerId={me.data?.id}
          />
          {threadError && (
            <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
              <span className="font-medium">{threadError.code}:</span> {threadError.message}
            </div>
          )}
          {/* Keyed by gate id: the question input's draft must not carry
              over when the pending gate changes (e.g. a thread switch to a
              different pending gate). */}
          {pendingGate && (
            <DecisionGateCard key={pendingGate.id} sessionId={sessionId} gate={pendingGate} />
          )}
          {/* No key: drafts are per-thread in the composer-drafts store, so
              a thread switch swaps the draft without a remount (a remount
              would orphan in-flight uploads). */}
          <Composer
            sessionId={sessionId}
            threadId={effectiveThreadId}
            agentStatus={threadStatus.status}
          />
        </PageDropTarget>
      ) : null}
    </div>
    </ComposerDropContext.Provider>
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
      {onClose && (
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      )}
    </header>
  );
}
