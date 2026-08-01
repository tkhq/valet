import { useCallback, useEffect, useRef, useState, type ReactNode, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { cn } from "~/lib/cn";

const WIDTH_KEY = "valet:sidebar-width";
const COLLAPSED_KEY = "valet:sidebar-collapsed";
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 280;

function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    // localStorage unavailable (private mode) — fall through to default.
  }
  return DEFAULT_WIDTH;
}

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
 * up to a user-set MAXIMUM — the drag handle on its right edge adjusts
 * that max (persisted to localStorage, clamped 200–520px), so a list of
 * short titles doesn't waste horizontal space while long titles get room
 * until the cap, then truncate. Collapsible via the panel toggle at the
 * sidebar's top-right corner; when collapsed, a matching expand button
 * floats at the top-left of the content area.
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
  const [width, setWidth] = useState<number>(() => loadStoredWidth());
  const [collapsed, setCollapsed] = useState<boolean>(() => loadStoredCollapsed());
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

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

  function onHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    // Start from the aside's RENDERED width, not the stored max — when the
    // content-sized sidebar is narrower than the max, the handle sits at
    // the actual edge, and the drag should track the cursor from there.
    const rendered = asideRef.current?.offsetWidth ?? width;
    dragRef.current = { startX: e.clientX, startWidth: rendered };
    setDragging(true);
  }

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + (e.clientX - drag.startX)));
      setWidth(next);
    }
    function onUp() {
      setDragging(false);
      dragRef.current = null;
      setWidth((w) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // Best-effort persistence only.
        }
        return w;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  return (
    <div
      className={cn(
        "h-screen w-screen flex flex-col bg-[--bg] text-[--fg]",
        dragging && "select-none cursor-col-resize",
        className,
      )}
    >
      {topNav}
      <div className="flex-1 flex min-h-0 relative">
        {sidebar != null && (
          <>
            {!collapsed && (
              <aside
                ref={asideRef}
                className="hidden md:flex shrink-0 flex-col relative w-max min-w-[200px]"
                style={{ maxWidth: width }}
              >
                <button
                  type="button"
                  aria-label="Collapse sidebar"
                  onClick={() => setAndStoreCollapsed(true)}
                  className="absolute top-2 right-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
                <div className="flex-1 min-h-0 flex flex-col">{sidebar}</div>
                {/* Resize handle — 6px hit area straddling the border.
                    Adjusts the MAX width; actual width is content-driven
                    below the max (`w-max` + inline maxWidth above). */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sidebar"
                  onPointerDown={onHandlePointerDown}
                  className={cn(
                    "absolute top-0 right-[-3px] h-full w-[6px] cursor-col-resize z-10",
                    "after:absolute after:top-0 after:left-[2px] after:h-full after:w-px after:bg-[--border]",
                    dragging ? "after:bg-moss" : "hover:after:bg-moss",
                  )}
                />
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
