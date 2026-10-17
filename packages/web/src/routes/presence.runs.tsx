import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/presence/runs` layout: a thin `<Outlet/>` boundary, so its two children
 * (`presence.runs.index.tsx`, `presence.runs.$runId.tsx`) nest under it.
 * Both children redirect to `/workflows/runs*` (`-presence-redirects.ts`)
 * now that Workflows and its Runs view have their own top-nav entry again.
 * This layout itself holds no `beforeLoad`, for the same reason
 * `presence.workflows.tsx` gives. */
export const Route = createFileRoute("/presence/runs")({
  component: () => <Outlet />,
});
