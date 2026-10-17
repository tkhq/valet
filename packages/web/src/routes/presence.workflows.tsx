import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/presence/workflows` layout: a thin `<Outlet/>` boundary, so its two
 * children (`presence.workflows.index.tsx`, `presence.workflows.$workflowId.tsx`)
 * nest under it. Both children redirect to `/workflows*`
 * (`-presence-redirects.ts`) now that Workflows has its own top-nav entry
 * again. This layout itself holds no `beforeLoad`: a parent's `beforeLoad`
 * runs for every child URL too, so a redirect here would fire before a
 * child's own (and send `/presence/workflows/$workflowId` to the bare list,
 * dropping the id) — each leaf redirects for itself instead. */
export const Route = createFileRoute("/presence/workflows")({
  component: () => <Outlet />,
});
