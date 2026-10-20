import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { createFileRoute } from "@tanstack/react-router";
import { MemoryCard } from "~/components/assistant/memory-card";
import { WorkspaceCatchUp } from "~/components/dashboard/workspace-catch-up";
import { UsageCard } from "~/components/assistant/usage-card";
import { TeamDashboard } from "~/components/dashboard/team-dashboard";
import { Button, ErrorRow, LoadingRow, PageHeader, pageClass } from "~/components/primitives";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { cn } from "~/lib/cn";

/** Home follows the workspace switcher and shows the personal or team activity dashboard. */
export const Route = createFileRoute("/")({
  component: Home,
});

export function Home() {
  const scope = useWorkspaceScope();
  if (scope.teamId !== undefined) {
    return <TeamDashboard teamId={scope.teamId} />;
  }
  return <Dashboard />;
}

export function Dashboard() {
  const info = useWorkspaceRuntimeInfo("user");

  if (info.isLoading || info.error || !info.data) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className={pageClass}>
          {info.isLoading ? <LoadingRow label="Loading your workspace…" /> : (
            <>
              <ErrorRow>Could not load your workspace. Try again.</ErrorRow>
              <Button variant="secondary" size="sm" onClick={() => void info.refetch()}>Retry</Button>
            </>
          )}
        </div>
      </div>
    );
  }

  return <DashboardBody />;
}

function DashboardBody() {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={cn(pageClass, "space-y-8")}>
        <PageHeader title="Personal" description="Your recent work and items that need attention." />
        <WorkspaceCatchUp />
        <div className="grid gap-4 md:grid-cols-2">
          <MemoryCard />
          <UsageCard />
        </div>
      </div>
    </div>
  );
}
