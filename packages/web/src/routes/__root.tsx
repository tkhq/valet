import { useWebPresence } from "~/api/web-presence";
import { AUTH_CHANGE_KEY } from "~/lib/auth-navigation";
import { WorkspaceAssistantProvider, WorkspaceAssistantDock } from "~/components/layout/workspace-assistant";
import { ApiError } from "~/api/client";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useMe } from "~/api/settings";
import { useReportTimezoneOnce } from "~/lib/report-timezone";
import { useComposerDraftStore } from "~/stores/composer-drafts";
import { Link, Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { ErrorRow, LoadingRow } from "~/components/primitives/query-state";
import { ProductAnnouncement } from "~/components/product-announcement";
import { AppShell } from "~/components/layout/app-shell";
import { TopNav } from "~/components/layout/top-nav";
import { MobileTopNav } from "~/components/layout/mobile-top-nav";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { AppDrawer } from "~/components/layout/app-drawer";
import { AssistantRail } from "~/components/session/assistant-rail";
import { useMobileLayout } from "~/hooks/use-mobile-layout";
import { KeyboardShortcutsDialog } from "~/components/session/keyboard-shortcuts-dialog";
import { useChatKeybindings } from "~/hooks/use-chat-keybindings";
import { useAttentionPing } from "~/lib/use-attention-ping";
import { unlock } from "~/lib/notification-sound";
import { UI_STRESS_PATH, UiStressShell, uiStressEnabled } from "~/dev/ui-stress/gate";

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
  const mobile = useMobileLayout();
  return (
    <div className="flex-1 grid place-items-center p-8 text-center">
      <div className="max-w-sm space-y-3">
        <h1 className="font-display text-2xl text-ink">This page doesn’t exist.</h1>
        <p className="text-sm text-muted">{mobile ? "Valet is on Home." : "The dashboard does."}</p>
        <Link
          to="/"
          className="inline-flex rounded px-3 py-1.5 text-sm text-moss hover:underline"
        >
          {mobile ? "Back to Home" : "Back to the dashboard"}
        </Link>
      </div>
    </div>
  );
}

/**
 * Which sidebar (if any) a route gets on a wider screen, per assistant-centered
 * web UI decisions 12/14. This is a root-layout concern rather than
 * something each route/`SessionView` renders itself, because the sidebar
 * lives in the app shell's `<aside>`, outside the routed `<main>` content.
 *
 * - `/chat` — the nested thread-tree (children grouped under their
 *   spawning thread), replacing the flat thread list.
 * - everything else (`/`, `/sessions/$sessionId`,
 *   `/memory` and `/memory/*`, …) — no app sidebar. Standalone sessions
 *   have no thread UI (decision 14); the memory explorer renders its own
 *   tree pane inside the route (Task 6); the dashboard and session list
 *   have no thread concept at all.
 *
 * A phone gets the drawer (`AppDrawer`) on every page instead.
 */
function sidebarForPath(pathname: string) {
  if (pathname === "/chat" || isUiStressPath(pathname)) return <AssistantRail />;
  return null;
}

/** The development-only UI stress gallery, in any letter case, with or
 * without a trailing slash. Always false in a production build, where `UiStressShell` is null. */
function isUiStressPath(pathname: string): boolean {
  // The router matches paths without regard to case, so this check does too.
  return UiStressShell !== null && pathname.replace(/\/+$/, "").toLowerCase() === UI_STRESS_PATH && uiStressEnabled();
}

/** `/login`, `/signup`, and the shared-artifact reader `/a/$token` —
 * public, unauthenticated. They render standalone (no `TopNav`/`AppShell`
 * chrome, which assumes a signed-in session) so an unauthenticated visitor
 * never sees app nav before they can sign in. */
const PUBLIC_ROUTES = new Set(["/login", "/signup"]);

/** Approval pages for an app or the CLI. They need a session (their API
 * calls send a signed-out visitor to `/login?next=`), but render without app
 * chrome so the decision is the only thing on the page. */
const APPROVAL_ROUTES = new Set(["/oauth/consent", "/cli/device"]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTES.has(pathname) || APPROVAL_ROUTES.has(pathname) || pathname.startsWith("/a/");
}

