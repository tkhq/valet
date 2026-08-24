import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/design` layout — pass-through shell so child routes render (same
 * route-tree wiring as `sessions.tsx`). The hub lives in `design.index.tsx`.
 */
export const Route = createFileRoute("/design")({
  component: () => <Outlet />,
});
