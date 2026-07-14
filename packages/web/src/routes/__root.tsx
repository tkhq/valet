import { Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { AppShell } from "~/components/layout/app-shell";
import { TopNav } from "~/components/layout/top-nav";
import { ThreadList } from "~/components/session/thread-list";
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
 * - `/sessions/$sessionId` — no sidebar at all (decision 14: standalone
 *   sessions have no thread UI).
 * - everything else — the existing flat `ThreadList` (a no-op placeholder
 *   off session routes; unchanged from Task 3/4).
 */
function sidebarForPath(pathname: string) {
  if (pathname === "/chat") return <ThreadTree />;
  if (/^\/sessions\/[^/]+$/.test(pathname)) return null;
  return <ThreadList />;
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
