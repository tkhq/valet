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
import type {
  DecisionGate,
  Message,
  MessagePart,
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
  queueItemId?: string;
}

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
  /** Engine-reported agent status; mirrors the wire `status` event. */
  agentStatus: AgentStatus;
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
  /** Last error message from the wire (if any). Cleared on successful turn_end. */
  error?: { code: string; message: string };
  /**
   * Ambient sandbox attachment status, mirroring the wire `sandbox.status`
   * frame. Session-scoped (no threadId). Undefined until the first event
   * arrives — absent means "unknown", not "detached". Epoch-gated: a frame
   * whose `epoch` is behind the currently stored epoch is a stale replay
   * and is dropped (see `reduce`'s `sandbox.status` case).
   */
  sandbox?: { state: string; epoch: number };
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
  addUserMessage(sessionId: string, text: string, threadId: string): string;
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
  agentStatus: "idle",
  messages: [],
  pendingGates: {},
  queueByThread: {},
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
      next.error = undefined;
      next.agentStatus = "idle";
      return next;
    }

    case "message_start": {
      // Begin a new message row. The wire's role is the full MessageRole
      // union (user/assistant/tool/system); we forward verbatim. Earlier
      // versions collapsed to assistant which broke any future user-role
      // synthesized events.
      const exists = slice.messages.some((m) => m.id === ev.messageId);
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
      next.messages = [...slice.messages, newMsg];
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
      // Just a marker. We could clear streaming flags here when we add them.
      return next;
    }

    case "tool_start": {
      // Add a tool_call part (running) to the latest assistant message.
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
      next.messages = replaceAt(slice.messages, idx, { ...m, parts: [...m.parts, part] });
      return next;
    }

    case "tool_end": {
      const idx = lastAssistantIndex(slice.messages, ev.threadId);
      if (idx < 0) return next;
      const m = slice.messages[idx];
      // Find the most recent running tool_call with this name.
      let pidx = -1;
      for (let i = m.parts.length - 1; i >= 0; i--) {
        const p = m.parts[i];
        if (p.kind === "tool_call" && p.toolName === ev.toolName && p.status === "running") {
          pidx = i;
          break;
        }
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
      next.agentStatus = ev.status;
      return next;
    }

    case "turn_end": {
      next.agentStatus = "idle";
      next.error = undefined;
      return next;
    }

    case "error": {
      next.error = { code: ev.code, message: ev.message };
      next.agentStatus = "error";
      return next;
    }

    case "model_switched": {
      // No store mutation needed — the threads/session queries get
      // invalidated via the mutation hooks that triggered the change.
      // This case exists so the WS hook's logger has something to print
      // and so the exhaustiveness check passes.
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
      const settledOutcome: SettledOutcome | undefined =
        ev.outcome === "completed" ? undefined : ev.outcome;
      const updated: StreamMessage = { ...m, settledOutcome };
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

  addUserMessage: (sessionId, text, threadId) => {
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
      };
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...slice, messages: [...slice.messages, message] },
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
      const localOnly = slice.messages.filter(
        (m) => m.threadId === threadId && !freshIds.has(m.id),
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
