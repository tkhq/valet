import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/cn";
import { useScrollHeader } from "~/hooks/use-scroll-header";
import { ArrowDown } from "lucide-react";
import type { StreamMessage } from "~/stores/stream";
import type { MessageReplyReference } from "@valet/api/wire";
import { MessageItem } from "./message-item";
import { SignalCard, WatchEventsCard, groupWatchEvents, type TranscriptItem } from "./signal-card";
import { endsWithToolResult } from "./transcript-cards";
import { isContinuation, planTranscript } from "./transcript-plan";
import { CommandResult } from "./command-result";
import { CompactionDivider } from "./compaction-divider";
import { BranchNoteDivider } from "./branch-note-divider";
import { NewSinceDivider } from "./thread-recap";

/**
 * Scrolling message list. Auto-scrolls to bottom when new messages arrive
 * unless the user has scrolled up — in which case we leave them alone so
 * they can read history.
 *
 * `threadId` strictly scopes the visible messages to a single thread:
 * a message shows up iff its `threadId` field equals the active id.
 * When `threadId` is undefined (threads query still loading), nothing is
 * filtered — but the Composer is also disabled in that state so no new
 * messages can be added with a missing thread tag.
 *
 * Earlier versions accepted `m.threadId === null` as a fallback for
 * optimistic user messages with no thread tag. That caused user messages
 * sent in one thread to appear in every other thread's view after a
 * switch. The Composer now requires `threadId` before submitting, so
 * optimistic messages always carry the right tag and we can filter
 * strictly here.
 */
