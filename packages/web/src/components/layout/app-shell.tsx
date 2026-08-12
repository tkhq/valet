import { useCallback, useState, type ReactNode, type MouseEvent } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { cn } from "~/lib/cn";

const COLLAPSED_KEY = "valet:sidebar-collapsed";

function loadStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Three-zone app shell: a top nav, a left sidebar, and the main content
 * outlet.
 *
 * Desktop (`md`+): the sidebar sizes to its content (widest thread title)
 * between a 200px floor and a 320px cap, so a list of short titles doesn't
 * waste horizontal space and a long title truncates instead of pushing
 * `<main>` off-screen. Collapsible via the panel toggle at the sidebar's
 * top-right corner; when collapsed, a matching expand button floats at the
 * top-left of the content area. The collapsed state persists to
 * localStorage.
 *
 * Mobile: collapses out of the flow and is reachable via a small toggle
 * button that opens it as a full-height overlay drawer (paper bg, hairline
 * right border). The drawer closes on backdrop tap, the ✕ button, or
 * clicking any link inside it (thread selection) — the latter via one
 * delegated click handler rather than threading a close callback through
 * `ThreadTree`.
 */
export function AppShell({
  topNav,
  sidebar,
  children,
  className,
}: {
  topNav: ReactNode;
  /**
   * `null`/`undefined` hides the sidebar entirely (no `<aside>` at all,
   * and no mobile toggle) — used by standalone session views (decision 14:
   * "no thread sidebar").
   */
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => loadStoredCollapsed());

  // Closes the drawer when a link inside it is clicked (thread/child
  // selection) without requiring `ThreadTree` to know about the drawer.
  function onDrawerClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("a")) setMobileOpen(false);
  }

  const setAndStoreCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Non-persistent environments still get the in-session behavior.
    }
  }, []);

  return (
    <div className={cn("h-screen w-screen flex flex-col bg-[--bg] text-[--fg]", className)}>
      {topNav}
      <div className="flex-1 flex min-h-0 relative">
        {sidebar != null && (
          <>
            {!collapsed && (
              <aside className="hidden md:flex shrink-0 flex-col relative w-max min-w-[200px] max-w-[320px] border-r border-line">
                <button
                  type="button"
                  aria-label="Collapse sidebar"
                  onClick={() => setAndStoreCollapsed(true)}
                  className="absolute top-2 right-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
                <div className="flex-1 min-h-0 flex flex-col">{sidebar}</div>
              </aside>
            )}
            {collapsed && (
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={() => setAndStoreCollapsed(false)}
                className="hidden md:inline-flex absolute top-2 left-2 z-30 h-8 w-8 items-center justify-center rounded border border-line bg-paper text-muted hover:text-ink"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              aria-label="Open threads"
              onClick={() => setMobileOpen(true)}
              className="md:hidden absolute top-2 left-2 z-30 inline-flex h-8 w-8 items-center justify-center rounded border border-line bg-paper text-muted hover:text-ink"
            >
              <Menu className="h-4 w-4" />
            </button>
            {mobileOpen && (
              <div className="md:hidden fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
                <div
                  className="absolute inset-0 bg-black/30"
                  aria-hidden
                  onClick={() => setMobileOpen(false)}
                />
                <div
                  className="relative h-full w-72 max-w-[80vw] bg-paper border-r border-line flex flex-col"
                  onClick={onDrawerClick}
                >
                  <div className="flex items-center justify-end p-2">
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => setMobileOpen(false)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col">{sidebar}</div>
                </div>
              </div>
            )}
          </>
        )}
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </div>
    </div>
  );
}
