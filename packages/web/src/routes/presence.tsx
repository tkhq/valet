import { Outlet, createFileRoute, useMatch } from "@tanstack/react-router";
import { OverviewActions } from "~/components/presence/overview";
import { pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout (spec Part A). Presence is one column with no rail and
 * no tabs (INV-H5). On the overview, the layout renders the section's title
 * block: the `Presence` title, the workspace clause, the subtitle, and at the
 * right the action pair, Activity and Add (spec Part B step 1). Every other
 * page is a drill-in: it renders its own breadcrumb, whose first crumb is
 * `Presence`, and its own title (`PresenceDetailPage`), so the layout adds
 * no title above it (spec Part A step 2). Workflows and Runs have their own
 * top-nav entry at `/workflows` (spec Part G).
 */
export const Route = createFileRoute("/presence")({
  component: PresenceLayout,
});

export function PresenceLayout() {
  const onOverview = useMatch({ from: "/presence/", shouldThrow: false }) !== undefined;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        {onOverview && (
          <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="font-display text-2xl text-ink">Presence</h1>
                <WorkspaceClause />
              </div>
              <p className="mt-1 text-sm text-muted">Where Valet is, and what it does there.</p>
            </div>
            <OverviewActions />
          </div>
        )}
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
