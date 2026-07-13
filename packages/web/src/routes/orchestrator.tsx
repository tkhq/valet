import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "~/api/client";
import { Spinner } from "~/components/primitives";

/**
 * "/orchestrator" — the nav "Assistant" entry point (decision 22). Ensures
 * the caller's user-orchestrator exists (instant sandbox-less wake) then
 * redirects to the normal session view for that id. No UI of its own
 * besides a brief loading state; the session route renders everything.
 */
export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorEntry,
});

function OrchestratorEntry() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .ensureOrchestrator()
      .then(({ sessionId }) => {
        if (cancelled) return;
        navigate({
          to: "/sessions/$sessionId",
          params: { sessionId },
          replace: true,
        });
      })
      .catch((err) => {
        console.error("failed to ensure orchestrator session:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="flex-1 grid place-items-center text-sm text-[--muted]">
      <Spinner /> Waking Assistant…
    </div>
  );
}