function RootLayout() {
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGE_KEY) window.location.reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mobile = useMobileLayout();
  const isPublic = isPublicPath(pathname);

  if (isPublic) {
    return (
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    );
  }

  // Inside the signed-in branch only: the provider reads assistants and
  // teams, which a signed-out visitor cannot fetch.
  const gallery = UiStressShell !== null && isUiStressPath(pathname);
  // A phone gets the phone UI: its own top bar, and the drawer (Home and the
  // threads) on every page. A wider screen keeps the web UI: the top bar with
  // every page, the thread sidebar on /chat, and the Ask Valet panel.
  const shell = mobile
    ? <AppShell topNav={<MobileTopNav />} sidebar={<AppDrawer />}>
      {/* Keybindings must sit under AppShell so sidebar controls resolve. */}
      <ChatKeybindingsHost />
      <Outlet />
    </AppShell>
    : <AppShell topNav={<TopNav />} sidebar={sidebarForPath(pathname)} rightPanel={<WorkspaceAssistantDock />}>
      <ChatKeybindingsHost />
      <Outlet />
    </AppShell>;
  const app = (
    <WorkspaceScopeProvider persist={!gallery}>
      <WorkspaceAssistantProvider>
        <SignedInEffects />
        <ProductAnnouncement />
        {shell}
      </WorkspaceAssistantProvider>
    </WorkspaceScopeProvider>
  );
  // The gallery puts the whole shell on its frozen fixture client, so the
  // nav, the bell, and the sidebar show stress data too. It skips
  // DraftAccountBoundary: the fixture account must not replace the real
  // account's drafts, which keep their attachments in memory only.
  if (UiStressShell && gallery) {
    return <Suspense fallback={null}><UiStressShell><TooltipProvider>{app}</TooltipProvider></UiStressShell></Suspense>;
  }
  return <TooltipProvider><DraftAccountBoundary>{app}</DraftAccountBoundary></TooltipProvider>;
}

/**
 * Effects that belong to the whole signed-in app rather than any one page.
 * Rendered as a component (not hooks in `RootLayout`) because the public
 * routes return before the shell, and a hook above that branch would run
 * for a signed-out visitor and poll endpoints they cannot call.
 */
function SignedInEffects() {
  useWebPresence();
  useAttentionPing();
  useUnlockAudioOnFirstGesture();
  return null;
}

/**
 * Claude-aligned chat chords + the ⌘/ shortcuts dialog. Mounted as a child
 * of `AppShell` so `useSidebarControls` is in scope for ⌘⇧S.
 */
function ChatKeybindingsHost() {
  const { helpOpen, setHelpOpen } = useChatKeybindings();
  return <KeyboardShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />;
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

/** Mount composers only after their draft namespace matches the authenticated account. */
export function DraftAccountBoundary({ children }: { children: ReactNode }) {
  const me = useMe({ staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: "always" });
  useReportTimezoneOnce(me.error ? undefined : me.data);
  const owner = me.data ? JSON.stringify([me.data.orgId, me.data.id]) : "";
  const activeOwner = useComposerDraftStore((s) => s.owner);
  const [verifiedOwner, setVerifiedOwner] = useState("");
  const unauthorized = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
  useEffect(() => {
    if (unauthorized) setVerifiedOwner("");
    else if (!me.isFetching && !me.error && owner) {
      useComposerDraftStore.getState().activateOwner(owner);
      setVerifiedOwner(owner);
    }
  }, [owner, me.isFetching, me.error, unauthorized]);
  // Centered on the page background: these show for a moment on every load.
  if (unauthorized || (me.error && verifiedOwner !== owner)) return <div className="grid min-h-dvh place-items-center bg-paper px-4"><ErrorRow>Could not load your account. Reload the page to try again.</ErrorRow></div>;
  if (!owner || activeOwner !== owner || verifiedOwner !== owner) return <div role="status" className="grid min-h-dvh place-items-center bg-paper"><LoadingRow label="Loading your account…" /></div>;
  return <>
    {me.error && <p role="status">Connection interrupted. Reconnect to sync your work.</p>}
    <div key={owner} className="contents">{children}</div>
  </>;
}
