/**
 * Refetch the session + threads queries whenever a `model_switched` wire
 * event arrives. The picker's own mutation invalidates these queries, but a
 * switch made by the `/model` slash command or a direct API call reaches the
 * client only as a wire event — without this hook the header picker keeps
 * showing the old model until a manual reload.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";

export function useInvalidateSessionOnModelSwitch(sessionId: string | undefined): void {
  const qc = useQueryClient();
  const nonce = useStreamStore((s) =>
    sessionId ? (s.bySession?.[sessionId]?.modelSwitchNonce ?? 0) : 0,
  );

  useEffect(() => {
    if (!sessionId || nonce === 0) return;
    void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.threads(sessionId) });
  }, [qc, sessionId, nonce]);
}
