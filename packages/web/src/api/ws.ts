/**
 * `useSessionWebSocket(sessionId)` — opens a WS to the server, pipes wire
 * events into the stream store. Auto-reconnects with exponential backoff.
 *
 * Connection state and ingest live in `~/stores/stream`; this hook only
 * owns the socket lifecycle. Every view of one session shares one socket:
 * `text_delta` frames carry no offset, so a second socket would apply each
 * delta twice to the same store slice.
 */
import { useEffect } from "react";
import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { ClientFrame, ListThreadsResponse, WireEvent } from "@valet/api/wire";
import { useStreamStore } from "~/stores/stream";
import { useActiveViewersStore } from "./active-viewers";
import { qk, threadListFilters, mapThreadData, refreshMissingActivityThread } from "./queries";
import { qkThreadContext } from "./thread-context";
import { qkThreadProgress } from "./thread-progress";
import { qkThreadPlan } from "./thread-plan";

const MAX_RETRY_MS = 8_000;
/** `WebSocket.OPEN`. */
const SOCKET_OPEN = 1;
const INITIAL_RETRY_MS = 500;

function isSettingsWrite(toolName: string, args: unknown): boolean {
  const actionId = typeof args === "object" && args !== null && "tool_id" in args ? args.tool_id : undefined;
  return ["settings.update_account", "settings.update_team", "settings.update_organization"].some(id =>
    toolName === id.replace(".", "__") || (toolName === "call_tool" && id === actionId));
}

function summarizeForLog(ev: WireEvent): string {
  switch (ev.type) {
    case "init":
      return `session=${ev.session.id}`;
    case "text_delta":
      return JSON.stringify(ev.delta).slice(0, 80);
    case "tool_call_update":
      return `${ev.toolName} ${ev.callId} +${ev.argsDelta.length}ch`;
    case "tool_start":
      return `${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 80)}`;
    case "tool_end":
      return `${ev.toolName} isError=${ev.isError}`;
    case "message_start":
      return `${ev.role} ${ev.messageId} thread=${ev.threadId}`;
    case "message_end":
      return `${ev.messageId} ${ev.reason}`;
    case "message_update":
      return `${ev.messageId} parts=${ev.parts.length}`;
    case "status":
      return ev.status;
    case "turn_end":
      return ev.reason;
    case "title.updated":
      return `${ev.sessionId}/${ev.threadId}`;
    case "thread.activity":
      return `${ev.threadId} ${ev.lastUserActivityAt}`;
    case "error":
      return `${ev.code}: ${ev.message}`;
    case "model_switched":
      return `${ev.fromModel} → ${ev.toModel}${ev.threadId ? ` (thread)` : ` (session)`}`;
    case "decision_gate":
      return `${ev.gate.type} "${ev.gate.title}" (${ev.gate.id})`;
    case "decision_gate_resolved":
      return `${ev.gateId} → ${ev.resolution.actionId ?? "value"}`;
    case "decision_gate_expired":
      return `${ev.gateId} expired`;
    case "decision_gate_withdrawn":
      return `${ev.gateId} withdrawn (${ev.reason})`;
    default:
      return "";
  }
}

function invalidatePersistedTitles(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  includeSession: boolean,
  includeThread: boolean,
): void {
  if (includeSession) {
    void qc.invalidateQueries({ queryKey: qk.session(sessionId), exact: true });
    void qc.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "sessions" &&
        (queryKey.length === 1 ||
          (queryKey.length === 3 &&
            (queryKey[1] === "user" || queryKey[1] === "team" || queryKey[1] === "org"))),
    });
  }
  if (includeThread) {
    void qc.invalidateQueries(threadListFilters(sessionId));
  }
}

