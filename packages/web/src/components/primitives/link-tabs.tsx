import { Link } from "@tanstack/react-router";
import type { FileRouteTypes } from "~/routeTree.gen";
import { TAB_STRIP_CLASS, tabClass } from "./tab-bar.js";

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
 * open in a new tab work). It uses the strip and tab classes of `TabBar`.
 */
export function LinkTabs({ tabs, activeTo, label }: { tabs: readonly LinkTab[]; activeTo: AppPath; label: string }) {
  return (
    <nav aria-label={label} className={TAB_STRIP_CLASS}>
      {tabs.map((tab) => {
        const active = tab.to === activeTo;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            params={tab.params}
            aria-current={active ? "page" : undefined}
            className={tabClass(active)}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
