import type { ReactNode } from "react";
import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { TabBar, pageClass, tabPanelId } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout: where Valet is, and what it does there (spec Part A).
 * It replaces the Events and Automation sections. The three tab pages render
 * inside the section frame (title, subtitle, tabs). A detail page (a place,
 * a listener, or an event) renders its own page instead. Workflows and Runs
 * have their own top-nav entry at `/workflows` (spec Part G); they are not
 * tabs of this section.
 */
export const Route = createFileRoute("/presence")({
  component: PresenceLayout,
});

export const PRESENCE_TABS = [
  { id: "places", label: "Places", to: "/presence" },
  { id: "routines", label: "Routines", to: "/presence/routines" },
  { id: "activity", label: "Activity", to: "/presence/activity" },
] as const;

export type PresenceTabId = (typeof PRESENCE_TABS)[number]["id"];

const TABS_LABEL = "Presence sections";

/** The tab a pathname shows, or `undefined` for a detail page. */
export function presenceTabFor(pathname: string): PresenceTabId | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PRESENCE_TABS.find((tab) => tab.to === path)?.id;
}

function PresenceLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const active = presenceTabFor(pathname);
  if (active === undefined) return <Outlet />;
  return (
    <PresenceTabsFrame
      active={active}
      onSelect={(id) => {
        const tab = PRESENCE_TABS.find((candidate) => candidate.id === id);
        if (tab) void navigate({ to: tab.to });
      }}
    >
      <Outlet />
    </PresenceTabsFrame>
  );
}

/** The section frame: title, workspace clause, subtitle, tabs, and the
 * active tab's panel. Exported for its test, which renders it without a
 * router. */
export function PresenceTabsFrame({
  active,
  onSelect,
  children,
}: {
  active: PresenceTabId;
  onSelect: (id: PresenceTabId) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl text-ink">Presence</h1>
          <WorkspaceClause />
        </div>
        <p className="mt-1 text-sm text-muted">Where Valet is, and what it does there.</p>

        <div className="mt-6">
          <TabBar tabs={PRESENCE_TABS} active={active} onSelect={onSelect} label={TABS_LABEL} />
        </div>

        <div
          role="tabpanel"
          id={tabPanelId(TABS_LABEL, active)}
          aria-labelledby={`${tabPanelId(TABS_LABEL, active)}-tab`}
          className="mt-6"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