function wsUrl(sessionId: string, fromOffset: string | undefined, threadId: string | undefined): string {
  // Vite proxy upgrades /api → server, including WS (`ws: true`).
  // In production, the same /api path is served by the API directly.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  const query = new URLSearchParams({ ...(fromOffset ? { fromOffset } : {}), ...(threadId ? { threadId } : {}) }).toString();
  return query ? `${base}?${query}` : base;
}

interface SharedSocket {
  sessionId: string;
  views: number;
  close: () => void;
  send: (frame: ClientFrame) => void;
  /** The thread each mounted view shows on this socket (`thread.viewers`). */
  viewing: Map<symbol, string>;
}

/** Open sockets by session id and shared thread id, with their view count. */
const sockets = new Map<string, SharedSocket>();

/** Tells the server which threads this tab shows on the socket, and whether the tab is visible. */
function announceViewing(socket: SharedSocket): void {
  socket.send({ type: "viewing", threadIds: [...new Set(socket.viewing.values())], visible: document.visibilityState === "visible" });
}

/** How often a socket repeats its report, so the server can drop a silent one (sleep, lost network). */
const VIEWING_HEARTBEAT_MS = 20_000;

let visibilityListening = false;
function listenForVisibility(): void {
  if (visibilityListening || typeof document === "undefined") return;
  visibilityListening = true;
  document.addEventListener("visibilitychange", () => {
    for (const socket of sockets.values()) announceViewing(socket);
  });
}

/**
 * Reports the thread a view shows, so the people in it see this person
 * (`useActiveViewers`). Call it after `useSessionWebSocket` for the same
 * session, from the view that shows the thread.
 */
export function useAnnounceThreadView(sessionId: string, threadId: string | undefined, sharedThreadId?: string) {
  useEffect(() => {
    const socket = sockets.get(JSON.stringify([sessionId, sharedThreadId ?? null]));
    if (!socket || !threadId) return;
    const token = Symbol(threadId);
    socket.viewing.set(token, threadId);
    announceViewing(socket);
    return () => {
      socket.viewing.delete(token);
      if (sockets.get(JSON.stringify([sessionId, sharedThreadId ?? null])) === socket) announceViewing(socket);
    };
  }, [sessionId, threadId, sharedThreadId]);
}

/** The last typing signal sent per `sessionId threadId`. */
const typingSentAt = new Map<string, number>();
/** A typing signal goes out at most this often while the person types. */
const TYPING_SIGNAL_MS = 2_000;

/**
 * Tells the people in a thread that this person is typing there, or stopped
 * (after a send). Carries no text. Repeated calls while typing are throttled.
 */
export function announceTyping(sessionId: string, threadId: string, active: boolean): void {
  const key = `${sessionId} ${threadId}`;
  const now = Date.now();
  if (active && now - (typingSentAt.get(key) ?? 0) < TYPING_SIGNAL_MS) return;
  if (!active && !typingSentAt.has(key)) return;
  if (active) typingSentAt.set(key, now);
  else typingSentAt.delete(key);
  for (const socket of sockets.values()) {
    if (socket.sessionId === sessionId && [...socket.viewing.values()].includes(threadId)) {
      socket.send({ type: "typing", threadId, active });
    }
  }
}

/** `sharedThreadId` opens the stream of one shared thread for a person who
 * is not the session's owner: the server sends that thread's frames only. */
export function useSessionWebSocket(sessionId: string, sharedThreadId?: string) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!sessionId) return;
    const key = JSON.stringify([sessionId, sharedThreadId ?? null]);
    let shared = sockets.get(key);
    if (!shared) {
      listenForVisibility();
      const created: SharedSocket = { sessionId, views: 0, close: () => {}, send: () => {}, viewing: new Map() };
      const connection = connect(qc, sessionId, sharedThreadId, () => announceViewing(created));
      const heartbeat = setInterval(() => { if (created.viewing.size > 0) announceViewing(created); }, VIEWING_HEARTBEAT_MS);
      created.close = () => { clearInterval(heartbeat); connection.close(); };
      created.send = connection.send;
      shared = created;
      sockets.set(key, shared);
    }
    shared.views += 1;
    const current = shared;
    return () => {
      current.views -= 1;
      if (current.views > 0) return;
      sockets.delete(key);
      current.close();
    };
    // The app has one query client, so the hook re-runs only when the
    // session or shared thread changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sharedThreadId]);
}

