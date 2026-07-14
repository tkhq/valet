import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/workflows` layout shell (plan decision 19). Thin — just an `<Outlet/>`
 * boundary so `/workflows` (list, `workflows.index.tsx`) and
 * `/workflows/runs/$runId` (`workflows.runs.$runId.tsx`) both nest under it
 * without either page needing to double as the other's parent (mirrors
 * `memory.tsx`/`memory.index.tsx`/`memory.$.tsx`).
 */
export const Route = createFileRoute("/workflows")({
  component: () => <Outlet />,
});
