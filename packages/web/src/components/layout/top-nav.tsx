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
      className="rounded px-2 py-1 text-sm hover:bg-ink-wash"
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
    <header className="h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center px-3 gap-4">
      <Link
        to="/"
        className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash"
        aria-label="Valet — dashboard"
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <PresenceMark name="Valet" state={presence} size="nav" />
      </Link>

      <div className="flex-1" />

      <NavLink to="/chat">Chat</NavLink>
      <NavLink to="/memory">Memory</NavLink>
      <NavLink to="/sessions">Sessions</NavLink>
      <NavLink to="/workflows">Workflows</NavLink>
      <NavLink to="/integrations">Integrations</NavLink>

      <NotificationsBell />

      <Link
        to="/settings"
        className="rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </header>
  );
}
