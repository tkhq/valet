import { Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { AppShell } from "~/components/layout/app-shell";
import { TopNav } from "~/components/layout/top-nav";
import { ThreadTree } from "~/components/session/thread-tree";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

/**
 * Which sidebar (if any) the current route gets, per assistant-centered
 * web UI decisions 12/14. This is a root-layout concern rather than
 * something each route/`SessionView` renders itself, because the sidebar
 * lives in the app shell's `<aside>`, outside the routed `<main>` content.
 *
 * - `/chat` — the nested thread-tree (children grouped under their
 *   spawning thread), replacing the flat thread list.
 * - everything else (`/`, `/sessions`, `/sessions/$sessionId`,
 *   `/memory` and `/memory/*`, …) — no app sidebar. Standalone sessions
 *   have no thread UI (decision 14); the memory explorer renders its own
 *   tree pane inside the route (Task 6); the dashboard and session list
 *   have no thread concept at all. The old flat `ThreadList` sidebar that
 *   used to cover this "everything else" bucket is dead — deleted.
 */
function sidebarForPath(pathname: string) {
  if (pathname === "/chat") return <ThreadTree />;
  return null;
}

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <TooltipProvider>
      <AppShell topNav={<TopNav />} sidebar={sidebarForPath(pathname)}>
        <Outlet />
      </AppShell>
    </TooltipProvider>
  );
}
