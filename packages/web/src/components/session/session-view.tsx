import { ListTree } from "lucide-react";
import { QuickReplies } from "./quick-replies";
import { useMobileLayout } from "~/hooks/use-mobile-layout";
import { ResolvedGateNotice, useResolvedGateNotice } from "./gate-outcome";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/popover";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X, ExternalLink } from "lucide-react";
import {
  useForkThread,
  useMessages,
  useSession,
  useThreads,
} from "~/api/queries";
import { useAnnounceThreadView, useSessionWebSocket } from "~/api/ws";
import {
  queueBusy,
  useSessionStream,
  useStreamStore,
  usePendingGateForThread,
  useQueueStateForThread,
  useThreadLiveStatus,
  useErrorForThread,
  useCompactingForThread,
  type StreamMessage,
} from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import { useThreadEdit } from "~/components/session/use-thread-edit";
import { errorText } from "~/lib/error-text";
import {
  ComposerDropContext,
  type ComposerDropChannel,
  type ComposerDropIntake,
} from "~/components/session/composer-drop-context";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { ThreadRecapDock, useThreadRecap } from "~/components/session/thread-recap";
import { PinnedPlan } from "~/components/session/thread-plan";
import { ProcessingStatus } from "./processing-status";
import { TypingLine } from "~/components/session/viewer-faces";
import { useActiveViewers } from "~/api/active-viewers";
import { PageDropTarget } from "~/components/session/page-drop-target";
import { SandboxTabs, type SandboxTabId } from "~/components/session/sandbox-tabs";
import { BrowserOverlay } from "~/components/session/browser/browser-overlay";
import { useBrowserWatch } from "~/components/session/browser/use-browser-watch";
import { ThreadContextPanel } from "~/components/session/thread-context-panel";
import { BackgroundWorkStatusLine } from "~/components/session/background-work";
import { useCanAdministerSession } from "~/components/session/use-can-administer-session";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { SessionHeader } from "~/components/session/session-header";
import { useMe } from "~/api/settings";
import { useInvalidateSessionOnModelSwitch } from "~/hooks/use-invalidate-session-on-model-switch";
import { useInvalidateMessagesOnCompaction } from "~/hooks/use-invalidate-messages-on-compaction";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { usePendingGatesSeed } from "~/hooks/use-pending-gates-seed";
import { Button, LoadingRow } from "~/components/primitives";
import type { MessageReplyReference } from "@valet/api/wire";
import { defaultThreadId, isAppAssistantThread } from "~/lib/thread-default";
import { flattenChildWork, useChildWork } from "~/api/child-work";
import { AgentsLine } from "./agents-line";
import { ThreadReplyContext } from "./send-as-person";
import { ChildTitlesContext } from "./work-group";
import { MobileConversationLayout, type MobileConversationView } from "~/components/home/mobile-conversation-layout";

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
  hidePanelHeader = false,
  renderPanelHeader,
  activeThreadId,
  onClose,
  onOpenChild,
  activeTab,
  onTabChange,
  enableReplies = false,
  onOpenThread,
  scopeNotice,
  chatOnly = false,
  active = true,
  composerAccessory,
  emptyState,
}: {
  /** Shown above the composer, under the thread's own pending gate. Home
   * uses it for approvals from work in other threads. */
  composerAccessory?: ReactNode;
  /** Shown in place of the transcript while the thread has no messages. */
  emptyState?: ReactNode;
  /** Hidden embedded views keep drafts/streams but suppress floating overlays. */
  active?: boolean;
  chatOnly?: boolean;
  scopeNotice?: string;
  sessionId: string;
  /** Renders the compact slide-over header instead of `SessionHeader`. */
  panel?: boolean;
  hidePanelHeader?: boolean;
  renderPanelHeader?: (summary: ReactNode) => ReactNode;
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
  /** Enable message-level replies on an orchestrator chat surface. */
  enableReplies?: boolean;
  /**
   * Opens another thread of this workspace. A host that can switch threads
   * passes it, and messages then offer "Branch into a new thread".
   */
  onOpenThread?: (threadId: string) => void;
}) {
  // The summary is a popover over the transcript, so it opens only on request.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const mobile = useMobileLayout();
  const mobileNavigation = mobile && !panel;
  const [mobileView, setMobileView] = useState<MobileConversationView>("chat");
  useEffect(() => setMobileView("chat"), [sessionId, activeThreadId, mobileNavigation]);
  const chatActive = active && (!mobileNavigation || mobileView === "chat");
  const session = useSession(sessionId);
  // Keep the header's model picker honest for switches this client did not
  // make itself (/model command, other tabs, direct API).
  useInvalidateSessionOnModelSwitch(sessionId);
  // Surface the compaction divider as soon as a compaction lands: the
  // engine persists the CompactionEntry before emitting `compaction_end`,
  // and this refetch is what pulls it into the transcript.
  useInvalidateMessagesOnCompaction(sessionId);
  // Signal turns (child.settled, process.exited, timer.fired, watch.event)
  // reach the client through REST only. A queue change is the cue to
  // refetch, in every view that renders a session, not only the assistant chat.
  useInvalidateMessagesOnQueueState(sessionId, activeThreadId);
  const [localTab, setLocalTab] = useState<SandboxTabId>("chat");
  const setTab = onTabChange ?? setLocalTab;
  const viewRef = useRef<HTMLDivElement>(null);
  const restoreTabFocus = useRef(false);
  function changeTab(next: SandboxTabId) {
    const active = document.activeElement;
    restoreTabFocus.current = next !== tab && active instanceof HTMLElement
      && (active.getAttribute("role") === "tab" || (mobileNavigation && next === "chat"))
      && Boolean(viewRef.current?.contains(active));
    if (tab === "browser" && next !== "browser") browserWatch.open();
    setTab(next);
  }
  const threads = useThreads(sessionId, undefined, activeThreadId);
  // Stopping background work is a lifecycle control, like pause.
  const canCancelWork = useCanAdministerSession(session.data?.owner);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

  // The shared default keeps an omitted ?thread aligned with the sidebar, regardless of its sort mode.
  const effectiveThreadId = activeThreadId ?? threads.data?.defaultThreadId ?? defaultThreadId(threads.data?.threads ?? []);
  const helperThread = threads.data?.threads.find((thread) => thread.id === effectiveThreadId);
  const hideBrowser = chatOnly || Boolean(helperThread && isAppAssistantThread(helperThread));
  const tab = hideBrowser ? "chat" : activeTab ?? localTab;
  useLayoutEffect(() => {
    if (!restoreTabFocus.current) return;
    restoreTabFocus.current = false;
    // The compact phone back button unmounts on Chat. Return focus to
    // its menu without opening the keyboard; desktop keeps the selected tab.
    const selector = mobileNavigation ? '[aria-label="Thread menu"]' : '[role="tab"][aria-selected="true"]';
    viewRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [tab, mobileNavigation]);
  const [replyTarget, setReplyTarget] = useState<MessageReplyReference>();
  useEffect(() => setReplyTarget(undefined), [effectiveThreadId]);
  // Fork (docs/specs/2026-10-22-thread-edit-fork-design.md).
  const [branchError, setBranchError] = useState<string>();
  useEffect(() => setBranchError(undefined), [effectiveThreadId]);
  const forkThread = useForkThread(sessionId);

  // Load this thread's persisted messages from REST and pipe into the
  // stream store. Background refetches are disabled (see `useMessages`) so
  // this never wipes live state mid-session.
  const messagesQ = useMessages(sessionId, effectiveThreadId);
  // Viewer identity, for message attribution: the list renders another
  // member's user messages under their name instead of "You".
  const me = useMe();
  // Who else has this thread open; this view reports it on the session socket.
  useAnnounceThreadView(sessionId, chatActive ? effectiveThreadId : undefined);
  const viewers = useActiveViewers(sessionId, effectiveThreadId, me.data?.id);
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (!effectiveThreadId || !messagesQ.data) return;
    setThreadMessages(
      sessionId,
      effectiveThreadId,
      messagesQ.data.messages,
      messagesQ.data.hasMore,
    );
  }, [sessionId, effectiveThreadId, messagesQ.data, setThreadMessages]);
  const edit = useThreadEdit(sessionId, effectiveThreadId, messagesQ, stream.messages, { readOnly: Boolean(session.data?.readOnlyReason) });

  async function branch(message: StreamMessage) {
    if (!effectiveThreadId || !onOpenThread || forkThread.isPending) return;
    setBranchError(undefined);
    try {
      const result = await forkThread.mutateAsync({ threadId: effectiveThreadId, entryId: message.id });
      if (result.draft) useComposerDraftStore.getState().setText(draftKey(result.thread.sessionId, result.thread.id), result.draft);
      onOpenThread(result.thread.id);
    } catch (err) {
      setBranchError(errorText(err, "Could not branch into a new thread. Try again."));
    }
  }

  usePendingGatesSeed(sessionId);

  const pendingGate = usePendingGateForThread(sessionId, effectiveThreadId);
  const resolvedGate = useResolvedGateNotice(pendingGate ?? undefined);
  // The agents this session started: their titles name them in work lines,
  // and the ones this thread is running show as one line under the transcript.
  const childWorkQuery = useChildWork(sessionId);
  const childWork = useMemo(() => flattenChildWork(childWorkQuery.data), [childWorkQuery.data]);
  const childTitles = useMemo(() => new Map(childWork.map(child => [child.sessionId, child.title])), [childWork]);
  // A widget's buttons reply into the thread on screen, as the person.
  const widgetReplyTarget = useMemo(() => effectiveThreadId && !session.data?.readOnlyReason
    ? { sessionId, threadId: effectiveThreadId } : null, [sessionId, effectiveThreadId, session.data?.readOnlyReason]);
  // Quick replies are a phone affordance: tap an answer instead of typing it.
  const threadError = useErrorForThread(sessionId, effectiveThreadId);
  const compacting = useCompactingForThread(sessionId, effectiveThreadId);

  // "Agent is busy" for the header badge and the transcript indicator, from
  // the same two signals the composer's Stop/Escape affordance uses: the
  // live `status` events plus the durable queue state (which the WS
  // handshake seeds, so it survives a mid-turn page load or reconnect).
  const threadQueueState = useQueueStateForThread(sessionId, effectiveThreadId);
  const queuedMessages = useMemo(() => {
    const byItemId = new Map(
      stream.messages
        .filter((message) => message.role === "user" && message.queueItemId)
        .map((message) => [message.queueItemId, message]),
    );
    return (threadQueueState?.pendingIds ?? [])
      .map((itemId) => byItemId.get(itemId))
      .filter((message) => message !== undefined);
  }, [stream.messages, threadQueueState?.pendingIds]);
  const threadStatus = useThreadLiveStatus(sessionId, effectiveThreadId);
  const agentBusy =
    (threadStatus.status !== "idle" && threadStatus.status !== "error") ||
    queueBusy(threadQueueState);
  const recap = useThreadRecap({ threadId: effectiveThreadId, thread: helperThread, messages: stream.messages, viewerId: me.data?.id, working: agentBusy });

  const browserWatch = useBrowserWatch({
    sessionId,
    threadId: effectiveThreadId,
    messages: stream.messages,
    agentBusy,
  });
  function closeBrowserPreview() {
    browserWatch.close();
    viewRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }
  function expandBrowserPreview() {
    restoreTabFocus.current = true;
    setTab("browser");
  }

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
      <div className="flex min-h-0 flex-1 flex-col">
        {panel && !hidePanelHeader && renderPanelHeader?.(null)}
        <div className="flex flex-1 items-center justify-center"><LoadingRow label="Loading conversation…" /></div>
      </div>
    );
  }
  if (session.error || !session.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {panel && !hidePanelHeader && renderPanelHeader?.(null)}
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-danger-500">
          Failed to load conversation
          <div className="text-xs text-muted">{session.error?.message}</div>
          <Button size="sm" variant="secondary" onClick={() => void session.refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  const summaryControl = effectiveThreadId ? (
    <Popover key={`${sessionId}:${effectiveThreadId}`} open={chatActive && summaryOpen} onOpenChange={setSummaryOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Toggle summary" title="Toggle summary" className="shrink-0 data-[state=open]:bg-ink-wash">
          <ListTree className="h-4 w-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Thread summary" align="end" sideOffset={12} onOpenAutoFocus={(event) => event.preventDefault()} className="w-80 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0 rounded-2xl">
                <ThreadContextPanel
                  key={`${sessionId}:${effectiveThreadId}`}
                  owner={{ ownerType: session.data.owner.type, ownerId: session.data.owner.id }}
                  sessionId={sessionId} threadId={effectiveThreadId} messages={stream.messages} busy={agentBusy}
                  canCancelWork={canCancelWork}
                  pullRequests={helperThread?.pullRequests}
                  onCreate={() => {
                    const key = draftKey(sessionId, effectiveThreadId);
                    const store = useComposerDraftStore.getState();
                    const text = store.byKey[key]?.text ?? "";
                    store.setText(key, text ? `${text}\nCreate a file or site: ` : "Create a file or site: ");
                    viewRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
                  }}
                  onAttach={() => viewRef.current?.querySelector<HTMLButtonElement>('[aria-label="Attach files"], [aria-label="Attach images"]')?.click()}
                  onReveal={(messageId) => {
                    const row = [...(viewRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find((el) => el.dataset.messageId === messageId);
                    row?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                />
      </PopoverContent>
    </Popover>
  ) : null;

  const sessionHeader = (
    <SessionHeader
      session={session.data}
      agentStatus={threadStatus.status}
      conn={stream.conn}
      sandbox={stream.sandbox}
      threadId={effectiveThreadId}
      messages={stream.messages}
      summaryControl={summaryControl}
      onOpenView={hideBrowser ? undefined : changeTab}
      viewers={viewers}
      scopeNotice={scopeNotice}
    />
  );
  const sandboxTabs = !hideBrowser && (
    <SandboxTabs
      sessionId={sessionId}
      profile={session.data.profile}
      activeTab={tab}
      onTabChange={changeTab}
      notice={scopeNotice}
      sandbox={stream.sandbox}
      viewsInMenu={!panel}
      compact={mobileNavigation}
    />
  );

  const content = (
    <ComposerDropContext.Provider value={dropChannel}>
    <div ref={viewRef} className="flex-1 flex flex-col min-h-0 min-w-0">
      {(panel || tab !== "chat" || mobileNavigation) && (
        <>
          {panel ? (!hidePanelHeader && (renderPanelHeader ? renderPanelHeader(summaryControl) : <div className="flex shrink-0 items-center border-b border-line pr-3"><PanelHeader sessionId={sessionId} threadId={effectiveThreadId} title={session.data.title} onClose={onClose} />{summaryControl}</div>)) : sessionHeader}
          {sandboxTabs}
        </>
      )}
      {tab === "chat" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageDropTarget>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <ThreadReplyContext.Provider value={widgetReplyTarget}>
            <ChildTitlesContext.Provider value={childTitles}>
            <MessageList
              footer={<AgentsLine children={childWork} threadId={effectiveThreadId} onOpenChild={onOpenChild} />}
              header={panel || mobileNavigation ? undefined : <>{sessionHeader}{sandboxTabs}</>}
              messages={stream.messages}
              threadId={effectiveThreadId}
              onOpenChild={onOpenChild}
              agentBusy={agentBusy}
              pendingIds={threadQueueState?.pendingIds}
              viewerId={me.data?.id}
              onReply={enableReplies ? (target) => { edit.cancelEdit(); setReplyTarget(target); } : undefined}
              {...edit.list}
              onEdit={edit.list.onEdit && ((message) => { setReplyTarget(undefined); setBranchError(undefined); edit.startEdit(message); })}
              onBranch={onOpenThread ? (message) => void branch(message) : undefined}
              onOpenThread={onOpenThread}
              newSince={recap?.divider ? { anchorId: recap.anchorId, label: recap.divider } : undefined}
              emptyState={emptyState}
            />
            </ChildTitlesContext.Provider>
            </ThreadReplyContext.Provider>
            {chatActive && !hideBrowser && (browserWatch.mode === "open" || browserWatch.mode === "minimized") && (
              <BrowserOverlay
                key={JSON.stringify([sessionId, effectiveThreadId])}
                sessionId={sessionId}
                threadId={effectiveThreadId}
                working={browserWatch.working}
                minimized={browserWatch.mode === "minimized"}
                onMinimize={browserWatch.minimize}
                onRestore={browserWatch.open}
                onClose={closeBrowserPreview}
                onExpand={expandBrowserPreview}
              />
            )}
          </div>
          {compacting && (
            <div className="border-t border-[--border] px-4 py-1.5 text-[11px] text-muted">
              Compacting context…
            </div>
          )}
          {branchError && (
            <div role="alert" className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
              {branchError}
            </div>
          )}
          {threadError && (
            <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
              <span className="font-medium">{threadError.code}:</span> {threadError.message}
            </div>
          )}
          {/* Keyed by gate id: the question input's draft must not carry
              over when the pending gate changes (e.g. a thread switch to a
              different pending gate). */}
          <ThreadRecapDock recap={recap} collapsed={Boolean(pendingGate)} />
          <PinnedPlan threadId={effectiveThreadId} />
          {pendingGate && (
            <DecisionGateCard key={pendingGate.id} sessionId={sessionId} gate={pendingGate} />
          )}
          {!pendingGate && resolvedGate && <ResolvedGateNotice label={resolvedGate.label} title={resolvedGate.gate.title} />}
          {mobile && <QuickReplies sessionId={sessionId} threadId={effectiveThreadId} messages={stream.messages.filter(m => m.threadId === effectiveThreadId)}
            disabled={Boolean(pendingGate) || threadStatus.status !== "idle" || Boolean(session.data?.readOnlyReason)} />}
          {composerAccessory}
          <TypingLine viewers={viewers} />
          <ProcessingStatus status={threadStatus.status} queue={threadQueueState} needsResponse={Boolean(pendingGate)} />
          {/* No key: drafts are per-thread in the composer-drafts store, so
              a thread switch swaps the draft without a remount (a remount
              would orphan in-flight uploads). */}
          {session.data?.readOnlyReason ? <p className="border-t border-border px-4 py-3 text-sm text-muted" role="status">{session.data.readOnlyReason}</p> : <Composer
            active={chatActive}
            sessionId={sessionId}
            threadId={effectiveThreadId}
            agentStatus={threadStatus.status}
            queuedMessages={queuedMessages}
            queuedItemCount={threadQueueState?.pendingIds.length ?? 0}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(undefined)}
            {...edit.composer}
            statusLine={
              <BackgroundWorkStatusLine
                sessionId={sessionId}
                threadId={effectiveThreadId}
                canCancel={canCancelWork}
                className="mt-1.5 self-start"
              />
            }
          />}
        </PageDropTarget>
        </div>

        </div>
      ) : null}
    </div>
    </ComposerDropContext.Provider>
  );
  return mobileNavigation
    ? <MobileConversationLayout view={mobileView} onViewChange={setMobileView}>{content}</MobileConversationLayout>
    : content;
}

function PanelHeader({
  sessionId,
  threadId,
  title,
  onClose,
}: {
  sessionId: string;
  threadId?: string;
  title?: string;
  onClose?: () => void;
}) {
  return (
    <header className="min-w-0 flex-1 px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold tracking-tight truncate text-ink">
          {title || "Untitled thread"}
        </div>
      </div>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId }}
        search={{ thread: threadId }}
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
