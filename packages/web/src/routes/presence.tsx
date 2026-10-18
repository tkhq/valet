import { Outlet, createFileRoute, useMatch } from "@tanstack/react-router";
import { OverviewActions } from "~/components/presence/overview";
import { pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout: where Valet is, and what it does there (spec Part A).
 * It is one column: the title, the workspace clause, the subtitle, and the
 * page. On the overview, the header also carries the overview's action
 * pair, Activity and Add, at the right (spec Part B step 1). There is no rail and there are no tabs (INV-H5). `/presence` lands
 * on the overview; every other page is a drill-in with a breadcrumb.
 * Workflows and Runs have their own top-nav entry at `/workflows` (spec
 * Part G).
 */
export const Route = createFileRoute("/presence")({
  component: PresenceLayout,
});

export function PresenceLayout() {
  const onOverview = useMatch({ from: "/presence/", shouldThrow: false }) !== undefined;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="font-display text-2xl text-ink">Presence</h1>
              <WorkspaceClause />
            </div>
            <p className="mt-1 text-sm text-muted">Where Valet is, and what it does there.</p>
          </div>
          {onOverview && <OverviewActions />}
        </div>
        <div className="mt-6 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
