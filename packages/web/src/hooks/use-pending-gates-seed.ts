import { useEffect } from "react";
import { useDecisions } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";

/**
 * Seeds the stream store's `pendingGates` from REST so pending gates show
 * immediately on load; later gates arrive via the wire (`gate.*` frames).
 *
 * Every surface that READS `pendingGates` must call this, so no surface
 * depends on a sibling being mounted: SessionView (gate card) and
 * ThreadTree (per-thread needs-you dot, TKAI-258) each seed for
 * themselves. Double-mounting is free — the query is deduped by key and
 * `setPendingGates` keeps the record identity for equal content.
 */
export function usePendingGatesSeed(sessionId: string): void {
  const decisionsQ = useDecisions(sessionId);
  const setPendingGates = useStreamStore((s) => s.setPendingGates);
  useEffect(() => {
    if (!decisionsQ.data) return;
    setPendingGates(
      sessionId,
      decisionsQ.data.gates.filter((g) => g.status === "pending"),
    );
  }, [sessionId, decisionsQ.data, setPendingGates]);
}
