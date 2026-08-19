import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ImagePlus, Send, Square } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useAbortThread, useSendPrompt } from "~/api/queries";
import { queueBusy, useStreamStore, useQueueStateForThread, type AgentStatus } from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useCommands } from "~/hooks/use-commands";
import { cn } from "~/lib/cn";
import {
  readCommandRecency,
  recordCommandUse,
  type CommandRecency,
} from "~/lib/command-recency";
import { CommandPopup, commandsToItems, type PopupItem } from "./command-popup";
import { ComposerImageErrors, ComposerImageStrip } from "./composer-image-strip";
import { useComposerDrop } from "./composer-drop-context";
import {
  acceptImages,
  filesFromClipboard,
  filesFromList,
  readFailure,
  readImage,
  toPromptAttachments,
  transferHasFiles,
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_ATTACHMENTS_ENABLED,
  MAX_IMAGES,
  type ComposerImage,
} from "./composer-images";

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

  // Images held for the next message. Paste, drop, and the picker all land
  // here; `imageErrors` holds one line for each file the intake refused.
  const [images, setImages] = useState<ComposerImage[]>([]);
  // Ref mirror of `images` for `addFiles`. The intake callback is
  // memoized on `intakeBlocked` so its identity stays stable for the drop
  // context; reading through a ref keeps `acceptImages` seeing the latest
  // list without churning the callback identity on every image change.
  const imagesRef = useRef<ComposerImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  const [imageErrors, setImageErrors] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Form element ref for the page-level drop target — used to skip
  // double-intake when a drop already landed on the composer's form
  // (which has its own `onDrop` handler).
  const formRef = useRef<HTMLFormElement>(null);
  // Drag events fire for every child element the pointer crosses, so a
  // single `dragleave` does not mean the pointer left the composer. Count
  // enter and leave, and clear the highlight only at zero.
  const dragDepth = useRef(0);

  // Slash-command autocomplete: two popup modes derived from the text.
  // COMMAND mode while the message is a lone "/token"; ARGUMENT mode while it
  // is "/command <partial-first-arg>" and the command enumerates completions
  // (e.g. /model's model ids). Dispatch remains server-side; the composer
  // sends text unchanged.
  const commandQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const argMatch = /^\/(\S+) (\S*)$/.exec(text);
  const { data: commandsData } = useCommands(sessionId);
  const allCommands = commandsData?.commands ?? [];
  // Per-browser last-used ranking for the command popup. Loaded once per
  // mount; `submit` records each sent slash command and refreshes it.
  const [commandRecency, setCommandRecency] = useState<CommandRecency>(() => readCommandRecency());
  // COMMAND mode hands the raw registry and the typed token to
  // `commandsToItems`, the single owner of popup matching and ranking
  // (case-insensitive substring match, tiered exact > prefix > substring,
  // then recency) — see command-popup.tsx.
  // The ARGUMENT-mode lookup is case-insensitive to match the popup and
  // the engine's case-insensitive dispatch.
  const argCommand = argMatch
    ? allCommands.find((c) => c.name.toLowerCase() === argMatch[1].toLowerCase())
    : undefined;
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
      ? commandsToItems(allCommands, commandRecency, commandQuery)
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
  // Prefill for a Composer that is ALREADY mounted (the workflow editor's
  // assistant panel sits open beside the canvas, so its suggestions never
  // get a fresh mount to seed). The initializer above still covers the
  // navigate-then-mount handoff: it consumes first, which leaves nothing
  // here to read, so this effect no-ops on mount instead of double-seeding.
  const prefillNonce = useComposerPrefillStore((s) => s.prefillNonce);
  useEffect(() => {
    if (prefillNonce === 0) return;
    const pending = useComposerPrefillStore.getState().consume();
    if (pending === null) return;
    setText(pending);
    inputRef.current?.focus();
  }, [prefillNonce]);
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
  //
  // `working` gates the Stop button and the Escape interrupt, so it must be
  // true for the WHOLE time the agent holds the execution context — not just
  // while status transition events happen to be flowing. `agentStatus` alone
  // misses two windows: a client that connected mid-turn before the WS
  // handshake seeded it, and any state the live events dropped. The queue
  // state is the durable fallback: a running/blocked/queued submission means
  // there is something to abort.
  const working =
    (agentStatus !== "idle" && agentStatus !== "error") || queueBusy(queueState);
  // `collect` also lands on `queue`: a collect-mode message waits for its
  // window to close, so "after the current turn" stays true for it.
  const action: SubmitAction = !working
    ? "send"
    : queueState?.mode === "steer"
      ? "steer"
      : "queue";
  const canSend = !send.isPending && !!threadId && text.trim().length > 0;
  // An image alone cannot go out: the route requires text on the prompt.
  // Say so on the disabled button instead of leaving the user guessing.
  const sendTitle = working
    ? ACTION_HINT[action]
    : images.length > 0 && text.trim().length === 0
      ? "Add a message to send with the images."
      : undefined;

  /** True while the composer refuses new files. */
  const intakeBlocked = !IMAGE_ATTACHMENTS_ENABLED || send.isPending || !threadId;

  /**
   * Take files from a paste, a drop, or the picker. Refused files leave a
   * message; accepted files are read into `data:` URLs for the preview and
   * for the request body.
   *
   * Wrapped in `useCallback` so the identity survives across renders — the
   * page-level drop target reads this via the ComposerDropContext, and a
   * stable callback keeps the intake object it publishes stable too.
   */
  const addFiles = useCallback(
    async (files: File[]) => {
      if (intakeBlocked || files.length === 0) return;
      const { accepted, rejected } = acceptImages(imagesRef.current, files);
      setImageErrors(rejected);
      const read: ComposerImage[] = [];
      const failures: string[] = [];
      for (const file of accepted) {
        try {
          read.push(await readImage(file));
        } catch (err) {
          failures.push(err instanceof Error ? err.message : readFailure(file.name));
        }
      }
      if (failures.length > 0) setImageErrors((prev) => [...prev, ...failures]);
      if (read.length === 0) return;
      // `acceptImages` ran against the state this call captured. A second
      // intake that overlaps this one (a drop while a paste still reads)
      // would push past the cap, so the cap is applied again at the state
      // edge, where the real list is.
      setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES));
    },
    [intakeBlocked],
  );

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (intakeBlocked) return;
    const files = filesFromClipboard(e.clipboardData?.items);
    if (files.length === 0) return;
    // A pasted screenshot must not also drop its file name into the text.
    e.preventDefault();
    void addFiles(files);
  }

  function onDragEnter(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function onDragOver(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    // Without this the browser refuses the drop and opens the file instead.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void addFiles(filesFromList(e.dataTransfer.files));
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = filesFromList(e.target.files);
    // Clear the input so the same file can be chosen again later.
    e.target.value = "";
    void addFiles(files);
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((image) => image.id !== id));
  }

  async function submit() {
    const t = text.trim();
    if (!t || send.isPending || !threadId) return;
    // Held images go with the message. Convert them to the wire format
    // and pass them in the request body.
    const pendingImages = images;
    const attachments = pendingImages.length > 0 ? toPromptAttachments(pendingImages) : undefined;
    setText("");
    setImages([]);
    setImageErrors([]);
    // Optimistic local add — the engine doesn't emit a wire event for the
    // user's own message, so without this the prompt would only appear after
    // the next WS init (page reload). The next init replaces this row with
    // the server's persisted copy.
    const localId = addUserMessage(sessionId, t, threadId, attachments);
    try {
      const res = await send.mutateAsync({
        text: t,
        threadId,
        attachments,
      });
      // `messageId` on the response is the engine's queue item id (see
      // POST /:id/messages). Stamping it closes the linkage so
      // `submission.settled` can match this exact message instead of
      // falling back to a recency heuristic. Null for slash commands —
      // they never queue, so there is nothing to link.
      if (res.messageId) setMessageQueueItemId(sessionId, localId, res.messageId);
      // Recency ranking for the command popup. Recorded only for a name the
      // registry knows, and only after the send succeeded — a typo or a
      // failed send is not a "use". Matched case-insensitively (dispatch
      // is too) and recorded under the canonical name so the recency key
      // always lines up with the popup's names.
      const typedName = /^\/(\S+)/.exec(t)?.[1]?.toLowerCase();
      const canonical = typedName
        ? allCommands.find((c) => c.name.toLowerCase() === typedName)?.name
        : undefined;
      if (canonical) {
        setCommandRecency(recordCommandUse(canonical));
      }
    } catch (err) {
      // Restore the draft on failure so the user can retry. The optimistic
      // message stays visible — they can see what they sent + retry; on the
      // next reload it'll be reconciled against server truth.
      setText(t);
      setImages(pendingImages);
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

  // Publish the intake pipeline to SessionView's ComposerDropContext, so
  // the page-level drop target can hand off files dropped anywhere on the
  // chat tab. Republish whenever the callback identity or the blocked flag
  // changes; clear on unmount so a stale intake is never called.
  const dropChannel = useComposerDrop();
  useEffect(() => {
    if (!dropChannel) return;
    dropChannel.publish({
      addFiles: (files) => void addFiles(files),
      blocked: intakeBlocked,
      ownedEl: formRef.current,
    });
    return () => dropChannel.publish(null);
  }, [dropChannel, addFiles, intakeBlocked]);

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "border-t border-[--border] p-3 bg-[--bg]",
        dragActive && "ring-2 ring-inset ring-moss",
      )}
    >
      <QueueIndicator queueState={queueState} />
      {dragActive && <p className="mb-2 text-xs text-muted">Drop the images to attach them.</p>}
      <ComposerImageErrors messages={imageErrors} onDismiss={() => setImageErrors([])} />
      <ComposerImageStrip images={images} onRemove={removeImage} />
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
          onPaste={onPaste}
          placeholder={threadId ? ACTION_PLACEHOLDER[action] : "Loading thread…"}
          rows={2}
          className="flex-1"
          disabled={send.isPending || !threadId}
        />
        {IMAGE_ATTACHMENTS_ENABLED && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={IMAGE_ACCEPT_ATTRIBUTE}
              multiple
              className="hidden"
              onChange={onPickFiles}
              data-testid="composer-image-input"
            />
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={intakeBlocked}
              aria-label="Attach images"
              title="Attach images"
            >
              <ImagePlus className="h-4 w-4" />
            </Button>
          </>
        )}
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
          title={sendTitle}
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
