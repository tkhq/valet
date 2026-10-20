import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/events` layout shell. It holds no redirect: a parent `beforeLoad` runs
 * for every child URL too, so each child route redirects for itself
 * (`-presence-redirects.ts`).
 *
 * The shell is an `<Outlet/>` boundary, so `/events` (`events.index.tsx`)
 * and `/events/$eventId` (`events.$eventId.tsx`) nest under it without
 * either route acting as the other's parent. `workflows.tsx` has the same
 * shape.
 */
export const Route = createFileRoute("/events")({
  component: () => <Outlet />,
});
