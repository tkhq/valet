import { useEffect } from "react";
import { Link, Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { AppShell } from "~/components/layout/app-shell";
import { TopNav } from "~/components/layout/top-nav";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { AssistantRail } from "~/components/session/assistant-rail";
import { useAttentionPing } from "~/lib/use-attention-ping";
import { unlock } from "~/lib/notification-sound";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

/**
 * In-voice 404 — the assistant is the app's anchor (decision 9), so the
 * "not found" copy points back at it rather than a generic error page.
 * Rendered inside the same `AppShell`/`TopNav` chrome as every other route
 * (via `RootLayout`'s `<Outlet/>` boundary), so it isn't a bare white page.
 */
function NotFound() {
  return (
    <div className="flex-1 grid place-items-center p-8 text-center">
      <div className="max-w-sm space-y-3">
        <div className="font-display text-2xl text-ink">This page doesn't exist.</div>
        <p className="text-sm text-muted">The dashboard does.</p>
        <Link
          to="/"
          className="inline-flex rounded px-3 py-1.5 text-sm text-moss hover:underline"
        >
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

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
  if (pathname === "/chat") return <AssistantRail />;
  return null;
}

/** `/login`, `/signup` — public, unauthenticated. They render standalone
 * (no `TopNav`/`AppShell` chrome, which assumes a signed-in session) so an
 * unauthenticated visitor never sees app nav before they can sign in. */
const PUBLIC_ROUTES = new Set(["/login", "/signup"]);

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublic = PUBLIC_ROUTES.has(pathname);

  if (isPublic) {
    return (
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    );
  }

  // Inside the signed-in branch only: the provider reads assistants and
  // teams, which a signed-out visitor cannot fetch.
  return (
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SignedInEffects />
        <AppShell topNav={<TopNav />} sidebar={sidebarForPath(pathname)}>
          <Outlet />
        </AppShell>
      </WorkspaceScopeProvider>
    </TooltipProvider>
  );
}

/**
 * Effects that belong to the whole signed-in app rather than any one page.
 * Rendered as a component (not hooks in `RootLayout`) because the public
 * routes return before the shell, and a hook above that branch would run
 * for a signed-out visitor and poll endpoints they cannot call.
 */
function SignedInEffects() {
  useAttentionPing();
  useUnlockAudioOnFirstGesture();
  return null;
}

/**
 * Browsers refuse to play audio until the page has seen a real user
 * gesture, so the first time the assistant needs you could be silent — the
 * one time it matters most. Resume the context on the first interaction of
 * the session, then stop listening.
 */
function useUnlockAudioOnFirstGesture() {
  useEffect(() => {
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown"];
    const onGesture = () => {
      unlock();
      for (const e of events) window.removeEventListener(e, onGesture);
    };
    for (const e of events) window.addEventListener(e, onGesture, { once: false });
    return () => {
      for (const e of events) window.removeEventListener(e, onGesture);
    };
  }, []);
}
