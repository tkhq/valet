import { Link, Outlet, createFileRoute, useMatch } from "@tanstack/react-router";
import { OverviewActions } from "~/components/presence/overview";
import { PageHeader, pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout (spec Part A). Presence is one column with no rail and
 * no tabs (INV-H5). On the overview, the layout renders the section's title
 * block: the `Presence` title, the workspace clause, the subtitle, and at the
 * right the action pair, Activity and Add (spec Part B step 1). Every other
 * page is a drill-in: it renders its own breadcrumb, whose first crumb is
 * `Presence`, and its own title (`PresenceDetailPage`), so the layout adds
 * no title above it (spec Part A step 2). Workflows and Runs have their own
 * top-nav entry at `/workflows` (spec Part G). A path under `/presence` that
 * matches no page renders `PresenceNotFound` in the layout's outlet.
 */
export const Route = createFileRoute("/presence")({
  component: PresenceLayout,
  notFoundComponent: PresenceNotFound,
});

/** A path under `/presence` that matches no page. */
export function PresenceNotFound() {
  return (
    <div className="space-y-2 py-4 text-sm">
      <p className="text-ink">This page does not exist.</p>
      <Link to="/presence" className="text-accent-600 hover:underline">Back to Presence</Link>
    </div>
  );
}

export function PresenceLayout() {
  const onOverview = useMatch({ from: "/presence/", shouldThrow: false }) !== undefined;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        {onOverview && (
          <PageHeader
            className="mb-6"
            title="Presence"
            clause={<WorkspaceClause />}
            description="Where Valet is, and what it does there."
            actions={<OverviewActions />}
          />
        )}
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
