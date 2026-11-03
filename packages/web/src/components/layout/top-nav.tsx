import { useEffect, useRef, useState } from "react";
import { useWorkspaceAssistant } from "./workspace-assistant";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, Menu, Sparkles, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from "lucide-react";
import { useChangelog } from "~/api/changelog";
import { useSession } from "~/api/queries";
import { pluginEnabledForCaller, useMe, useOrg } from "~/api/settings";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, StatusDot } from "~/components/primitives";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { cn } from "~/lib/cn";
import { useLastSeenCheckpoint } from "~/lib/changelog-read-state";
import { useSidebarControls } from "./app-shell";
import { NotificationsBell } from "./notifications-bell";


/**
 * Top-nav link with a working active state. Text color lives in
 * `activeProps`/`inactiveProps` — NOT the base className — because TanStack
 * Router concatenates `activeProps.className` onto the base, and two
 * conflicting Tailwind text colors resolve by stylesheet order, not by
 * which was added last (the old `text-muted` base + `text-ink` active pair
 * rendered no visible active state at all).
 */
/** One look for every control in the bar: links, the Plugins menu, and Ask
 * Valet. It matches the `sm` control height with the nav's text size. */
const NAV_BASE = "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded px-2 text-sm hover:bg-ink-wash";
const NAV_ACTIVE = "text-ink font-medium bg-ink-wash";
const NAV_INACTIVE = "text-muted hover:text-ink";

