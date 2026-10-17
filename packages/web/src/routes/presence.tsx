import { Outlet, createFileRoute } from "@tanstack/react-router";
import { pageClass } from "~/components/primitives";
import { PresenceRail } from "~/components/presence/presence-rail";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/presence` layout: where Valet is, and what it does there (spec Part A).
 * It is a two-pane shell: the rail of places on the left and a pane on the
 * right. There are no tabs (INV-H5). Activity, Routines, a place, a line of
 * presence, and an event all render in the pane, so the rail stays visible.
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
        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:gap-10">
          <PresenceRail />
          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
