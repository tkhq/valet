/**
 * Refetch the messages query whenever a `compaction_end` wire event
 * arrives. The engine persists the `CompactionEntry` before it emits the
 * event, and REST is the authoritative history source — the refetch is what
 * makes the compaction divider appear without a manual reload.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";

export function useInvalidateMessagesOnCompaction(sessionId: string | undefined): void {
  const qc = useQueryClient();
  const nonce = useStreamStore((s) =>
    sessionId ? (s.bySession?.[sessionId]?.compactionNonce ?? 0) : 0,
  );

  useEffect(() => {
    if (!sessionId || nonce === 0) return;
    // `qk.messages(sessionId)` is a prefix of every per-thread messages key,
    // and invalidateQueries prefix-matches by default.
    void qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
  }, [qc, sessionId, nonce]);
}
