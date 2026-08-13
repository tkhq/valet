import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/events` layout shell. Thin — just an `<Outlet/>` boundary so `/events`
 * (the feed and subscriptions tabs, `events.index.tsx`) and
 * `/events/$eventId` (one event at its own URL, `events.$eventId.tsx`) nest
 * under it without either page doubling as the other's parent. Same shape as
 * `workflows.tsx`/`workflows.index.tsx`/`workflows.$workflowId.tsx`.
 */
export const Route = createFileRoute("/events")({
  component: () => <Outlet />,
});
