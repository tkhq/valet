import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Three-zone app shell: a top nav, a left sidebar, and the main content
 * outlet. Sidebar is fixed-width from `md` up; below that it collapses
 * (hidden, not an overlay drawer) so the main content — the chat
 * transcript, the memory doc pane, etc — gets the full narrow viewport.
 * A mobile drawer/toggle to reach the collapsed sidebar is out of scope for
 * this pass.
 */
export function AppShell({
  topNav,
  sidebar,
  children,
  className,
}: {
  topNav: ReactNode;
  /**
   * `null`/`undefined` hides the sidebar entirely (no `<aside>` at all) —
   * used by standalone session views (decision 14: "no thread sidebar").
   */
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-screen w-screen flex flex-col bg-[--bg] text-[--fg]", className)}>
      {topNav}
      <div className="flex-1 flex min-h-0">
        {sidebar != null && (
          <aside className="hidden md:flex w-60 shrink-0 border-r border-[--border] flex-col">
            {sidebar}
          </aside>
        )}
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </div>
    </div>
  );
}
