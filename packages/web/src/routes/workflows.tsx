import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";
import { cn } from "~/lib/cn";

/**
 * `/workflows` layout: a small header (title, `WorkspaceClause`, and the
 * Workflows/Runs pills) over the list, composer, and Runs view (spec Part A,
 * Part G). The editor (`/workflows/$workflowId`) and the run page
 * (`/workflows/runs/$runId`) need the full height, so they render without
 * the header; `workflowsTabFor` returns `undefined` for them, mirroring
 * `routes/presence.tsx`'s `presenceTabFor`.
 */
export const Route = createFileRoute("/workflows")({
  component: WorkflowsLayout,
});

const WORKFLOWS_TABS = [
  { to: "/workflows", label: "Workflows" },
  { to: "/workflows/runs", label: "Runs" },
] as const;

type WorkflowsTabPath = (typeof WORKFLOWS_TABS)[number]["to"];

/** The tab a pathname shows, or `undefined` for a detail page. */
export function workflowsTabFor(pathname: string): WorkflowsTabPath | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return WORKFLOWS_TABS.find((tab) => tab.to === path)?.to;
}

function WorkflowsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = workflowsTabFor(pathname);
  if (active === undefined) return <Outlet />;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl text-ink">Workflows</h1>
          <WorkspaceClause />
        </div>

        <nav aria-label="Workflows sections" className="mt-4 flex gap-2">
          {WORKFLOWS_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={tab.to === active ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm transition-colors",
                tab.to === active ? "bg-ink-wash font-medium text-ink" : "text-muted hover:bg-ink-wash hover:text-ink",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="mt-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
