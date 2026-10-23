import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MemoryCard } from "~/components/assistant/memory-card";
import { WorkspaceCatchUp } from "~/components/dashboard/workspace-catch-up";
import { UsageCard } from "~/components/assistant/usage-card";
import { TeamDashboard } from "~/components/dashboard/team-dashboard";
import { HomeScreen, type HomeView } from "~/components/home/home-screen";
import { Button, ErrorRow, LoadingRow, PageHeader, pageClass } from "~/components/primitives";
import { useMobileLayout } from "~/hooks/use-mobile-layout";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { usePageTitle } from "~/lib/page-title";
import { cn } from "~/lib/cn";

/** On a phone, Home is the person's one conversation with Valet across every
 * workspace, with Tasks and Make: `?view=tasks` or `?view=make` opens that
 * tab. A wider screen follows the workspace switcher and shows the personal
 * or team activity dashboard. */
export const Route = createFileRoute("/")({
  validateSearch: (raw: Record<string, unknown>): { view?: "tasks" | "make" } =>
    (raw.view === "tasks" || raw.view === "make" ? { view: raw.view } : {}),
  component: Home,
});

export function Home() {
  return useMobileLayout() ? <PhoneHome /> : <WebHome />;
}

function PhoneHome() {
  const { view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  usePageTitle("Valet");
  return <HomeScreen view={view ?? "chat"}
    onViewChange={(next: HomeView) => void navigate({ search: next === "chat" ? {} : { view: next }, replace: true })} />;
}

function WebHome() {
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
