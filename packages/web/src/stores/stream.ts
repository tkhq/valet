/**
 * Per-session streaming state. The WS subscriber pipes wire events into this
 * store; the UI subscribes by sessionId and renders the derived message list.
 *
 * Why not just useReducer + context: the message list updates *frequently*
 * (every text_delta), and sub-trees (a single MessageItem) want to consume
 * just their slice. Zustand's selector subscriptions give us per-message
 * granularity for free.
 */
import { create } from "zustand";
import { parsePartialJson } from "~/lib/partial-json";
import type {
  DecisionGate,
  Message,
  MessagePart,
  PromptImageAttachment,
  WireEvent,
  WireQueueState,
} from "@valet/api/wire";

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

/**
 * Terminal outcome of a queued submission, stashed on the originating user
 * message so the UI can render a badge. Set by the `submission.settled`
 * reducer case; cleared (undefined) on `completed` — a clean run doesn't
 * need a badge.
 */
export type SettledOutcome = "failed" | "aborted" | "superseded" | "merged";

export type AgentStatus =
  | "idle"
  | "queued"
  | "thinking"
  | "tool_calling"
  | "streaming"
  | "blocked_on_decision_gate"
  | "error";

/**
 * Client-local extension of the wire `Message` shape. `settledOutcome` is
 * stashed here (not on the wire type) once a `submission.settled` frame
 * resolves the turn that produced this user message; `queueItemId` is a
 * forward-compat hook for when the REST layer starts exposing the engine's
 * queue_item_id on user message rows (it does not today — see the reducer
 * comment on `submission.settled` for the fallback this store uses instead).
 */
export interface StreamMessage extends Message {
  settledOutcome?: SettledOutcome;
  /**
   * Reason for a non-clean `settledOutcome`, taken from the wire event's
   * `error` field. The engine states why a turn failed; without this field
   * the store dropped that text and the UI could only show a bare "failed"
   * chip. Undefined when the outcome carries no reason (an abort, or a
   * clean completion).
   */
  settledError?: string;
  queueItemId?: string;
}

/**
 * Live agent status for one thread. Wire `status`/`turn_end` frames carry a
 * `threadId`; this is the per-thread slice they update.
 */
export interface ThreadLiveStatus {
  /** Engine-reported agent status; mirrors the wire `status` event. */
  status: AgentStatus;
  /**
   * Wire timestamp (`WireEvent.ts`) of the first non-idle `status` event in
   * the current turn — server-stamped, not `Date.now()`, so it isn't thrown
   * off by client clock skew. `undefined` while idle. Drives the elapsed-
   * time counter on `AgentStatusBadge`; does not reset on an idle→non-idle
   * status change WITHIN a turn (thinking → tool_calling → streaming), only
   * on idle → non-idle.
   */
  turnStartedAt?: number;
}

/**
 * RULE: a wire frame that carries a `threadId` MUST land in a per-thread
 * map (`statusByThread`, `errorByThread`, `queueByThread`, gates keyed by
 * id with a threadId field) — never in a session-scoped field. A
 * session-scoped copy of thread state paints one thread's signal onto
 * every other thread's view; we shipped that bug for status AND errors.
 * Session-scoped fields are only for state with no thread: the socket
 * (`conn`, `lastOffset`), the sandbox, `sessionError`.
 */
