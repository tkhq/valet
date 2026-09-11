import { useCallback } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { useSidebarControls } from "./app-shell";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useAssistants, useCreateAssistant } from "~/api/assistants";
import { useSession } from "~/api/queries";
import { useChangelog } from "~/api/changelog";
import { pluginEnabledForCaller, useMe, useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import {
  WorkspaceSwitcher,
  workspaceOptions,
  type WorkspaceOption,
} from "~/components/layout/workspace-switcher";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { useLastSeenCheckpoint } from "~/lib/changelog-read-state";
import { PresenceMark } from "~/components/assistant/presence-mark";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/primitives";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { NotificationsBell } from "./notifications-bell";

/**
 * App-wide top navigation, assistant-first (assistant-centered web UI,
 * decision 9/10). Left: the presence mark (◈ {name}) linking to the
 * dashboard — the assistant is the app's anchor, so it lives in the nav on
 * every page. Right: a plain "Sessions" link to the standalone-sessions
 * area, and the notifications bell.
 *
 * The old session-picker dropdown and "New session" button are gone —
 * sessions are reached via `/sessions` now (its stub page hosts "New
 * session" until Task 4 builds the full dashboard/sessions split).
 */
/**
 * Top-nav link with a working active state. Text color lives in
 * `activeProps`/`inactiveProps` — NOT the base className — because TanStack
 * Router concatenates `activeProps.className` onto the base, and two
 * conflicting Tailwind text colors resolve by stylesheet order, not by
 * which was added last (the old `text-muted` base + `text-ink` active pair
 * rendered no visible active state at all).
 */
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
   * `/sessions/:id` security session lights "Security", not "Sessions" —
   * the URL alone cannot tell the two apart (both live under /sessions). */
  active?: boolean;
}) {
  // `shrink-0` + `whitespace-nowrap`: the row scrolls when it does not fit,
  // so a link must keep its own width instead of being squeezed into a
  // wrapped two-line label.
  const base = "shrink-0 whitespace-nowrap rounded px-2 py-1 text-sm hover:bg-ink-wash";
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
  if (controls === null || !controls.present) return null;

  const buttonClass =
    "shrink-0 min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none";

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
      <button
        type="button"
        aria-label={controls.collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!controls.collapsed}
        onClick={controls.toggleCollapsed}
        className={`hidden md:inline-flex ${buttonClass}`}
      >
        {controls.collapsed ? (
          <PanelLeftOpen className="h-4 w-4" aria-hidden />
        ) : (
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        )}
      </button>
    </>
  );
}