function NavLink({
  to,
  children,
  active,
}: {
  to: string;
  children: React.ReactNode;
  /** Force the active state instead of the URL-match default. Used so a
   * `/sessions/:id` security session lights "Security" —
   * the URL alone cannot tell the two apart (both live under /sessions). */
  active?: boolean;
}) {
  // `shrink-0` + `whitespace-nowrap`: the row scrolls when it does not fit,
  // so a link must keep its own width instead of being squeezed into a
  // wrapped two-line label.
  const base = NAV_BASE;
  if (active !== undefined) {
    return (
      <Link to={to} className={`${base} ${active ? NAV_ACTIVE : NAV_INACTIVE}`}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to={to}
      className={base}
      activeProps={{ className: NAV_ACTIVE }}
      inactiveProps={{ className: NAV_INACTIVE }}
    >
      {children}
    </Link>
  );
}

/**
 * The sidebar toggle, at the nav's left edge — the first thing in the row,
 * ahead of the logo, which is where Linear, Notion and VS Code put it.
 *
 * It lives here rather than floating over the sidebar so that it occupies
 * layout instead of overlapping it; the old floated version covered the
 * assistants rail's "New assistant" button. See `SidebarControls`.
 *
 * Two buttons, not one, because they do different things and must say so:
 * on mobile the sidebar is out of the flow and opens as a drawer, while on
 * desktop it collapses in place. One button with a width-dependent label
 * would announce the wrong action to a screen reader at one of the two
 * widths.
 *
 * Renders nothing when there is no sidebar to control, including outside an
 * `AppShell` entirely.
 */
function SidebarToggle() {
  const controls = useSidebarControls();
  if (controls === null) return null;

  const buttonClass =
    "shrink-0 min-h-8 min-w-8 max-md:min-h-11 max-md:min-w-11 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none";

  // On a phone the thread list is one tap from every page: a page without
  // the thread sidebar links to Threads with the list already open.
  if (!controls.present) {
    return (
      <Link to="/chat" search={{ threads: "open" }} aria-label="Open threads" className={`md:hidden inline-flex ${buttonClass}`}>
        <PanelLeftOpen className="h-4 w-4" aria-hidden />
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open threads"
        onClick={controls.openDrawer}
        className={`md:hidden inline-flex ${buttonClass}`}
      >
        <PanelLeftOpen className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}

export function TopNav() {
  const assistant = useWorkspaceAssistant();
  const mobileNav = useResponsiveOverlay("md");
  const orgQ = useOrg();
  const meQ = useMe();
  const changelogQ = useChangelog();
  const newestCheckpoint = changelogQ.data?.manifest.checkpoints[0];
  const seenCheckpoint = useLastSeenCheckpoint(meQ.data?.id);
  const changelogUnread = !!meQ.data && !!newestCheckpoint && seenCheckpoint !== newestCheckpoint.id;
  // A security session lives at /sessions/:id like any other, so the URL
  // cannot distinguish it — read the id off the path and check its kind so
  // the nav lights "Security". The query is shared
  // with the session page's own read, so it costs no extra request.
  const sessionRouteId = useRouterState({
    select: (st) => {
      const m = /^\/sessions\/([^/]+)$/.exec(st.location.pathname);
      return m ? m[1] : undefined;
    },
  });
  const routeSession = useSession(sessionRouteId ?? "");
  const onSecuritySession = routeSession.data?.kind === "security";
  const onSecurityPage = useRouterState({ select: (st) => st.location.pathname.startsWith("/security") });
  // Gate the Security link on the `security` plugin's entitlement for this
  // caller. `undefined` (org not yet loaded) hides the link — no flash of a
  // link the caller may not have, matching the settings rail's no-flash rule.
  const securityEnabled = pluginEnabledForCaller(orgQ.data, "security") === true;
  // Threads, Workflows, Presence and Artifacts belong to a space: the
  // sidebar lists them under each space. The bar keeps the global pages.
  const destinations: Array<{ to: string; label: string; active?: boolean }> = [
    { to: "/chat", label: "Threads" },
    { to: "/artifacts", label: "Artifacts" },
    { to: "/presence", label: "Presence" },
    { to: "/workflows", label: "Workflows" },
  ];
  const more: Array<{ to: string; label: string; active?: boolean }> = [
    { to: "/memory", label: "Memory" },
    { to: "/skills", label: "Skills" },
    { to: "/integrations", label: "Integrations" },
    { to: "/usage", label: "Usage" },
    { to: "/changelog", label: "Changelog" },
  ];
  const onMore = useRouterState({ select: (st) => more.some(({ to }) => st.location.pathname.startsWith(to)) });
  const destinationLabel = (label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {(label === "Changelog" || label === "More") && changelogUnread && (
        <StatusDot tone="accent" size="sm" label="New releases" />
      )}
    </span>
  );

  return (
    <header className="max-sm:[--nav-height:3rem] h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-1 px-2 md:gap-4 md:px-3">
      <SidebarToggle />

      {/* On a phone the menu carries Home, so the mark would repeat it. */}
      <Link
        to="/"
        className="hidden min-h-8 min-w-8 shrink-0 items-center justify-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash md:inline-flex"
        aria-label="Valet — Home"
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <span className="hidden font-display text-sm font-medium text-ink md:inline">Valet</span>
      </Link>

      {/* No page links or space control here: the sidebar lists each space
          and its pages. */}
      <div className="hidden min-w-0 flex-1 md:block" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(NAV_BASE, "hidden gap-1 md:inline-flex", onMore ? NAV_ACTIVE : NAV_INACTIVE)}>
            {destinationLabel("More")} <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="More pages" className="w-48">
          {more.map(({ to, label }) => <DropdownMenuItem key={to} asChild><Link to={to}>{destinationLabel(label)}</Link></DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(NAV_BASE, "hidden gap-1 md:inline-flex", onSecurityPage || onSecuritySession ? NAV_ACTIVE : NAV_INACTIVE)}>
            Plugins <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Plugins" className="w-56">
          {securityEnabled ? <DropdownMenuItem asChild>
            <Link to="/security"><ShieldCheck className="h-4 w-4" aria-hidden />Valet Security</Link>
          </DropdownMenuItem> : <div className="px-2 py-3 text-xs text-muted">No plugins available.</div>}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto shrink-0 md:hidden">
        <DropdownMenu open={mobileNav.open} onOpenChange={mobileNav.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Open navigation" className="w-8 px-0 max-md:min-h-11 max-md:w-11">
              <Menu className="h-5 w-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Navigation" className="w-64 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
            <DropdownMenuItem onSelect={() => assistant.open()}><Sparkles className="h-4 w-4" aria-hidden />Ask Valet</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: NAV_ACTIVE }} inactiveProps={{ className: NAV_INACTIVE }}>Home</Link>
            </DropdownMenuItem>
            {[...destinations, ...more.filter(({ to }) => to !== "/memory")].map(({ to, label, active }) => (
              <DropdownMenuItem key={to} asChild>
                <Link
                  to={to}
                  className={active === undefined ? undefined : active ? NAV_ACTIVE : NAV_INACTIVE}
                  activeProps={active === undefined ? { className: NAV_ACTIVE } : {}}
                  inactiveProps={active === undefined ? { className: NAV_INACTIVE } : {}}
                >
                  {destinationLabel(label)}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem asChild><Link to="/memory">Memory</Link></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings"><Settings className="h-4 w-4" aria-hidden />Settings</Link>
            </DropdownMenuItem>
            {securityEnabled && <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1 text-xs text-muted">Plugins</div>
              <DropdownMenuItem asChild>
                <Link to="/security"><ShieldCheck className="h-4 w-4" aria-hidden />Valet Security</Link>
              </DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center">
        <button type="button" className={cn(NAV_BASE, NAV_INACTIVE, "hidden gap-1.5 md:inline-flex")} onClick={() => assistant.open()}>
          <Sparkles className="h-4 w-4" aria-hidden />
          Ask Valet
        </button>
        <NotificationsBell />
      </div>

      <Link
        to="/settings"
        className="hidden h-8 w-8 shrink-0 md:inline-flex items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </header>
  );
}