/** Opens one socket. `onOpen` runs on every connect and reconnect. */
function connect(qc: QueryClient, sessionId: string, sharedThreadId: string | undefined, onOpen: () => void): { close: () => void; send: (frame: ClientFrame) => void } {
  const { setConnection, ingest, reset } = useStreamStore.getState();
  // Per-connection cancellation flag. Must be a closure local, NOT a
  // shared ref: under StrictMode's double effect run, a shared ref gets
  // re-armed to false by the second run, letting the first run's closed
  // socket schedule a zombie reconnect — two live sockets, duplicated
  // chunk rendering.
  let cancelled = false;
  // Fresh mount (no durable offset seen yet for this session) resets the
  // slice and relies on REST to bootstrap history/gates. A resumed
  // connection (lastOffset non-empty — either a reconnect within this
  // mount's lifetime, or a remount that still has store state e.g. a
  // route revisit) must NOT reset: state is continuous and the server
  // replays the gap via `?fromOffset=`, so wiping here would cause a
  // flash back to empty before replay refills it.
  if (!useStreamStore.getState().bySession[sessionId]?.lastOffset) {
    reset(sessionId);
  }
  setConnection(sessionId, "connecting");

  let socket: WebSocket | null = null;
  const settingsWrites = new Map<string, string>();
  // A remount resumes after tool_start. Recover pending writes from the
  // same stream state that retains the durable cursor.
  for (const message of useStreamStore.getState().bySession[sessionId]?.messages ?? []) {
    for (const part of message.parts) {
      if (part.kind === "tool_call" && part.status === "running" && isSettingsWrite(part.toolName, part.args) && message.threadId) {
        settingsWrites.set(part.callId, message.threadId);
      }
    }
  }
  let retryDelay = INITIAL_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function open() {
    if (cancelled) return;
    const lastOffset = useStreamStore.getState().bySession[sessionId]?.lastOffset;
    socket = new WebSocket(wsUrl(sessionId, lastOffset || undefined, sharedThreadId));
    socket.onopen = () => {
      setConnection(sessionId, "open");
      onOpen();
    };
    socket.onmessage = (ev) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
        const wire = JSON.parse(data) as WireEvent;
        if (import.meta.env.DEV) {
          const summary = summarizeForLog(wire);
          console.debug(`[ws] seq=${wire.seq} ${wire.type} ${summary}`);
        }
        ingest(sessionId, wire);
        if (wire.type === "tool_start" && wire.callId && isSettingsWrite(wire.toolName, wire.args)) {
          settingsWrites.set(wire.callId, wire.threadId);
        }
        if (wire.type === "tool_end" && wire.callId && settingsWrites.delete(wire.callId) && !wire.isError) {
          void qc.invalidateQueries({ queryKey: ["settings"] });
        }
        if (wire.type === "queue.state" || wire.type === "tool_start" || wire.type === "tool_end"
          || wire.type === "decision_gate" || wire.type === "decision_gate_resolved"
          || wire.type === "decision_gate_expired" || wire.type === "decision_gate_withdrawn"
          || wire.type === "turn_end" || wire.type === "submission.settled" || wire.type === "branch_switched"
          || wire.type === "error" || wire.type === "init") {
          void qc.invalidateQueries({ queryKey: "threadId" in wire && wire.threadId ? qkThreadProgress(wire.threadId) : ["thread-progress"] });
        }
        // Only `update_plan` changes a thread's plan.
        if (wire.type === "tool_end" && wire.toolName === "update_plan" && !wire.isError) {
          void qc.invalidateQueries({ queryKey: qkThreadPlan(wire.threadId) });
        }
        if (wire.type === "title.updated") {
          invalidatePersistedTitles(qc, sessionId, Boolean(wire.sessionTitle), Boolean(wire.threadTitle));
        }
        // A finished turn can add an unread reply or a pull request to any thread
        // in the session. The list query carries both, so refresh it.
        if (wire.type === "turn_end") {
          void qc.invalidateQueries(threadListFilters(sessionId));
          for (const [callId, threadId] of settingsWrites) if (threadId === wire.threadId) settingsWrites.delete(callId);
        }
        // The context meter's reading moves when a turn ends, a compaction
        // rewrites the transcript, or the model (and so the budget) changes.
        // A turn_end refetch can land while the turn still holds a one-off
        // model, so the turn's settlement refreshes the reading once more.
        // A branch switch rewrites the thread's history for every viewer.
        if (wire.type === "branch_switched") {
          void qc.invalidateQueries({ queryKey: qk.messages(sessionId, wire.threadId) });
        }
        if (wire.type === "turn_end" || wire.type === "submission.settled" || wire.type === "compaction_end" || wire.type === "model_switched" || wire.type === "branch_switched") {
          void qc.invalidateQueries({
            queryKey: wire.threadId ? qkThreadContext.thread(sessionId, wire.threadId) : qkThreadContext.session(sessionId),
          });
        }
        if (wire.type === "thread.viewers") {
          useActiveViewersStore.getState().set(sessionId, wire.threadId, wire.viewers);
        }
        if (wire.type === "thread.activity") {
          qc.setQueriesData<ListThreadsResponse | InfiniteData<ListThreadsResponse>>(threadListFilters(sessionId), current => mapThreadData(current, thread =>
            thread.id === wire.threadId ? { ...thread, lastUserActivityAt: Math.max(thread.lastUserActivityAt, wire.lastUserActivityAt) } : thread));
          // Unloaded rows can move above the saved cursor. Fetch just that row.
          void refreshMissingActivityThread(qc, wire.threadId);
        }
        // Reset backoff only after receiving init — confirms the session
        // is valid and the connection is healthy. Resetting in onopen
        // allowed a connect→immediate-close loop at INITIAL_RETRY_MS.
        if (wire.type === "init") {
          retryDelay = INITIAL_RETRY_MS;
          // The server sends current viewer lists again for the threads this
          // tab reports; lists from before a reconnect may be stale.
          useActiveViewersStore.getState().clear(sessionId);
          // title.updated is ephemeral. Refresh both persisted title views
          // after every initial connection or reconnect to recover a frame
          // missed while this client was disconnected.
          invalidatePersistedTitles(qc, sessionId, true, true);
        }
      } catch (err) {
        console.error("ws parse failed:", err);
      }
    };
    socket.onerror = () => {
      // The matching onclose will trigger the reconnect.
      setConnection(sessionId, "error");
    };
    socket.onclose = (closeEv) => {
      if (cancelled) return;
      // 4040 means the session does not exist or the user cannot view it.
      // A retry cannot change that result. Other private close codes can
      // describe temporary application state, so they keep the backoff.
      if (closeEv.code === 4040) {
        setConnection(sessionId, "error");
        return;
      }
      setConnection(sessionId, "closed");
      retryTimer = setTimeout(open, retryDelay);
      retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
    };
  }

  open();

  const send = (frame: ClientFrame) => {
    if (socket?.readyState === SOCKET_OPEN) socket.send(JSON.stringify(frame));
  };
  const close = () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
    // `onclose` early-returns once cancelled, so without this the slice
    // would report "open" forever after the last view of this session
    // unmounts — and readers that trust an open connection as live gate
    // truth (the assistant rail's needs-you dot) would keep believing a
    // stale gate set.
    setConnection(sessionId, "closed");
  };
  return { close, send };
}
