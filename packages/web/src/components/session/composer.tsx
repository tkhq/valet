import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useAbortThread, useSendPrompt } from "~/api/queries";
import { useStreamStore, useQueueStateForThread, type AgentStatus } from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useCommands } from "~/hooks/use-commands";
import { CommandPopup, commandsToItems, type PopupItem } from "./command-popup";

/**
 * What the submit button does with the text in the composer.
 *
 * `steer` and `queue` are not interchangeable, and the difference is not the
 * client's to guess: the engine gives a user's own orchestrator the `steer`
 * queue mode and every other principal — a team orchestrator included — the
 * `followup` mode (`packages/api/src/engine/host.ts`). A "Steer" label on a
 * followup queue promises an interrupt that does not happen, so the label
 * comes from the live `queue.state` frame or falls back to `queue`.
 */
type SubmitAction = "send" | "steer" | "queue";

const ACTION_LABEL: Record<SubmitAction, string> = {
  send: "Send",
  steer: "Steer",
  queue: "Queue",
};

/**
 * One line of copy that tells the user what happens to the message. Shown
 * only while the agent works — while it is idle, "Send" needs no gloss.
 *
 * The steer wording is literal. A steer admission supersedes the running
 * submission and aborts the live agent run, then the claim loop starts the
 * new message (`Thread.handleSteerSupersession`). It does not append to the
 * turn that is already in flight.
 */
const ACTION_HINT: Record<SubmitAction, string> = {
  send: "",
  steer: "Steer stops the current turn. The agent starts your message immediately.",
  queue: "The agent completes the current turn. Then it reads your message.",
};

