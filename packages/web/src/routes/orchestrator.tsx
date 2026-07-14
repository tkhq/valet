import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

/**
 * "/orchestrator" — legacy entry point, now a plain redirect to the
 * assistant dashboard (assistant-centered web UI, decision 1). The
 * dashboard itself handles ensuring/naming the orchestrator; this route
 * has no UI of its own.
 */
export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorRedirect,
});

function OrchestratorRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to: "/", replace: true });
  }, [navigate]);

  return null;
}
