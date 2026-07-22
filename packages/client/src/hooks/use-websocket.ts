import { useEffect, useRef, useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth';
import { getWebSocketUrl } from '@/api/client';

type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

const WS_OPEN = 1;

/**
 * How long a socket may sit in CONNECTING before we give up on it. A hung
 * handshake never fires onopen, onerror or onclose, so without this the client
 * waits forever.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Exponential backoff with jitter, capped at 30s. */
export function getReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
  return baseDelay + baseDelay * 0.2 * random();
}

/**
 * Closes a socket the hook has finished with, detaching the handlers first so
 * its teardown events cannot land on state that has already moved on.
 */
function closeSocketQuietly(ws: WebSocket) {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  ws.close();
}

export function sendWebSocketMessage(
  socket: Pick<WebSocket, 'readyState' | 'send'> | null,
  message: WebSocketMessage,
): boolean {
  if (socket?.readyState !== WS_OPEN) {
    return false;
  }

  const payload = JSON.stringify(message);
  if (payload.length > 30_000_000) {
    console.warn(`[ws] payload very large: ${(payload.length / 1_000_000).toFixed(1)} MB`);
  }

  try {
    socket.send(payload);
    return true;
  } catch (err) {
    console.error('[ws] send failed:', err);
    return false;
  }
}

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  /** Abandon a handshake that has not opened within this many milliseconds. */
  connectTimeoutMs?: number;
}

export function useWebSocket(url: string | null, options: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onConnect,
    onDisconnect,
    onError,
    reconnect = true,
    maxReconnectAttempts = 10,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  // True once the retry budget is spent, so the UI can offer a manual retry
  // instead of leaving the user with a connection that will never come back.
  const [retriesExhausted, setRetriesExhausted] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);

  // Store callbacks in refs to avoid triggering reconnection when they change
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  // Update refs when callbacks change (doesn't trigger reconnect)
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onMessage, onConnect, onDisconnect, onError]);

  const token = useAuthStore((state) => state.token);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current !== null) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!url || !token) return;

    setStatus('connecting');
    setRetriesExhausted(false);

    const wsUrlStr = getWebSocketUrl(url);
    const wsUrl = new URL(wsUrlStr);

    const ws = new WebSocket(wsUrl.toString(), ['valet', `bearer.${token}`]);

    // Schedules the next attempt, or gives up and surfaces an error state once
    // the budget is spent. Shared by onclose and the connect-timeout path.
    const scheduleReconnect = () => {
      if (!reconnect || reconnectAttemptsRef.current >= maxReconnectAttempts) {
        if (reconnect) {
          setStatus('error');
          setRetriesExhausted(true);
        }
        return;
      }
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current += 1;
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, getReconnectDelay(attempt));
    };

    // A handshake that never completes fires no events at all, so the socket
    // must be abandoned on a timer. Detach the handlers before closing so the
    // teardown runs exactly once regardless of whether onclose fires.
    connectTimeoutRef.current = window.setTimeout(() => {
      connectTimeoutRef.current = null;
      if (ws.readyState === WS_OPEN || wsRef.current !== ws) return;

      console.warn(`[ws] connect timed out after ${connectTimeoutMs}ms, retrying`);
      closeSocketQuietly(ws);
      wsRef.current = null;

      setStatus('disconnected');
      onDisconnectRef.current?.();
      scheduleReconnect();
    }, connectTimeoutMs);

    ws.onopen = () => {
      clearConnectTimeout();
      setStatus('connected');
      reconnectAttemptsRef.current = 0;
      setRetriesExhausted(false);
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        onMessageRef.current?.(message);
      } catch {
        console.error('Failed to parse WebSocket message:', event.data);
      }
    };

    ws.onerror = (event) => {
      setStatus('error');
      onErrorRef.current?.(event);
    };

    ws.onclose = () => {
      // If a newer WebSocket has already replaced this one (e.g. session navigation
      // triggered disconnect + reconnect), skip all handling to avoid clobbering the
      // new connection's state and triggering a stale reconnect to the old URL.
      if (wsRef.current !== null && wsRef.current !== ws) return;

      clearConnectTimeout();
      setStatus('disconnected');
      wsRef.current = null;
      onDisconnectRef.current?.();
      scheduleReconnect();
    };

    wsRef.current = ws;
  }, [url, token, reconnect, maxReconnectAttempts, connectTimeoutMs, clearConnectTimeout]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    clearConnectTimeout();
    reconnectAttemptsRef.current = maxReconnectAttempts;
    if (wsRef.current) {
      // An intentional teardown must not be mistaken for a lost connection and
      // reported as an error the user is asked to recover from.
      closeSocketQuietly(wsRef.current);
      wsRef.current = null;
    }
    setStatus('disconnected');
    setRetriesExhausted(false);
  }, [maxReconnectAttempts, clearConnectTimeout]);

  /** Manual escape hatch: drop whatever is there and start over with a fresh budget. */
  const reconnectNow = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    clearConnectTimeout();
    if (wsRef.current) {
      closeSocketQuietly(wsRef.current);
      wsRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    setRetriesExhausted(false);
    connect();
  }, [connect, clearConnectTimeout]);

  const send = useCallback((message: WebSocketMessage) => {
    return sendWebSocketMessage(wsRef.current, message);
  }, []);

  useEffect(() => {
    // Reset reconnect counter whenever the connection target changes so that
    // a prior session's exhausted retries don't prevent reconnection to a new
    // session.  disconnect() intentionally sets the counter to maxReconnectAttempts
    // to suppress retries during teardown, but we need a fresh budget here.
    reconnectAttemptsRef.current = 0;

    if (url && token) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [url, token, connect, disconnect]);

  return {
    status,
    send,
    connect,
    disconnect,
    reconnect: reconnectNow,
    retriesExhausted,
    isConnected: status === 'connected',
  };
}