export function TopNav() {
  const mobileNav = useResponsiveOverlay("md");
  const info = useOrchestratorInfo();
  const presence = info.data?.presence ?? "idle";

  // The switcher reads the same three queries the rail does, so switching
  // costs no extra request — react-query serves all three from cache.
  const assistantsQ = useAssistants();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const meQ = useMe();
  const changelogQ = useChangelog();
  const newestCheckpoint = changelogQ.data?.manifest.checkpoints[0];
  const seenCheckpoint = useLastSeenCheckpoint(meQ.data?.id);
  const changelogUnread = !!meQ.data && !!newestCheckpoint && seenCheckpoint !== newestCheckpoint.id;
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const options = workspaceOptions(assistantsQ.data?.assistants, teams);
  // The active workspace is no longer derived here from `?assistant=`. That
  // only ever resolved on `/chat`, so every other page read "Personal"
  // regardless of the workspace the reader was in. The scope owns it now and
  // still lets the open assistant win — see `workspace-scope.tsx`.
  const scope = useWorkspaceScope();
  const onChat = useRouterState({ select: (st) => st.location.pathname === "/chat" });
  // A security session lives at /sessions/:id like any other, so the URL
  // cannot distinguish it — read the id off the path and check its kind so
  // the nav lights "Security" instead of "Sessions". The query is shared
  // with the session page's own read, so it costs no extra request.
  const sessionRouteId = useRouterState({
    select: (st) => {
      const m = /^\/sessions\/([^/]+)$/.exec(st.location.pathname);
      return m ? m[1] : undefined;
    },
  });
  const routeSession = useSession(sessionRouteId ?? "");
  const onSecuritySession = routeSession.data?.kind === "security";
  // Gate the Security link on the `security` plugin's entitlement for this
  // caller. `undefined` (org not yet loaded) hides the link — no flash of a
  // link the caller may not have, matching the settings rail's no-flash rule.
  const securityEnabled = pluginEnabledForCaller(orgQ.data, "security") === true;
  const navigate = useNavigate();
  const createAssistant = useCreateAssistant();

  /**
   * Opens a workspace on `/chat` that owns no assistant yet, by creating one.
   *
   * On `/chat` the open assistant defines the workspace, so a selection the
   * conversation cannot follow is a selection that does not happen: the scope
   * is re-derived from the assistant still on screen and written back over
   * the choice. A team a person belongs to should have an assistant, so this
   * creates it rather than refusing.
   *
   * Failure is not silent: the strip beside the switcher reports it (the
   * dropdown itself is closed by then, so it cannot). Without that report,
   * a failed create left `/chat` on the previous conversation, the scope
   * re-derived from it and overwrote the selection — the switcher looked
   * broken and said nothing.
   */
  const createWorkspaceAssistant = useCallback(
    (workspace: WorkspaceOption) => {
      if (!workspace.isTeam) return;
      createAssistant.mutate(
        { owner: { type: "team", id: workspace.key } },
        {
          onSuccess: (assistant) => {
            void navigate({
              to: "/chat",
              search: { assistant: assistant.id, thread: undefined, child: undefined },
            });
          },
        },
      );
    },
    [createAssistant, navigate],
  );

  const destinations = [
    { to: "/chat", label: "Chat" },
    { to: "/memory", label: "Memory" },
    { to: "/artifacts", label: "Artifacts" },
    { to: "/sessions", label: "Sessions", active: onSecuritySession ? false : undefined },
    { to: "/workflows", label: "Workflows" },
    ...(securityEnabled ? [{ to: "/security", label: "Security", active: onSecuritySession ? true : undefined }] : []),
    { to: "/events", label: "Events" },
    { to: "/usage", label: "Usage" },
    { to: "/skills", label: "Skills" },
    { to: "/integrations", label: "Integrations" },
    { to: "/changelog", label: "Changelog" },
  ];
  const destinationLabel = (label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {label === "Changelog" && changelogUnread && (
        <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-label="New releases" />
      )}
    </span>
  );

  // The logo is the PRODUCT (Valet), not the orchestrator — the
  // orchestrator's chosen name shows up in its own title card (session
  // header) instead. The presence dot stays: it still reflects the
  // orchestrator's live state at a glance from anywhere in the app.
  return (
    <header className="h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-1 px-2 md:gap-4 md:px-3">
      <SidebarToggle />

      <Link
        to="/"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash md:min-h-0 md:min-w-0"
        aria-label="Valet — dashboard"
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <span className="hidden md:inline-flex"><PresenceMark name="Valet" state={presence} size="nav" /></span>
      </Link>

      {/* Beside the logo, not in the sidebar: it scopes the surfaces below
          rather than filtering one list. */}
      <WorkspaceSwitcher
        options={options}
        activeKey={scope.key}
        onSelect={(key) => {
          // Any new selection retires the previous failure. Without this a
          // single failed create pinned "Cannot open that workspace" beside
          // the switcher for the rest of the visit — no later selection
          // mutates (and so clears) the error unless it also needs a create.
          createAssistant.reset();
          scope.setKey(key);
        }}
        navigateOnSelect={onChat}
        onCreateAssistant={createWorkspaceAssistant}
      />
      {createAssistant.error != null && (
        <span role="status" className="absolute left-2 right-2 top-[--nav-height] z-30 border border-line bg-paper p-2 text-xs text-danger-500 md:static md:max-w-[18rem] md:shrink md:border-0 md:p-0">
          Cannot open that workspace. Select it again to retry.
        </span>
      )}

      <nav
        aria-label="Primary"
        className="hidden min-w-0 flex-1 items-center gap-2 overflow-x-auto md:flex xl:justify-end [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {destinations.map(({ to, label, active }) => (
          <NavLink key={to} to={to} active={active}>{destinationLabel(label)}</NavLink>
        ))}
      </nav>
      <div className="ml-auto shrink-0 md:hidden">
        <DropdownMenu open={mobileNav.open} onOpenChange={mobileNav.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label="Open navigation" className="h-11 w-11 p-0">
              <Menu className="h-5 w-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Navigation" className="w-64">
            {destinations.map(({ to, label, active }) => (
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="shrink-0">
        <NotificationsBell />
      </div>

      <Link
        to="/settings"
        className="inline-flex shrink-0 min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </header>
  );
}