export function MessageList({
  messages,
  threadId,
  onOpenChild,
  agentBusy = false,
  pendingIds,
  viewerId,
  header,
  onReply,
  onEdit,
  onBranch,
  onReturnToBranch,
  onOpenThread,
  editingId,
  hiddenIds,
  ratings = true,
  newSince,
  emptyState,
  footer,
}: {
  /** Shown after the last message, such as the agents this thread is running. */
  footer?: ReactNode;
  /** Shown in place of the default line when the thread has no messages. */
  emptyState?: ReactNode;
  messages: StreamMessage[];
  threadId?: string;
  /**
   * Forwarded to `SignalCard` for `child.settled` cards — opens the child
   * in the slide-over. Falls back to a full-page link when omitted.
   */
  onOpenChild?: (childSessionId: string) => void;
  /**
   * True while the agent is actively working. Suppresses the "(no
   * response)" placeholder on the LAST assistant message — a mid-stream
   * message is legitimately empty between `message_start` and its first
   * token, and must not flash as a failure.
   */
  agentBusy?: boolean;
  /** Engine queue item ids still waiting. These messages render above the composer. */
  pendingIds?: string[];
  /**
   * The signed-in user's id. A user message from someone else (a teammate
   * on a shared session) renders under the sender's name; the viewer's own
   * messages keep "You". Undefined while `/me` loads — senders then show
   * by name, which is accurate, just not "You"-ified.
   */
  viewerId?: string;
  /** Full-page chat controls share the transcript sticky layer. */
  header?: ReactNode;
  onReply?: (target: MessageReplyReference) => void;
  /** Edits one of the viewer's own messages. The list offers it only where the edit is allowed. */
  onEdit?: (message: StreamMessage) => void;
  /** Branches a message into a new thread. */
  onBranch?: (message: StreamMessage) => void;
  /** Goes back to the version a branch note left. */
  onReturnToBranch?: (noteEntryId: string, opts: { restoreFiles: boolean }) => Promise<void>;
  /** Opens another thread, for a fork note's source thread. */
  onOpenThread?: (threadId: string) => void;
  /** The message being edited: it and every row after it are dimmed. */
  editingId?: string;
  /** Rows a sent edit replaces, hidden until the server moves the thread. */
  hiddenIds?: ReadonlySet<string>;
  /**
   * Shows the per-reply rating buttons. A shared-thread guest passes false:
   * ratings are session-addressed, so they belong to the session's viewers.
   */
  ratings?: boolean;
  /** The "new" line before the first message other people added since the reader's last visit. */
  newSince?: { anchorId: string; label: string };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollHeader = useScrollHeader(containerRef, threadId);
  // The ref above drives the auto-scroll effect and must stay a ref: the
  // effect reads it in the same tick a message lands. This mirror exists
  // only so the button can render, and it flips at the same threshold.
  const [scrolledAway, setScrolledAway] = useState(false);

  const visible = useMemo(() => {
    const pending = new Set(pendingIds ?? []);
    return messages.filter(
      (message) =>
        (!threadId || message.threadId === threadId) &&
        (!message.queueItemId || !pending.has(message.queueItemId)) &&
        !hiddenIds?.has(message.id),
    );
  }, [messages, pendingIds, threadId, hiddenIds]);
  const editable = useMemo(() => editableMessageIds(visible, viewerId), [visible, viewerId]);
  const dimFrom = editingId ? visible.findIndex((message) => message.id === editingId) : -1;

  // Each turn's tool calls fold into as few work lines as its text allows.
  const transcript = useMemo(() => {
    const items = groupBranchNotes(groupWatchEvents(visible));
    return { items, plans: planTranscript(items, agentBusy) };
  }, [visible, agentBusy]);

  // A thread switch starts at the bottom: the previous thread's scroll
  // position must not decide whether the new thread auto-scrolls or shows
  // the "Latest" button. Reset only — `visible` recomputes on the same
  // threadId change, so the effect below (declared after this one, runs
  // after it) does the single scroll write.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }, [threadId]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      scrollHeader.syncPosition();
    }
  }, [visible, scrollHeader.syncPosition]);

  // A reader at the bottom stays at the bottom when the list gets shorter (a
  // card opens above the composer) or its content grows without a new
  // message (a running tool card expands, an image loads). Otherwise the next
  // scroll event reads the gap as the reader scrolling away.
  const hasContent = visible.length > 0;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
      scrollHeader.syncPosition();
    });
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [hasContent, scrollHeader.syncPosition]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    scrollHeader.onScroll();
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const nearBottom = distanceFromBottom < 80; // "near bottom"
    stickToBottomRef.current = nearBottom;
    // Return `prev` unchanged when the side did not flip. Scroll fires on
    // every wheel tick, and React skips the re-render on an equal value.
    setScrolledAway((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrollHeader.syncPosition();
    // Set both here rather than waiting for the scroll event. A programmatic
    // scroll to an already-bottom list fires no event, which would leave the
    // button on screen with nothing left to do.
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }


  return (
    <div className="flex-1 relative min-h-0 min-w-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        onWheelCapture={(event) => scrollHeader.recordIntent(event.target)}
        onTouchMove={(event) => scrollHeader.recordIntent(event.target)}
        onPointerDown={(event) => scrollHeader.recordIntent(event.target)}
        onPointerMove={(event) => { if (event.buttons) scrollHeader.recordIntent(event.target); }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            scrollHeader.recordIntent(event.target);
          }
        }}
        tabIndex={0}
        aria-label="Conversation"
        data-testid="message-list"
        className="flex h-full w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        {header && (
          <div
            ref={scrollHeader.headerRef}
            data-testid="thread-header"
            data-hidden={scrollHeader.hidden}
            onFocusCapture={scrollHeader.onFocus}
            onBlurCapture={scrollHeader.onBlur}
            className={cn(
              "sticky top-0 z-20 shrink-0 bg-paper transition-transform duration-200 ease-out motion-reduce:transition-none sm:transform-none",
              scrollHeader.hidden ? "-translate-y-full" : "translate-y-0",
            )}
          >
            {header}
          </div>
        )}
        {visible.length === 0 ? (
          emptyState ?? <div className="flex-1 grid place-items-center text-sm text-muted">
            No messages yet — try sending a prompt below.
          </div>
        ) : (
          <div ref={contentRef} className="shrink-0 space-y-2 py-4">
            {transcript.items.map((item, i, items) => {
              const plan = transcript.plans[i]!;
              if (item.kind === "watch") {
                return <WatchEventsCard key={item.events[0]?.id ?? i} events={item.events} />;
              }
              if (item.kind === "branch") {
                return <BranchNoteDivider key={item.notes[0]!.id} notes={item.notes} onReturn={onReturnToBranch} onOpenThread={onOpenThread} />;
              }
              const m = item.message;
              // Every part of this message shows in the work line above it.
              if (plan.hidden) return newSince?.anchorId === m.id ? <NewSinceDivider key={m.id} label={newSince.label} /> : null;
              const row = m.compaction ? (
                <CompactionDivider key={m.id} message={m} />
              ) : m.signal ? (
                <SignalCard key={m.id} message={m} onOpenChild={onOpenChild} />
              ) : m.command ? (
                <CommandResult key={m.id} message={m} />
              ) : (
                <MessageItem
                  key={m.id}
                  message={m}
                  continuation={isContinuation(m, previousMessage(items[i - 1]))}
                  suppressEmptyPlaceholder={(agentBusy && i === items.length - 1) || (endsWithToolResult(previousMessage(items[i - 1])) && !m.errorMessage)}
                  absorbedLeading={plan.absorbedLeading}
                  extraWork={plan.extraWork.length ? plan.extraWork : undefined}
                  extraWorkLive={plan.extraWorkLive}
                  workedForMs={plan.workedForMs}
                  viewerId={viewerId}
                  onReply={onReply}
                  onEdit={onEdit && editable.has(m.id) ? onEdit : undefined}
                  onBranch={onBranch && branchable(m) ? onBranch : undefined}
                  dimmed={dimFrom >= 0 && visible.indexOf(m) >= dimFrom}
                  ratings={ratings}
                />
              );
              return newSince && m.id === newSince.anchorId
                ? <Fragment key={m.id}><NewSinceDivider label={newSince.label} />{row}</Fragment>
                : row;
            })}
            {footer}
          </div>
        )}
      </div>
      {/* Only while the reader is away from the bottom. At the bottom the
          list already follows the agent, so the control has no job. */}
      {visible.length > 0 && scrolledAway && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Jump to latest message"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-line bg-paper max-sm:min-h-11 px-3 py-1 text-xs text-muted shadow-sm transition-colors hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40"
        >
          <ArrowDown className="h-3 w-3" aria-hidden />
          Latest
        </button>
      )}
    </div>
  );
}

