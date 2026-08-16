import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useOrchestratorInfo } from "~/api/orchestrator";
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

export function TopNav() {
  const info = useOrchestratorInfo();
  const presence = info.data?.presence ?? "idle";

  // The logo is the PRODUCT (Valet), not the orchestrator — the
  // orchestrator's chosen name shows up in its own title card (session
  // header) instead. The presence dot stays: it still reflects the
  // orchestrator's live state at a glance from anywhere in the app.
  return (
    <header className="h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-2 px-3 sm:gap-4">
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
