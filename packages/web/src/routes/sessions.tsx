import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/sessions` layout — pass-through shell so child routes actually render.
 * The list itself lives in `sessions.index.tsx`; without this Outlet the
 * parent swallowed `/sessions/$sessionId` and the detail page never
 * mounted (same route-tree wiring bug the memory explorer hit — component
 * tests can't catch it, only a routed render can).
 */
export const Route = createFileRoute("/sessions")({
  component: () => <Outlet />,
});
