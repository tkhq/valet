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
export function TopNav() {
  const info = useOrchestratorInfo();
  const name = info.data?.name ?? "Valet";
  const presence = info.data?.presence ?? "idle";

  return (
    <header className="h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center px-3 gap-4">
      <Link
        to="/"
        className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash"
        aria-label={`${name} — dashboard`}
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <PresenceMark name={name} state={presence} size="nav" />
      </Link>

      <div className="flex-1" />

      <Link
        to="/chat"
        className="rounded px-2 py-1 text-sm text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
      >
        Chat
      </Link>
      <Link
        to="/memory"
        className="rounded px-2 py-1 text-sm text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
      >
        Memory
      </Link>
      <Link
        to="/sessions"
        className="rounded px-2 py-1 text-sm text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
      >
        Sessions
      </Link>

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
