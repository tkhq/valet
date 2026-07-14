import { useEffect } from "react";
import { SessionView } from "./session-view";

/**
 * Right-hand slide-over (assistant-centered web UI, decision 13): a child
 * session opened "in place" over the chat's right side — its own live
 * transcript, gates resolvable there, an "open full page" affordance.
 * Implemented by mounting `SessionView` with `variant="panel"`; the panel
 * itself owns the fixed-position chrome (~480px, full-height, hairline
 * border). Closing returns to the assistant with no navigation.
 */
export function ChildPanel({
  childId,
  onClose,
}: {
  childId: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Child session"
      className="fixed top-14 bottom-0 right-0 z-40 flex w-[480px] flex-col border-l border-line bg-paper shadow-lg"
    >
      <SessionView sessionId={childId} variant="panel" onClose={onClose} />
    </div>
  );
}
