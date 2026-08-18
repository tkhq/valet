import { useCallback } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { useSidebarControls } from "./app-shell";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useAssistants, useCreateAssistant } from "~/api/assistants";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import {
  WorkspaceSwitcher,
  workspaceOptions,
  type WorkspaceOption,
} from "~/components/layout/workspace-switcher";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { PresenceMark } from "~/components/assistant/presence-mark";
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
function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      // `shrink-0` + `whitespace-nowrap`: the row scrolls when it does not
      // fit, so a link must keep its own width instead of being squeezed
      // into a wrapped two-line label.
      className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-sm hover:bg-ink-wash"
      activeProps={{ className: "text-ink font-medium bg-ink-wash" }}
      inactiveProps={{ className: "text-muted hover:text-ink" }}
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
    "shrink-0 rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none";

  return (
    <>
      <button
        type="button"
        aria-label="Open threads"
        onClick={controls.openDrawer}
        className={`md:hidden inline-flex ${buttonClass}`}
      >
        <Menu className="h-4 w-4" aria-hidden />
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
  const info = useOrchestratorInfo();
  const presence = info.data?.presence ?? "idle";

  // The switcher reads the same three queries the rail does, so switching
  // costs no extra request — react-query serves all three from cache.
  const assistantsQ = useAssistants();
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const options = workspaceOptions(assistantsQ.data?.assistants, teams);
  // The active workspace is no longer derived here from `?assistant=`. That
  // only ever resolved on `/chat`, so every other page read "Personal"
  // regardless of the workspace the reader was in. The scope owns it now and
  // still lets the open assistant win — see `workspace-scope.tsx`.
  const scope = useWorkspaceScope();
  const onChat = useRouterState({ select: (st) => st.location.pathname === "/chat" });
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

  // The logo is the PRODUCT (Valet), not the orchestrator — the
  // orchestrator's chosen name shows up in its own title card (session
  // header) instead. The presence dot stays: it still reflects the
  // orchestrator's live state at a glance from anywhere in the app.
  return (
    <header className="h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-2 px-3 sm:gap-4">
      <SidebarToggle />

      <Link
        to="/"
        className="flex shrink-0 items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash"
        aria-label="Valet — dashboard"
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <PresenceMark name="Valet" state={presence} size="nav" />
      </Link>

      {/* Beside the logo, not in the sidebar: it scopes the surfaces below
          rather than filtering one list. */}
      <WorkspaceSwitcher
        options={options}
        activeKey={scope.key}
        onSelect={scope.setKey}
        navigateOnSelect={onChat}
        onCreateAssistant={createWorkspaceAssistant}
      />
      {createAssistant.error != null && (
        <span role="status" className="shrink-0 truncate max-w-[18rem] text-xs text-danger-500">
          Cannot open that workspace. Select it again to retry.
        </span>
      )}

      {/*
       * Six labelled links do not fit beside the logo and the icons on a
       * phone. The row scrolls sideways instead of overflowing the header,
       * so every destination stays reachable at any width. `min-w-0` is
       * what lets it shrink at all — a flex child defaults to `min-width:
       * auto` and would otherwise push the icons off-screen. From `sm` up
       * there is room, so the links sit right-aligned as before and the
       * scroll never engages.
       */}
      <nav
        aria-label="Primary"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:justify-end sm:gap-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <NavLink to="/chat">Chat</NavLink>
        <NavLink to="/memory">Memory</NavLink>
        <NavLink to="/sessions">Sessions</NavLink>
        <NavLink to="/workflows">Workflows</NavLink>
        <NavLink to="/events">Events</NavLink>
        <NavLink to="/skills">Skills</NavLink>
        <NavLink to="/integrations">Integrations</NavLink>
      </nav>

      <div className="shrink-0">
        <NotificationsBell />
      </div>

      <Link
        to="/settings"
        className="shrink-0 rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </header>
  );
}
