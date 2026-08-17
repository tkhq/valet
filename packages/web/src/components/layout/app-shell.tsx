import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { X } from "lucide-react";
import { cn } from "~/lib/cn";

const COLLAPSED_KEY = "valet:sidebar-collapsed";

/**
 * The sidebar's open/closed state, published so the TOP NAV can own the
 * controls that change it.
 *
 * Those controls used to be absolutely positioned over the sidebar's own
 * top-right corner, which put them on no layout grid at all: the collapse
 * button landed on top of whatever the sidebar's first row happened to draw
 * there. For the assistants rail that is each group's "New assistant"
 * button, so the overlay covered a real control and made it unclickable.
 * Floating them also split one piece of state across two buttons in two
 * places, each with its own z-index.
 *
 * In the nav they sit in a flex row that positions them, so they align with
 * the logo by construction and can overlap nothing. This is where Linear,
 * Notion and VS Code put the same control.
 *
 * `null` outside an `AppShell` — a nav rendered on its own shows no toggle
 * rather than one that controls nothing.
 */
export interface SidebarControls {
  /** False when the shell was given no sidebar; the nav then shows no toggle. */
  present: boolean;
  collapsed: boolean;
  toggleCollapsed(): void;
  /** Mobile only: the sidebar is out of the flow and opens as a drawer. */
  openDrawer(): void;
}

const SidebarControlsContext = createContext<SidebarControls | null>(null);

export function useSidebarControls(): SidebarControls | null {
  return useContext(SidebarControlsContext);
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
 * between a 200px floor and a 320px cap, so a list of short titles doesn't
 * waste horizontal space and a long title truncates instead of pushing
 * `<main>` off-screen. The collapsed state persists to localStorage.
 *
 * Mobile: collapses out of the flow and opens as a full-height overlay
 * drawer (paper bg, hairline right border). The drawer closes on backdrop
 * tap, the ✕ button, or clicking any link inside it (thread selection) —
 * the latter via one delegated click handler rather than threading a close
 * callback through `ThreadTree`.
 *
 * The shell owns this state but draws none of the controls that change it.
 * It publishes them through `SidebarControlsContext` and the top nav renders
 * the toggle in its own left-hand flex row. See that context's doc comment
 * for why they are not floated over the sidebar.
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

  const controls = useMemo<SidebarControls>(
    () => ({
      present: sidebar != null,
      collapsed,
      toggleCollapsed: () => setAndStoreCollapsed(!collapsed),
      openDrawer: () => setMobileOpen(true),
    }),
    [sidebar, collapsed, setAndStoreCollapsed],
  );

  return (
    <SidebarControlsContext.Provider value={controls}>
      <div className={cn("h-screen w-screen flex flex-col bg-[--bg] text-[--fg]", className)}>
        {topNav}
        <div className="flex-1 flex min-h-0 relative">
          {sidebar != null && (
            <>
              {!collapsed && (
                <aside className="hidden md:flex shrink-0 flex-col w-max min-w-[200px] max-w-[320px] border-r border-line">
                  <div className="flex-1 min-h-0 flex flex-col">{sidebar}</div>
                </aside>
              )}
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
    </SidebarControlsContext.Provider>
  );
}
