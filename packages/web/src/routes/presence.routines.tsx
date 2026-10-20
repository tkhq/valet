import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/presence/routines`: the layout over one routine's page,
 * `/presence/routines/$id`. The bare URL holds no page: its index route
 * redirects to the overview (`presence.routines.index.tsx`). */
export const Route = createFileRoute("/presence/routines")({
  component: Outlet,
});