const ACTION_PLACEHOLDER: Record<SubmitAction, string> = {
  send: "Send a message — Enter to send, Shift+Enter for a new line",
  steer: "Steer the current turn — Enter to steer, Shift+Enter for a new line",
  queue: "Queue a message for after this turn — Enter to queue, Shift+Enter for a new line",
};

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

  // Slash-command autocomplete: two popup modes derived from the text.
  // COMMAND mode while the message is a lone "/token"; ARGUMENT mode while it
  // is "/command <partial-first-arg>" and the command enumerates completions
  // (e.g. /model's model ids). Dispatch remains server-side; the composer
  // sends text unchanged.
  const commandQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const argMatch = /^\/(\S+) (\S*)$/.exec(text);
  const { data: commandsData } = useCommands(sessionId);
  const allCommands = commandsData?.commands ?? [];
  const filteredCommands = commandQuery !== null
    ? allCommands.filter((c) => c.name.startsWith(commandQuery))
    : [];
  const argCommand = argMatch ? allCommands.find((c) => c.name === argMatch[1]) : undefined;
  const argPrefix = argMatch?.[2] ?? "";
  const argOptions = argCommand?.argOptions ?? [];
  const argPrefixLower = argPrefix.toLowerCase();
  const filteredArgs = argCommand
    ? argOptions.filter((o) => {
        if (argPrefixLower === "") return true;
        // Match the full value, the value after a provider prefix
        // ("anthropic/claude-…" ⇒ "claude-…"), or the display label —
        // users type "claude-o" or "opus", not "anthropic/claude-o".
        const v = o.value.toLowerCase();
        const tail = v.slice(v.indexOf("/") + 1);
        return (
          v.startsWith(argPrefixLower) ||
          tail.startsWith(argPrefixLower) ||
          (o.label?.toLowerCase().includes(argPrefixLower) ?? false)
        );
      })
    : [];
  const popupItems: PopupItem[] =
    commandQuery !== null
      ? commandsToItems(filteredCommands)
      : filteredArgs.map((o) => ({
          id: o.value,
          label: o.value,
          detail: o.label,
          group: "Arguments",
        }));
  // A command whose first argument is free text (argHint, no options) gets a
  // passive hint row while the argument is still empty — discoverability
  // without pretending we can complete it.
  const argNotice =
    argCommand && argOptions.length === 0 && argPrefix === "" && argCommand.argHint
      ? argCommand.argHint
      : undefined;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const popupOpen = !dismissed && popupItems.length > 0;
  const noticeOpen = !dismissed && !popupOpen && argNotice !== undefined;
  // Reset selection and dismissed flag when the query changes (user typed new chars).
  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [popupItems.length, commandQuery, argPrefix]);
  // Focus-on-request (New thread button): reactive on purpose, unlike the
  // prefill text — the Composer is usually already mounted when the
  // request fires, so a mount-time consume would miss it.
  const focusNonce = useComposerPrefillStore((s) => s.focusNonce);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);
  const send = useSendPrompt(sessionId);
  const abort = useAbortThread(sessionId);
  // The textarea disables while a send is in flight, which drops focus to
  // <body>. Refocus when the send settles so the user can type the next
  // message or command immediately (covers Enter sends and Send clicks).
  const sendWasPending = useRef(false);
  useEffect(() => {
    if (sendWasPending.current && !send.isPending) inputRef.current?.focus();
    sendWasPending.current = send.isPending;
  }, [send.isPending]);
  const addUserMessage = useStreamStore((s) => s.addUserMessage);
  const setMessageQueueItemId = useStreamStore((s) => s.setMessageQueueItemId);
  const queueState = useQueueStateForThread(sessionId, threadId);

  // A mid-turn message is allowed — the engine admits it either way. Only
  // an in-flight POST or an unknown thread id blocks submit, and the thread
  // id is mandatory because the optimistic message carries it.
  const working = agentStatus !== "idle" && agentStatus !== "error";
  // `collect` also lands on `queue`: a collect-mode message waits for its
  // window to close, so "after the current turn" stays true for it.
  const action: SubmitAction = !working
    ? "send"
    : queueState?.mode === "steer"
      ? "steer"
      : "queue";
  const canSend = !send.isPending && !!threadId && text.trim().length > 0;

  async function submit() {
    const t = text.trim();
    if (!t || send.isPending || !threadId) return;
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
      // falling back to a recency heuristic. Null for slash commands —
      // they never queue, so there is nothing to link.
      if (res.messageId) setMessageQueueItemId(sessionId, localId, res.messageId);
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

  // Escape interrupts the running turn — parity with the Stop button —
  // from anywhere on the chat tab, not just the textarea. Window-level
  // because focus often sits outside the textarea mid-turn (it disables
  // while a send is in flight). Layered dismissals keep priority: any
  // handler that claims Escape first (the command popup above, the child
  // panel's close) calls preventDefault, and a claimed event is skipped.
  const abortMutate = abort.mutate;
  const abortPending = abort.isPending;
  useEffect(() => {
    function onEscape(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (!working || !threadId || abortPending) return;
      e.preventDefault();
      abortMutate(
        { threadId },
        { onError: (err) => console.error("abort failed:", err) },
      );
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [working, threadId, abortPending, abortMutate]);

  function insertSelection(id: string) {
    if (commandQuery !== null) {
      setText(`/${id} `);
    } else if (argCommand) {
      setText(`/${argCommand.name} ${id} `);
    }
    setSelectedIndex(0);
    // Mouse selection would otherwise leave focus off the textarea.
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // While the popup is open, intercept navigation keys. IME composition
    // guard applies here too — composition events must not trigger navigation.
    if (popupOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, popupItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertSelection(popupItems[selectedIndex].id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Mark dismissed — the popup closes without modifying the text.
        // dismissed resets automatically when commandQuery changes (user types).
        setDismissed(true);
        return;
      }
      if (e.key === "Enter") {
        // Confirm selection — do NOT send.
        if (e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        insertSelection(popupItems[selectedIndex].id);
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
      {working && <p className="mb-2 text-xs text-muted">{ACTION_HINT[action]}</p>}
      {/* `relative` anchors the command popup to the input row, so the hint
          above it never moves the popup. */}
      <div className="relative flex gap-2 items-end">
        {(popupOpen || noticeOpen) && (
          <CommandPopup
            items={popupOpen ? popupItems : []}
            notice={argNotice}
            ariaLabel={
              commandQuery !== null
                ? `Slash command suggestions for /${commandQuery}`
                : `Argument suggestions for /${argCommand?.name ?? ""}`
            }
            selectedIndex={selectedIndex}
            onSelect={insertSelection}
            onHover={setSelectedIndex}
          />
        )}
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={threadId ? ACTION_PLACEHOLDER[action] : "Loading thread…"}
          rows={2}
          className="flex-1"
          disabled={send.isPending || !threadId}
        />
        {working && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="text-danger-600 hover:text-danger-500 dark:text-danger-500"
            onClick={() => void stop()}
            disabled={!threadId || abort.isPending}
            aria-label="Stop"
            title="Stop (Esc)"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            <span>Stop</span>
          </Button>
        )}
        <Button
          type="submit"
          disabled={!canSend}
          size="lg"
          title={working ? ACTION_HINT[action] : undefined}
        >
          <Send className="h-4 w-4" />
          <span>{ACTION_LABEL[action]}</span>
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
    <div className="mb-2 text-xs text-muted">{parts.join(" • ")}</div>
  );
}
