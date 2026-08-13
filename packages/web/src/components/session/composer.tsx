import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useAbortThread, useSendPrompt } from "~/api/queries";
import { useStreamStore, useQueueStateForThread, type AgentStatus } from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useCommands } from "~/hooks/use-commands";
import { CommandPopup } from "./command-popup";

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
  // Composer-prefill handoff (decision 17): memory doc's "Ask {name} to
  // update this" sets this store then navigates to `/chat`; the next
  // Composer to mount consumes it exactly once as its initial text. Reading
  // via `getState()` (not the hook) so this is a one-time seed, not a live
  // subscription — a later `set()` elsewhere shouldn't yank the draft out
  // from under whatever the user is typing.
  const [text, setText] = useState(() => useComposerPrefillStore.getState().consume() ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Slash-command autocomplete: derive the command query from the current text.
  // The popup opens only while the entire message matches /^\/(\S*)$/ — a lone
  // command token. Dispatch remains server-side; the composer sends text unchanged.
  const commandQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const { data: commandsData } = useCommands(sessionId);
  const allCommands = commandsData?.commands ?? [];
  const filteredCommands = commandQuery !== null
    ? allCommands.filter((c) => c.name.startsWith(commandQuery))
    : [];
  const popupOpen = commandQuery !== null && filteredCommands.length > 0;
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Reset selection when the filtered list changes.
  useEffect(() => { setSelectedIndex(0); }, [filteredCommands.length, commandQuery]);
  // Focus-on-request (New thread button): reactive on purpose, unlike the
  // prefill text — the Composer is usually already mounted when the
  // request fires, so a mount-time consume would miss it.
  const focusNonce = useComposerPrefillStore((s) => s.focusNonce);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);
  const send = useSendPrompt(sessionId);
  const abort = useAbortThread(sessionId);
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

  async function stop() {
    if (!threadId || abort.isPending) return;
    try {
      await abort.mutateAsync({ threadId });
    } catch (err) {
      console.error("abort failed:", err);
    }
  }

  function insertCommand(name: string) {
    setText(`/${name} `);
    setSelectedIndex(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // While the popup is open, intercept navigation keys. IME composition
    // guard applies here too — composition events must not trigger navigation.
    if (popupOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertCommand(filteredCommands[selectedIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Append a space so the text no longer matches the lone-token pattern,
        // which closes the popup while leaving the typed prefix in place.
        setText(text + " ");
        return;
      }
      if (e.key === "Enter") {
        // Confirm selection — do NOT send.
        if (e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        insertCommand(filteredCommands[selectedIndex].name);
        return;
      }
    }

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
      <div className="relative flex gap-2 items-end">
        {popupOpen && (
          <CommandPopup
            commands={filteredCommands}
            query={commandQuery ?? ""}
            selectedIndex={selectedIndex}
            onSelect={insertCommand}
            onClose={() => setText(text + " ")}
          />
        )}
        <Textarea
          ref={inputRef}
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
        {busy ? (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="text-danger-600 hover:text-danger-500 dark:text-danger-500"
            onClick={() => void stop()}
            disabled={!threadId || abort.isPending}
            aria-label="Stop"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            <span>Stop</span>
          </Button>
        ) : (
          <Button type="submit" disabled={!canSend} size="lg">
            <Send className="h-4 w-4" />
            <span>Send</span>
          </Button>
        )}
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
    <div className="mb-2 text-xs text-muted">{parts.join(" • ")}</div>
  );
}
