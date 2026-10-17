import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/presence/workflows` layout: a thin `<Outlet/>` boundary, so the Workflows tab
 * (`presence.workflows.index.tsx`) and one workflow
 * (`presence.workflows.$workflowId.tsx`) nest under it. */
export const Route = createFileRoute("/presence/workflows")({
  component: () => <Outlet />,
});
