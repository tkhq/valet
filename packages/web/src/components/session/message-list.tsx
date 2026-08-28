import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { StreamMessage } from "~/stores/stream";
import { MessageItem } from "./message-item";
import { SignalCard } from "./signal-card";
import { CommandResult } from "./command-result";

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
}: {
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
  /** Engine queue item ids still waiting. Marks those user bubbles Queued. */
  pendingIds?: string[];
  /**
   * The signed-in user's id. A user message from someone else (a teammate
   * on a shared session) renders under the sender's name; the viewer's own
   * messages keep "You". Undefined while `/me` loads — senders then show
   * by name, which is accurate, just not "You"-ified.
   */
  viewerId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // The ref above drives the auto-scroll effect and must stay a ref: the
  // effect reads it in the same tick a message lands. This mirror exists
  // only so the button can render, and it flips at the same threshold.
  const [scrolledAway, setScrolledAway] = useState(false);

  const visible = useMemo(() => {
    if (!threadId) return messages;
    return messages.filter((m) => m.threadId === threadId);
  }, [messages, threadId]);

  // A thread switch starts at the bottom: the previous thread's scroll
  // position must not decide whether the new thread auto-scrolls or shows
  // the "Latest" button. Reset only — `visible` recomputes on the same
  // threadId change, so the effect below (declared after this one, runs
  // after it) does the single scroll write.
  useEffect(() => {
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }, [threadId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
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
    // Set both here rather than waiting for the scroll event. A programmatic
    // scroll to an already-bottom list fires no event, which would leave the
    // button on screen with nothing left to do.
    stickToBottomRef.current = true;
    setScrolledAway(false);
  }

  if (visible.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        No messages yet — try sending a prompt below.
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto divide-y divide-[--border]"
      >
        {visible.map((m, i) =>
          m.signal ? (
            <SignalCard key={m.id} message={m} onOpenChild={onOpenChild} />
          ) : m.command ? (
            <CommandResult key={m.id} message={m} />
          ) : (
            <MessageItem
              key={m.id}
              message={m}
              suppressEmptyPlaceholder={agentBusy && i === visible.length - 1}
              queued={!!m.queueItemId && (pendingIds?.includes(m.queueItemId) ?? false)}
              viewerId={viewerId}
            />
          ),
        )}
      </div>
      {/* Only while the reader is away from the bottom. At the bottom the
          list already follows the agent, so the control has no job. */}
      {scrolledAway && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Jump to latest message"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-line bg-paper/90 px-3 py-1 text-xs text-muted shadow-sm backdrop-blur transition-colors hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
        >
          <ArrowDown className="h-3 w-3" aria-hidden />
          Latest
        </button>
      )}
    </div>
  );
}