export interface SessionStreamState {
  /** Whether the WS is currently open. */
  conn: ConnectionStatus;
  /**
   * Highest durable `offset` seen for this session (16-digit zero-padded,
   * lexicographic == numeric compare). `""` until the first offset-carrying
   * frame arrives. `chunk`-style high-frequency frames (e.g. `text_delta`)
   * never carry an offset and never advance this value. Replaces the old
   * `lastSeq` dedupe — sockets don't guarantee `seq` continuity across a
   * reconnect, but durable offsets do.
   */
  lastOffset: string;
  /**
   * Per-thread agent status, keyed by threadId. Wire `status` frames carry
   * the originating thread; keying by it keeps one thread's state (e.g.
   * `blocked_on_decision_gate`) from painting the status badge on every
   * other thread in the session. A thread with no entry is idle.
   */
  statusByThread: Record<string, ThreadLiveStatus>;
  /** Live message list. Server `init` seeds it; wire events mutate it. */
  messages: StreamMessage[];
  /**
   * Pending decision gates, keyed by gate id. Each gate carries its
   * `threadId`; the UI selector filters to the active thread so a gate
   * raised on thread A is not visible while the user views thread B.
   */
  pendingGates: Record<string, DecisionGate>;
  /**
   * Per-thread submission queue state, mirroring the wire `queue.state`
   * frame. Drives the composer's "N queued" / paused indicator.
   */
  queueByThread: Record<string, WireQueueState>;
  /**
   * Bumps on every `model_switched` wire event, whatever triggered the
   * switch (picker mutation, `/model` command, direct API call). The
   * session-view hook watches it and refetches the session/threads queries
   * so the header picker never shows a stale model.
   */
  modelSwitchNonce: number;
  /**
   * Last wire error per thread. Wire `error` frames carry the originating
   * threadId; keying by it keeps thread B's failure banner off thread A's
   * view. Cleared per thread when that thread streams a new message or the
   * user sends a new prompt on it — never by another thread's activity.
   */
  errorByThread: Record<string, { code: string; message: string }>;
  /**
   * A wire error with no threadId (e.g. `ws_open_failed`) — a session-level
   * failure, shown whatever thread is active.
   */
  sessionError?: { code: string; message: string };
  /**
   * Ambient sandbox attachment status, mirroring the wire `sandbox.status`
   * frame. Session-scoped (no threadId). Undefined until the first event
   * arrives — absent means "unknown", not "detached". Epoch-gated: a frame
   * whose `epoch` is behind the currently stored epoch is a stale replay
   * and is dropped (see `reduce`'s `sandbox.status` case).
   */
  sandbox?: { state: string; epoch: number };
  /**
   * Accumulated raw args JSON per in-flight tool call (`tool_call_update`
   * frames), keyed by callId. `parsedLen` is the buffer length at the last
   * parse attempt — large buffers re-parse on a geometric stride instead of
   * per delta. Client-local scratch: entries die with their part — on
   * `tool_start` (call executes), and via `sweepStreamingParts` on
   * message_start / turn_end / abort-or-error message_end.
   */
  streamingArgs?: Record<string, { text: string; parsedLen: number }>;
}

export interface StreamStore {
  bySession: Record<string, SessionStreamState>;
  // ── actions ────────────────────────────────────────────────────────────
  setConnection(sessionId: string, conn: ConnectionStatus): void;
  ingest(sessionId: string, ev: WireEvent): void;
  /**
   * Optimistically append a user-authored message to the local view. Engine
   * doesn't emit a wire event when a user prompt is enqueued — without this
   * the prompt would only appear after the next REST refetch. Returns the
   * synthetic message id so callers can correlate.
   *
   * `threadId` is required so the message is correctly scoped: switching
   * threads then back must not show this message in the wrong thread.
   */
  addUserMessage(
    sessionId: string,
    text: string,
    threadId: string,
    attachments?: PromptImageAttachment[],
  ): string;
  /**
   * Stamp the queue item id onto an existing message (typically the
   * optimistic user message `addUserMessage` just created) once the
   * `POST /messages` response resolves. `SendPromptResponse.messageId` is
   * the engine's queue item id — closing this linkage lets
   * `submission.settled` match the exact originating message instead of
   * falling back to a recency heuristic. No-op if the message isn't found
   * (e.g. it was already reconciled away by a REST snapshot).
   */
  setMessageQueueItemId(sessionId: string, messageId: string, queueItemId: string): void;
  /**
   * Merge the messages for a single thread with a fresh REST snapshot.
   * Other threads' messages stay put. Within the target thread, any
   * store message whose id is *absent* from the REST snapshot is kept
   * (positioned after the REST rows, in its original relative order) —
   * this generalizes the old user-opt- prefix special case to cover any
   * client-local row the REST snapshot hasn't caught up to yet, most
   * importantly a mid-stream assistant message (created at `message_start`,
   * not yet persisted) that this same refetch would otherwise silently
   * wipe out from under an in-flight `text_delta`/`tool_start` stream. Once
   * the REST snapshot's id set includes a given row (e.g. the engine has
   * persisted it under the same id), the REST copy wins and the local
   * extra is dropped.
   *
   * This is the entry point for thread history loading after a thread
   * switch (or initial route mount), and is also invoked opportunistically
   * mid-turn (see `useInvalidateMessagesOnQueueState`) — hence the merge
   * rather than a hard replace.
   */
  setThreadMessages(
    sessionId: string,
    threadId: string,
    messages: Message[],
  ): void;
  /**
   * Seed pending gates from REST (the bootstrap path on session detail
   * mount). Replaces the current pending-gates map for the session.
   */
  setPendingGates(sessionId: string, gates: DecisionGate[]): void;
  reset(sessionId: string): void;
  remove(sessionId: string): void;
}