/**
 * The viewer's own typed messages that an edit may replace
 * (docs/specs/2026-10-22-thread-edit-fork-design.md): persisted, not from a
 * channel such as Slack, and with no message from another person after it.
 * The server checks the same rules. Exported for tests.
 */
export function editableMessageIds(messages: readonly StreamMessage[], viewerId: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!viewerId) return ids;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (message.author && message.author.id !== viewerId) break;
    if (message.signal || message.command || !message.author || message.author.externalSender) continue;
    if (message.persistence === undefined && !message.channelType) ids.add(message.id);
  }
  return ids;
}

/** A persisted typed message or finished reply: a point a new thread can branch from. */
function branchable(message: StreamMessage): boolean {
  if (message.persistence !== undefined || message.signal || message.command) return false;
  return message.role === "user" || (message.role === "assistant" && message.completed === true);
}

type ListRow = TranscriptItem | { kind: "branch"; notes: StreamMessage[] };

/**
 * One row per branch note, except that consecutive edit and return notes,
 * as repeated edits of one message leave, share a row. A fork note stays
 * on its own. Exported for tests.
 */
export function groupBranchNotes(items: readonly TranscriptItem[]): ListRow[] {
  const out: ListRow[] = [];
  for (const item of items) {
    const branch = item.kind === "message" ? item.message.branch : undefined;
    if (item.kind !== "message" || !branch) {
      out.push(item);
      continue;
    }
    const last = out[out.length - 1];
    if (branch.kind !== "fork" && last?.kind === "branch" && last.notes[0]?.branch?.kind !== "fork") {
      last.notes.push(item.message);
    } else {
      out.push({ kind: "branch", notes: [item.message] });
    }
  }
  return out;
}

/** The message of the transcript row before this one, if that row is a
 * message. A grouped watch card or a branch note is not a message, so it
 * ends a turn. */
function previousMessage(item: ListRow | undefined): StreamMessage | undefined {
  return item?.kind === "message" ? item.message : undefined;
}

