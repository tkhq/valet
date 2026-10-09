import { Link } from "@tanstack/react-router";
import { cn } from "~/lib/cn";
import type { FileRouteTypes } from "~/routeTree.gen";

/** A route pattern of this app, such as `/settings/teams/$teamId`, from the
 * generated route tree. A typo or a built string (`/settings/teams/${id}`)
 * fails the typecheck. */
export type AppPath = FileRouteTypes["to"];

export interface LinkTab {
  to: AppPath;
  label: string;
  /** Route params for a parameterized `to`, such as `/settings/teams/$teamId`. */
  params?: Record<string, string>;
}

/**
 * Tabs that are routes. `TabBar` switches panels inside one page; this
 * navigates between pages, so each tab is a real link (back, forward, and
 * open in a new tab work). Same underline look as `TabBar`.
 */
export function LinkTabs({ tabs, activeTo, label }: { tabs: readonly LinkTab[]; activeTo: AppPath; label: string }) {
  return (
    <nav aria-label={label} className="flex min-w-0 max-w-full gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const active = tab.to === activeTo;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            params={tab.params}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
              active ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
