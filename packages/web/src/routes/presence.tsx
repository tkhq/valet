import { Outlet, createFileRoute } from "@tanstack/react-router";
import { pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout: where Valet is, and what it does there (spec Part A).
 * It is one column: the title, the workspace clause, the subtitle, and the
 * page. There is no rail and there are no tabs (INV-H5). `/presence` lands
 * on the overview; every other page is a drill-in with a breadcrumb.
 * Workflows and Runs have their own top-nav entry at `/workflows` (spec
 * Part G).
 */
export const Route = createFileRoute("/presence")({
  component: PresenceLayout,
});

export function PresenceLayout() {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl text-ink">Presence</h1>
          <WorkspaceClause />
        </div>
        <p className="mt-1 text-sm text-muted">Where Valet is, and what it does there.</p>
        <div className="mt-6 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