const EMPTY: SessionStreamState = {
  conn: "idle",
  lastOffset: "",
  statusByThread: {},
  errorByThread: {},
  messages: [],
  pendingGates: {},
  queueByThread: {},
  modelSwitchNonce: 0,
};

function ensure(state: StreamStore, sessionId: string): SessionStreamState {
  return state.bySession[sessionId] ?? { ...EMPTY };
}

/**
 * Apply one wire event to a session slice. Pure: returns a new slice or
 * the same one if nothing changed.
 *
 * Dedupe/ordering is offset-based, not seq-based: `seq` only orders frames
 * within a single socket connection, but a reconnect resumes with
 * `?fromOffset=` and replays durable frames that may re-send a seq the
 * client already saw under the old connection. `offset` is the durable,
 * monotonic key — frames at or behind `lastOffset` are dropped. `chunk`-like
 * high-frequency frames (`text_delta`) never carry an offset and therefore
 * never advance `lastOffset`, but they're still applied (not dropped) since
 * they have no offset to compare against.
 */
function reduce(slice: SessionStreamState, ev: WireEvent, sessionId: string): SessionStreamState {
  // Drop durable replays / out-of-order frames. Frames without an offset
  // (chunk-style) always pass this check.
  if (ev.offset && ev.offset <= slice.lastOffset) return slice;

  const next: SessionStreamState = {
    ...slice,
    lastOffset: ev.offset && ev.offset > slice.lastOffset ? ev.offset : slice.lastOffset,
  };

  switch (ev.type) {
    case "init": {
      // Init no longer carries messages — REST drives history per-thread.
      // We only clear transient state (status / error) so the UI doesn't
      // show stale signals after a reconnect.
      //
      // Pending gates are *not* cleared: the WS reconnect dance shouldn't
      // make an awaiting-approval card flicker out of view. The bootstrap
      // GET /decisions seeds them on first load; subsequent gates arrive
      // on the wire.
      next.errorByThread = {};
      next.sessionError = undefined;
      next.statusByThread = {};
      return next;
    }

    case "message_start": {
      // A new message is actually streaming on THIS thread — its own error
      // banner from a prior failed turn is stale now. Only this thread's:
      // another thread starting a turn says nothing about this one's
      // failure, and orchestrator sessions stream on siblings constantly.
      if (slice.errorByThread[ev.threadId]) {
        const { [ev.threadId]: _, ...rest } = slice.errorByThread;
        next.errorByThread = rest;
      }
      // Any part still `streaming` on this thread belongs to a dead attempt
      // (zombie deltas from a superseded run are unfenced and can arrive
      // after its cleanup) — sweep before the new message begins.
      sweepStreamingParts(next, ev.threadId);
      // Begin a new message row. The wire's role is the full MessageRole
      // union (user/assistant/tool/system); we forward verbatim. Earlier
      // versions collapsed to assistant which broke any future user-role
      // synthesized events.
      const exists = next.messages.some((m) => m.id === ev.messageId);
      if (exists) return next;
      const newMsg: Message = {
        id: ev.messageId,
        sessionId,
        threadId: ev.threadId,
        role: ev.role,
        content: "",
        parts: [],
        createdAt: ev.ts,
      };
      next.messages = [...next.messages, newMsg];
      return next;
    }

    case "text_delta": {
      const idx = lastIndex(slice.messages, (m) => m.id === ev.messageId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const parts = appendTextPart(m.parts, ev.delta);
      const updated = { ...m, parts, content: m.content + ev.delta };
      next.messages = replaceAt(slice.messages, idx, updated);
      return next;
    }

    case "message_update": {
      const idx = lastIndex(slice.messages, (m) => m.id === ev.messageId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const updated: Message = {
        ...m,
        parts: ev.parts,
        content: ev.content ?? m.content,
      };
      next.messages = replaceAt(slice.messages, idx, updated);
      return next;
    }

    case "message_end": {
      // On abort/error, sweep parts still in `streaming` status: their tool
      // call never reached toolcall_end, so the engine never persisted them —
      // keeping them would show a phantom card that vanishes on reload. The
      // sweep is thread-wide (not by messageId) so a client that attached
      // the part to an older message (mid-turn connect) still cleans up.
      // On end_turn the streaming parts are about to execute — tool_start
      // upgrades them in place.
      if (ev.reason === "end_turn") return next;
      sweepStreamingParts(next, ev.threadId);
      return next;
    }

    case "tool_call_update": {
      // Live args streaming: upsert a `streaming` tool_call part keyed by
      // callId on the latest assistant message, accumulating the raw JSON
      // and best-effort parsing it so renderers can preview args early.
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const pidx = m.parts.findIndex((p) => p.kind === "tool_call" && p.callId === ev.callId);
      const prev = pidx >= 0 ? m.parts[pidx] : undefined;
      // A delta arriving after tool_start (reordered frames) must not
      // regress an executing part back to streaming.
      if (prev && prev.kind === "tool_call" && prev.status !== "streaming") return next;
      const scratch = slice.streamingArgs?.[ev.callId];
      const text = (scratch?.text ?? "") + ev.argsDelta;
      // Parse policy: small buffers parse on every delta (live feel). Past
      // PARSE_EAGER_LIMIT, re-parse only when the buffer grew ~12.5% since
      // the last attempt — bounds total parse work to O(n log n) instead of
      // O(n²) for large streamed args. tool_start ships the complete args
      // later, so a briefly stale tail preview is fine.
      const shouldParse =
        text.length <= PARSE_EAGER_LIMIT ||
        text.length - (scratch?.parsedLen ?? 0) >= Math.max(256, text.length >> 3);
      const prevArgs = prev?.kind === "tool_call" ? prev.args : undefined;
      let args = prevArgs;
      let parsedLen = scratch?.parsedLen ?? 0;
      if (shouldParse) {
        // A mid-key fragment parses to undefined — keep the last good parse
        // so the preview never flickers empty.
        args = parsePartialJson(text) ?? prevArgs;
        parsedLen = text.length;
      }
      next.streamingArgs = { ...slice.streamingArgs, [ev.callId]: { text, parsedLen } };
      const part: MessagePart = {
        kind: "tool_call",
        callId: ev.callId,
        toolName: ev.toolName,
        status: "streaming",
        args,
      };
      const parts = pidx >= 0 ? replaceAt(m.parts, pidx, part) : [...m.parts, part];
      next.messages = replaceAt(slice.messages, idx, { ...m, parts });
      return next;
    }

    case "tool_start": {
      // Upsert the tool_call part (running) on the latest assistant message.
      // A `streaming` part with the same callId upgrades in place; without
      // one (no args streaming happened) this appends as before.
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      const part: MessagePart = {
        kind: "tool_call",
        callId: ev.callId ?? `${ev.toolName}_${ev.ts}`,
        toolName: ev.toolName,
        status: "running",
        args: ev.args,
      };
      const pidx =
        ev.callId !== undefined
          ? m.parts.findIndex((p) => p.kind === "tool_call" && p.callId === ev.callId)
          : -1;
      if (ev.callId !== undefined && slice.streamingArgs?.[ev.callId] !== undefined) {
        const { [ev.callId]: _, ...rest } = slice.streamingArgs;
        next.streamingArgs = rest;
      }
      const parts = pidx >= 0 ? replaceAt(m.parts, pidx, part) : [...m.parts, part];
      next.messages = replaceAt(slice.messages, idx, { ...m, parts });
      return next;
    }

    case "tool_end": {
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      // Resolve by callId when the wire ships one; fall back to the most
      // recent running tool_call with this name (pre-callId frames from
      // durable logs written before callId existed — remove once those age
      // out).
      let pidx = -1;
      if (ev.callId !== undefined) {
        pidx = m.parts.findIndex((p) => p.kind === "tool_call" && p.callId === ev.callId);
      }
      if (pidx < 0) {
        pidx = lastIndex(
          m.parts,
          (p) => p.kind === "tool_call" && p.toolName === ev.toolName && p.status === "running",
        );
      }
      if (pidx < 0) return next;
      const old = m.parts[pidx];
      if (old.kind !== "tool_call") return next;
      const updatedPart: MessagePart = {
        ...old,
        status: ev.isError ? "error" : "completed",
        result: ev.result,
        error: ev.isError ? ev.result : undefined,
      };
      const parts = replaceAt(m.parts, pidx, updatedPart);
      next.messages = replaceAt(slice.messages, idx, { ...m, parts });
      return next;
    }

    case "status": {
      const prev = slice.statusByThread[ev.threadId];
      const wasIdle = prev === undefined || prev.status === "idle";
      const turnStartedAt =
        ev.status === "idle" ? undefined : wasIdle ? ev.ts : prev.turnStartedAt;
      // Duplicate frames are routine (the engine re-emits tool_calling per
      // tool; the handshake seed and durable replay overlap) — skip them so
      // the entry keeps its identity and subscribers do not re-render. An
      // offset-carrying frame still advances lastOffset via `next`.
      const unchanged = prev
        ? prev.status === ev.status && prev.turnStartedAt === turnStartedAt
        : ev.status === "idle";
      if (unchanged) return ev.offset ? next : slice;
      next.statusByThread = {
        ...slice.statusByThread,
        [ev.threadId]: { status: ev.status, turnStartedAt },
      };
      return next;
    }

    case "turn_end": {
      next.statusByThread = { ...slice.statusByThread, [ev.threadId]: { status: "idle" } };
      // No further tool activity can arrive for this turn — any part still
      // `streaming` (superseded attempt, dropped upgrade) is dead. Sweep it
      // and its scratch so zombie state cannot outlive the turn.
      sweepStreamingParts(next, ev.threadId);
      // Deliberately KEEP the thread's error: on a failed turn the engine
      // emits `error` then `turn_end` within the same tick, so clearing here
      // made the error banner flash for milliseconds and vanish — a failing
      // turn (exhausted credits, bad key) looked like a silent empty reply.
      // The error clears when this thread streams a new message
      // (`message_start`) or the user sends it a new prompt
      // (`addUserMessage`).
      return next;
    }

    case "error": {
      // Engine-originated errors name their thread; store the banner and
      // flip the badge for that thread only. A session-level error (no
      // threadId, e.g. `ws_open_failed`) lands in `sessionError` and shows
      // whatever thread is active.
      if (ev.threadId !== undefined) {
        next.errorByThread = {
          ...slice.errorByThread,
          [ev.threadId]: { code: ev.code, message: ev.message },
        };
        const prev = slice.statusByThread[ev.threadId];
        next.statusByThread = {
          ...slice.statusByThread,
          [ev.threadId]: { status: "error", turnStartedAt: prev?.turnStartedAt },
        };
      } else {
        next.sessionError = { code: ev.code, message: ev.message };
      }
      return next;
    }

    case "model_switched": {
      // Bump the nonce so `useInvalidateSessionOnModelSwitch` refetches the
      // session/threads queries. Mutation hooks only cover picker-originated
      // switches; `/model` commands and direct API switches arrive ONLY
      // through this event — without the bump the header shows a stale model
      // until a manual reload.
      next.modelSwitchNonce = slice.modelSwitchNonce + 1;
      return next;
    }

    case "decision_gate": {
      // The engine raised a gate. Stash it so the UI can render an
      // approval/question/credential card scoped to the originating
      // thread.
      next.pendingGates = { ...slice.pendingGates, [ev.gate.id]: ev.gate };
      return next;
    }

    case "decision_gate_resolved":
    case "decision_gate_expired":
    case "decision_gate_withdrawn": {
      // Whichever way a gate leaves the pending state, drop it from
      // local state. The engine will emit a status change back to
      // running/idle on its own.
      if (!slice.pendingGates[ev.gateId]) return next;
      const { [ev.gateId]: _, ...rest } = slice.pendingGates;
      next.pendingGates = rest;
      return next;
    }

    case "queue.state": {
      next.queueByThread = { ...slice.queueByThread, [ev.threadId]: ev.state };
      return next;
    }

    case "submission.settled": {
      // Mark the originating user message with a terminal badge.
      //
      // Matching: prefer an exact `queueItemId` match — REST rows carry the
      // engine's queue_item_id via `entryToMessage`
      // (packages/api/src/routes/messages.ts), and the web client stamps it
      // onto optimistic messages once `POST /messages` resolves (see
      // `setMessageQueueItemId`). Only when no message carries a matching
      // `queueItemId` do we fall back to a recency heuristic — and even
      // then, ONLY when there is exactly one unsettled user message on the
      // thread. With two or more candidates the heuristic is ambiguous
      // (queued prompt A vs. B), so we drop the event rather than badge the
      // wrong message.
      const idx = (() => {
        const direct = lastIndex(
          slice.messages,
          (m) => m.threadId === ev.threadId && m.queueItemId === ev.queueItemId,
        );
        if (direct >= 0) return direct;
        const unsettled: number[] = [];
        for (let i = 0; i < slice.messages.length; i++) {
          const m = slice.messages[i];
          if (m.threadId === ev.threadId && m.role === "user" && m.settledOutcome === undefined) {
            unsettled.push(i);
          }
        }
        return unsettled.length === 1 ? unsettled[0] : -1;
      })();
      if (idx < 0) return next;
      const m = slice.messages[idx];
      // A clean run needs no badge and no reason. Every other outcome keeps
      // the engine's `error` text next to the outcome, so a consumer can
      // render why the turn ended instead of a bare grey chip.
      const settledOutcome: SettledOutcome | undefined =
        ev.outcome === "completed" ? undefined : ev.outcome;
      const settledError = ev.outcome === "completed" ? undefined : ev.error;
      const updated: StreamMessage = { ...m, settledOutcome, settledError };
      next.messages = replaceAt(slice.messages, idx, updated);
      return next;
    }

    case "sandbox.status": {
      // Replay safety: an event whose epoch regresses relative to what we
      // already hold is a stale re-provision-loop replay (or an
      // out-of-order resume frame) — drop it rather than clobber a newer
      // attachment's status with an older one's.
      if (slice.sandbox && ev.epoch < slice.sandbox.epoch) return next;
      next.sandbox = { state: ev.state, epoch: ev.epoch };
      return next;
    }

    case "ping": {
      return next;
    }

    case "command_result": {
      // Command results reach the message list through the REST refetch in
      // useSendPrompt's onSuccess, not through the stream store. The frame
      // still advances lastOffset via `next`.
      return next;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function lastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function lastAssistantIndex(messages: Message[], threadId: string): number {
  return lastIndex(messages, (m) => m.role === "assistant" && m.threadId === threadId);
}

function replaceAt<T>(arr: T[], i: number, val: T): T[] {
  const out = arr.slice();
  out[i] = val;
  return out;
}

/**
 * Past this buffer size, tool_call_update re-parses on a geometric stride
 * instead of per delta (see the reducer case).
 */
const PARSE_EAGER_LIMIT = 4096;

/**
 * Drop every `streaming` tool_call part on the thread, then prune
 * `streamingArgs` down to the callIds that still have a streaming part
 * anywhere (which also collects orphaned scratch from drops elsewhere).
 * Mutates `next` in place.
 *
 * Called wherever the stream proves no upgrade (`tool_start`) can arrive
 * for those parts anymore: message_start on the thread, turn_end, and
 * abort/error message_end. tool_call_update frames are unfenced ephemerals,
 * so a superseded (zombie) attempt can keep emitting them after its fenced
 * cleanup frames were suppressed — these sweeps bound that state's lifetime.
 */
function sweepStreamingParts(next: SessionStreamState, threadId: string): void {
  let changed = false;
  const messages = next.messages.map((m) => {
    if (m.threadId !== threadId) return m;
    const parts = m.parts.filter((p) => !(p.kind === "tool_call" && p.status === "streaming"));
    if (parts.length === m.parts.length) return m;
    changed = true;
    return { ...m, parts };
  });
  if (changed) next.messages = messages;
  const scratch = next.streamingArgs;
  if (!scratch || Object.keys(scratch).length === 0) return;
  const live = new Set<string>();
  for (const m of next.messages) {
    for (const p of m.parts) {
      if (p.kind === "tool_call" && p.status === "streaming") live.add(p.callId);
    }
  }
  const pruned: Record<string, { text: string; parsedLen: number }> = {};
  for (const [callId, entry] of Object.entries(scratch)) {
    if (live.has(callId)) pruned[callId] = entry;
  }
  next.streamingArgs = pruned;
}

/**
 * Append a text delta to the trailing text part of `parts`. If the last part
 * isn't a text part, push a new text part with the delta as its content.
 */
function appendTextPart(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    return [...parts.slice(0, -1), { kind: "text", text: last.text + delta }];
  }
  return [...parts, { kind: "text", text: delta }];
}

// ── store ────────────────────────────────────────────────────────────────

export const useStreamStore = create<StreamStore>((set) => ({
  bySession: {},

  setConnection: (sessionId, conn) =>
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: { ...ensure(state, sessionId), conn } },
    })),

  ingest: (sessionId, ev) =>
    set((state) => {
      const slice = ensure(state, sessionId);
      const updated = reduce(slice, ev, sessionId);
      if (updated === slice) return state;
      return { bySession: { ...state.bySession, [sessionId]: updated } };
    }),

  addUserMessage: (sessionId, text, threadId, attachments) => {
    // Synthetic id; the next WS init replaces this row with the server's
    // persisted message (different id, same content). A short collision
    // window with content-based dedupe is acceptable for v1.
    const id = `user-opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const slice = ensure(state, sessionId);
      const message: Message = {
        id,
        sessionId,
        threadId,
        role: "user",
        content: text,
        parts: [{ kind: "text", text }],
        createdAt: Date.now(),
        // Optimistic mirror of the wire projection: the REST refetch will
        // overwrite this row with the server's canonical attachments field.
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      // A fresh prompt supersedes this thread's lingering error banner from
      // the previous failed turn (see the `turn_end` reducer note). Other
      // threads' errors stay; the guard matches the `message_start` case so
      // an error-free thread keeps the map's identity.
      let errorByThread = slice.errorByThread;
      if (errorByThread[threadId]) {
        const { [threadId]: _, ...rest } = errorByThread;
        errorByThread = rest;
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...slice, messages: [...slice.messages, message], errorByThread },
        },
      };
    });
    return id;
  },

  setMessageQueueItemId: (sessionId, messageId, queueItemId) =>
    set((state) => {
      const slice = ensure(state, sessionId);
      const idx = slice.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return state;
      const updated: StreamMessage = { ...slice.messages[idx], queueItemId };
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...slice, messages: replaceAt(slice.messages, idx, updated) },
        },
      };
    }),

  setThreadMessages: (sessionId, threadId, freshMessages) =>
    set((state) => {
      const slice = ensure(state, sessionId);
      // Keep messages from other threads untouched.
      const others = slice.messages.filter((m) => m.threadId !== threadId);
      // Store-local rows for this thread that the REST snapshot doesn't
      // (yet) know about — optimistic user messages awaiting persistence,
      // and in-flight assistant messages the engine hasn't flushed to
      // `engine_entries` yet. Kept in their original relative order,
      // appended after the REST rows.
      const freshIds = new Set(freshMessages.map((m) => m.id));
      // REST-persisted user messages carry `queueItemId` (stamped when the
      // optimistic row's submission settles). A persisted user message gets
      // a *fresh* server id — merge-by-id alone never drops the optimistic
      // twin, producing a duplicate bubble. Match on queueItemId when the
      // optimistic row has been stamped; if the 202 hasn't returned yet
      // (unstamped), fall back to content match against REST user rows —
      // the pre-id-merge dedupe behavior.
      const freshQueueItemIds = new Set(
        freshMessages.filter((m) => m.queueItemId).map((m) => m.queueItemId),
      );
      const freshUserContents = new Set(
        freshMessages.filter((m) => m.role === "user").map((m) => m.content),
      );
      const isDupedOptimisticUser = (m: StreamMessage): boolean => {
        if (m.role !== "user" || !m.id.startsWith("user-opt-")) return false;
        if (m.queueItemId) return freshQueueItemIds.has(m.queueItemId);
        return freshUserContents.has(m.content);
      };
      const localOnly = slice.messages.filter(
        (m) =>
          m.threadId === threadId && !freshIds.has(m.id) && !isDupedOptimisticUser(m),
      );
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...slice,
            messages: [...others, ...freshMessages, ...localOnly],
          },
        },
      };
    }),

  setPendingGates: (sessionId, gates) =>
    set((state) => {
      const slice = ensure(state, sessionId);
      // Identity guard: seeding is idempotent, and more than one surface
      // seeds (SessionView and ThreadTree both call usePendingGatesSeed).
      // Rebuilding the record for equal content would re-render every
      // pendingGates subscriber once per seeding mount.
      const prev = slice.pendingGates;
      if (
        gates.length === Object.keys(prev).length &&
        gates.every((g) => prev[g.id]?.updatedAt === g.updatedAt)
      ) {
        return state;
      }
      const next: Record<string, DecisionGate> = {};
      for (const g of gates) next[g.id] = g;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...slice, pendingGates: next },
        },
      };
    }),

  reset: (sessionId) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...EMPTY } } })),

  remove: (sessionId) =>
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));

// ── selectors ────────────────────────────────────────────────────────────

export function useSessionStream(sessionId: string): SessionStreamState {
  return useStreamStore((s) => s.bySession[sessionId] ?? EMPTY);
}

/**
 * Stable idle value so the selector returns a referentially equal object for
 * threads with no live status — zustand re-renders on identity change.
 */
const IDLE_THREAD_STATUS: ThreadLiveStatus = { status: "idle" };

/**
 * Live status for one thread, defaulting to idle. Undefined `threadId`
 * (thread list still loading) also reads idle — the queue-state fallback in
 * the consumers covers the connect-mid-turn window.
 */
export function useThreadLiveStatus(
  sessionId: string,
  threadId: string | undefined,
): ThreadLiveStatus {
  return useStreamStore((s) => {
    if (!threadId) return IDLE_THREAD_STATUS;
    return s.bySession[sessionId]?.statusByThread[threadId] ?? IDLE_THREAD_STATUS;
  });
}

/**
 * The error banner for one thread: the thread's own error, or the
 * session-level error (no threadId on the wire frame) which shows whatever
 * thread is active. Undefined when neither exists.
 */
export function useErrorForThread(
  sessionId: string,
  threadId: string | undefined,
): { code: string; message: string } | undefined {
  return useStreamStore((s) => {
    const slice = s.bySession[sessionId];
    if (!slice) return undefined;
    return (threadId ? slice.errorByThread[threadId] : undefined) ?? slice.sessionError;
  });
}

/**
 * The first pending gate that belongs to this thread, or undefined. Threads
 * can only block on one gate at a time (the engine suspends the turn until
 * the gate resolves), so returning the first match is sufficient.
 */
export function usePendingGateForThread(
  sessionId: string,
  threadId: string | undefined,
): DecisionGate | undefined {
  return useStreamStore((s) => {
    if (!threadId) return undefined;
    const gates = s.bySession[sessionId]?.pendingGates;
    if (!gates) return undefined;
    for (const g of Object.values(gates)) {
      if (g.threadId === threadId) return g;
    }
    return undefined;
  });
}

/** The submission queue state for a thread, or undefined if never reported. */
export function useQueueStateForThread(
  sessionId: string,
  threadId: string | undefined,
): WireQueueState | undefined {
  return useStreamStore((s) => {
    if (!threadId) return undefined;
    return s.bySession[sessionId]?.queueByThread[threadId];
  });
}

/**
 * True while the thread's submission queue says the agent holds — or is
 * about to take — the execution context: a running or gate-blocked turn, or
 * submissions waiting to run. Backs the Stop button and the Escape
 * interrupt alongside `agentStatus`: the queue state comes from durable
 * rows (seeded by the WS handshake), so it stays correct across reconnects
 * and page loads that would miss the live `status` transition events.
 * Everything it reports true for is abortable — `Thread.abort` interrupts a
 * running turn, withdraws pending gates, and settles queued items.
 */
export function queueBusy(state: WireQueueState | undefined): boolean {
  if (!state) return false;
  if (
    state.status === "running" ||
    state.status === "blocked_on_decision_gate" ||
    state.status === "queued"
  ) {
    return true;
  }
  // Pause wins the status precedence in the engine's `deriveQueueState`, so
  // a thread paused mid-turn reports `paused` WITH an `activeItemId` — the
  // claimed turn keeps running and stays abortable. On any other status a
  // lingering `activeItemId` is drift (a stale frame from a turn that
  // already settled), not work — treating it as busy would pin a phantom
  // Stop button on an idle thread.
  if (state.status === "paused" && state.activeItemId !== undefined) return true;
  // Waiting submissions are busy whatever the status says: collect-buffer
  // items ride an `idle` status until their window flushes, and a paused
  // queue holds its pending items. Both are abortable.
  return state.pendingIds.length > 0 || state.collectingIds.length > 0;
}
