import { useShallow } from "zustand/react/shallow";
import { useStreamStore } from "~/stores/stream";

/**
 * Live gate state for the sessions a caller renders rows for: a key exists
 * only while that session's WS is open, and its value says whether any
 * decision gate is pending there (any thread). Sessions without an open
 * socket are absent — their slice, if one lingers from an earlier visit,
 * stops receiving `gate.*` frames the moment the socket closes, so its
 * gate set can be stale in either direction. Callers fall back to the
 * notifications poll for those (`attentionSessionIds`).
 *
 * Why `conn === "open"` is enough to trust the store: the only
 * `useSessionWebSocket` caller is `SessionView`, which also seeds
 * `pendingGates` from REST (`usePendingGatesSeed`) — so an open
 * connection's gate set covers gates raised before the socket existed,
 * not just the frames that arrived while connected.
 *
 * The selector projects to a `Record<string, boolean>` so `useShallow` can
 * suppress re-renders: the raw slice identities churn on every text delta,
 * but this record only changes when a socket opens/closes or a gate
 * opens/settles.
 */
export function useLivePendingGates(
  sessionIds: readonly string[],
): Readonly<Record<string, boolean>> {
  return useStreamStore(
    useShallow((s) => {
      const out: Record<string, boolean> = {};
      for (const id of sessionIds) {
        const slice = s.bySession[id];
        if (slice?.conn !== "open") continue;
        out[id] = Object.keys(slice.pendingGates).length > 0;
      }
      return out;
    }),
  );
}
