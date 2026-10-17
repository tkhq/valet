import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/presence/runs` layout: a thin `<Outlet/>` boundary, so the Runs tab
 * (`presence.runs.index.tsx`) and one run (`presence.runs.$runId.tsx`) nest
 * under it. */
export const Route = createFileRoute("/presence/runs")({
  component: () => <Outlet />,
});
