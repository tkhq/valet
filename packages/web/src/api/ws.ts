/**
 * `useSessionWebSocket(sessionId)` — opens a WS to the server, pipes wire
 * events into the stream store. Auto-reconnects with exponential backoff.
 *
 * Connection state and ingest live in `~/stores/stream`; this hook only
 * owns the socket lifecycle.
 */
import { useEffect } from "react";
import type { WireEvent } from "@valet/api/wire";
import { useStreamStore } from "~/stores/stream";

const MAX_RETRY_MS = 8_000;
const INITIAL_RETRY_MS = 500;

function summarizeForLog(ev: WireEvent): string {
  switch (ev.type) {
    case "init":
      return `session=${ev.session.id}`;
    case "text_delta":
      return JSON.stringify(ev.delta).slice(0, 80);
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

function wsUrl(sessionId: string, fromOffset: string | undefined): string {
  // Vite proxy upgrades /api → server, including WS (`ws: true`).
  // In production, the same /api path is served by the API directly.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  return fromOffset ? `${base}?fromOffset=${encodeURIComponent(fromOffset)}` : base;
}

export function useSessionWebSocket(sessionId: string) {
  const setConnection = useStreamStore((s) => s.setConnection);
  const ingest = useStreamStore((s) => s.ingest);
  const reset = useStreamStore((s) => s.reset);

  useEffect(() => {
    if (!sessionId) return;
    // Per-effect-run cancellation flag. Must be a closure local, NOT a
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
    let retryDelay = INITIAL_RETRY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function open() {
      if (cancelled) return;
      const lastOffset = useStreamStore.getState().bySession[sessionId]?.lastOffset;
      socket = new WebSocket(wsUrl(sessionId, lastOffset || undefined));
      socket.onopen = () => {
        retryDelay = INITIAL_RETRY_MS;
        setConnection(sessionId, "open");
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
        } catch (err) {
          console.error("ws parse failed:", err);
        }
      };
      socket.onerror = () => {
        // The matching onclose will trigger the reconnect.
        setConnection(sessionId, "error");
      };
      socket.onclose = () => {
        if (cancelled) return;
        setConnection(sessionId, "closed");
        retryTimer = setTimeout(open, retryDelay);
        retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
      };
    }

    open();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
    // We intentionally exclude the store actions from the dep list — Zustand
    // returns stable function refs per call but TypeScript can't prove that.
    // The hook only re-runs when sessionId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
}
