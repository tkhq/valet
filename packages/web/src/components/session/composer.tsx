import { useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useSendPrompt } from "~/api/queries";
import { useStreamStore, useQueueStateForThread, type AgentStatus } from "~/stores/stream";

export function Composer({
  sessionId,
  threadId,
  agentStatus,
}: {
  sessionId: string;
  /**
   * Active thread id. Required for sending — when undefined (threads still
   * loading), the composer is disabled. Without this, optimistic user
   * messages would have no thread tag and bleed into other threads' views
   * after a thread switch.
   */
  threadId?: string;
  agentStatus: AgentStatus;
}) {
  const [text, setText] = useState("");
  const send = useSendPrompt(sessionId);
  const addUserMessage = useStreamStore((s) => s.addUserMessage);
  const setMessageQueueItemId = useStreamStore((s) => s.setMessageQueueItemId);
  const queueState = useQueueStateForThread(sessionId, threadId);

  // Disable submit while engine is mid-turn or while we don't yet know the
  // active thread id. Prompts queue server-side, but the UX is clearer if
  // we wait for idle, and we MUST know the thread id to correctly tag the
  // optimistic message.
  const busy = send.isPending || (agentStatus !== "idle" && agentStatus !== "error");
  const canSend = !busy && !!threadId && text.trim().length > 0;

  async function submit() {
    const t = text.trim();
    if (!t || busy || !threadId) return;
    setText("");
    // Optimistic local add — the engine doesn't emit a wire event for the
    // user's own message, so without this the prompt would only appear after
    // the next WS init (page reload). The next init replaces this row with
    // the server's persisted copy.
    const localId = addUserMessage(sessionId, t, threadId);
    try {
      const res = await send.mutateAsync({ text: t, threadId });
      // `messageId` on the response is the engine's queue item id (see
      // POST /:id/messages). Stamping it closes the linkage so
      // `submission.settled` can match this exact message instead of
      // falling back to a recency heuristic.
      setMessageQueueItemId(sessionId, localId, res.messageId);
    } catch (err) {
      // Restore the draft on failure so the user can retry. The optimistic
      // message stays visible — they can see what they sent + retry; on the
      // next reload it'll be reconciled against server truth.
      setText(t);
      console.error("send failed:", err);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter inserts a newline. Skip while an IME
    // composition is active so Enter confirms the composition instead of
    // sending a half-finished message.
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="border-t border-[--border] p-3 bg-[--bg]"
    >
      <QueueIndicator queueState={queueState} />
      <div className="flex gap-2 items-end">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            threadId
              ? "Send a message — Enter to send, Shift+Enter for a new line"
              : "Loading thread…"
          }
          rows={2}
          className="flex-1"
          disabled={send.isPending || !threadId}
        />
        <Button type="submit" disabled={!canSend} size="lg">
          <Send className="h-4 w-4" />
          <span>Send</span>
        </Button>
      </div>
    </form>
  );
}

/**
 * Small text indicator above the composer for the thread's submission
 * queue. `blocked_on_decision_gate` is intentionally NOT surfaced here —
 * the `DecisionGateCard` already renders "agent paused" for that state, and
 * showing it twice would be redundant.
 */
function QueueIndicator({
  queueState,
}: {
  queueState: ReturnType<typeof useQueueStateForThread>;
}) {
  if (!queueState) return null;
  const parts: string[] = [];
  if (queueState.pendingIds.length > 0) {
    parts.push(`${queueState.pendingIds.length} queued`);
  }
  if (queueState.status === "paused") {
    parts.push("paused");
  }
  if (parts.length === 0) return null;
  return (
    <div className="mb-2 text-xs text-[--muted]">{parts.join(" • ")}</div>
  );
}
