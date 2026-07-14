/**
 * CRITICAL (Task 1 flag): signal entries (e.g. `child.settled`) reach the
 * client via REST only — no live WS event carries the signal payload
 * itself, and `useMessages` disables background refetch (window
 * focus/reconnect) to protect in-flight optimistic/live state (see
 * `~/api/queries`). Without this hook a signal would sit unrendered until
 * the user manually reloads the chat page.
 *
 * `queue.state` is a cheap, already-flowing wire event that fires whenever
 * a thread's submission queue changes — including when a turn settles,
 * which is exactly when a signal (e.g. from a child settling) would have
 * been appended to the transcript. We treat any `queue.state` frame for the
 * assistant's session as a cue to refetch the messages REST query,
 * debounced so a burst of frames (multiple children settling close
 * together) only triggers one refetch.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";
import { createDebouncer } from "~/lib/debounce";

export const QUEUE_STATE_INVALIDATE_DEBOUNCE_MS = 500;

export function useInvalidateMessagesOnQueueState(
  sessionId: string | undefined,
  threadId: string | undefined,
  delayMs: number = QUEUE_STATE_INVALIDATE_DEBOUNCE_MS,
): void {
  const qc = useQueryClient();
  // Object identity changes on every `queue.state` ingest (see the
  // reducer's `queue.state` case in `~/stores/stream`) — that identity
  // change is the "an event arrived" signal this effect reacts to.
  const queueByThread = useStreamStore((s) =>
    sessionId ? s.bySession[sessionId]?.queueByThread : undefined,
  );

  const debouncerRef = useRef<ReturnType<typeof createDebouncer> | null>(null);

  useEffect(() => {
    const debouncer = createDebouncer(() => {
      if (!sessionId) return;
      qc.invalidateQueries({ queryKey: qk.messages(sessionId, threadId) });
    }, delayMs);
    debouncerRef.current = debouncer;
    return () => debouncer.cancel();
  }, [qc, sessionId, threadId, delayMs]);

  useEffect(() => {
    if (!queueByThread) return;
    debouncerRef.current?.trigger();
  }, [queueByThread]);
}
