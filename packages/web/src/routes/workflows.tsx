import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { LinkTabs, PageHeader, pageClass } from "~/components/primitives";
import { WorkflowsHeaderActions } from "~/components/workflows/workflows-header-actions";
import { WorkspaceClause } from "~/components/workspace-clause";

/**
 * `/workflows` layout: the page header (title, `WorkspaceClause`, and on the
 * Workflows tab its actions) and the Workflows/Runs tabs over the list,
 * composer, and Runs view (spec Part A, Part G). The editor
 * (`/workflows/$workflowId`) and the run page (`/workflows/runs/$runId`) need
 * the full height, so they render without the header; `workflowsTabFor`
 * returns `undefined` for them.
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
        <PageHeader
          title="Workflows"
          clause={<WorkspaceClause />}
          actions={active === "/workflows" ? <WorkflowsHeaderActions /> : undefined}
        />
        <div className="mt-4">
          <LinkTabs tabs={WORKFLOWS_TABS} activeTo={active} label="Workflows sections" />
        </div>
        <div className="mt-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
