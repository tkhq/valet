import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useOrg, useTeams } from "~/api/settings";
import { ErrorRow, LinkTabs, LoadingRow, type AppPath, type LinkTab } from "~/components/primitives";
import { ActiveTabLabel } from "~/components/settings/section";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { normalizeSettingsPath } from "~/components/settings/settings-rail";
import { PinnedWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/settings/teams/$teamId` — one team's settings, chosen by name in the
 * rail rather than by the workspace switcher (settings-redesign spec,
 * decision 2). The tabs pin this team's scope, so the sections they render
 * (`TeamsPanel`, API keys, proxy, policies) read it through
 * `useWorkspaceScope()` unchanged.
 */
export const Route = createFileRoute("/settings/teams/$teamId")({
  component: TeamSettingsLayout,
});

function TeamSettingsLayout() {
  const { teamId } = Route.useParams();
  return <TeamSettingsShell teamId={teamId} />;
}

export function TeamSettingsShell({ teamId }: { teamId: string }) {
  const orgQ = useOrg();
  const teamsQ = useTeams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (orgQ.isLoading || teamsQ.isLoading) return <LoadingRow label="Loading team settings…" />;
  if (teamsQ.error || orgQ.error) return <ErrorRow>Could not load your teams. Reload the page to try again.</ErrorRow>;
  const team = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations).find((t) => t.id === teamId);
  if (!team) {
    return <ErrorRow>You are not a member of this team. Choose a team under Your teams.</ErrorRow>;
  }

  const tabs: LinkTab[] = [
    { to: "/settings/teams/$teamId", label: "General", params: { teamId } },
    { to: "/settings/teams/$teamId/access", label: "API keys and proxy", params: { teamId } },
    { to: "/settings/teams/$teamId/policies", label: "Policies", params: { teamId } },
  ];
  const path = normalizeSettingsPath(pathname);
  const activeTo: AppPath = path.endsWith("/access")
    ? "/settings/teams/$teamId/access"
    : path.endsWith("/policies")
      ? "/settings/teams/$teamId/policies"
      : "/settings/teams/$teamId";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium text-ink">{team.name}</h2>
        <Link to="/chat" search={{ workspace: teamId }} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
          Open team threads
        </Link>
      </div>
      <LinkTabs tabs={tabs} activeTo={activeTo} label={`${team.name} settings`} />
      <PinnedWorkspaceScope teamId={teamId}>
        <ActiveTabLabel.Provider value={tabs.find((tab) => tab.to === activeTo)?.label}>
          {/* Drop drafts and open dialogs when the team changes. */}
          <Outlet key={teamId} />
        </ActiveTabLabel.Provider>
      </PinnedWorkspaceScope>
    </div>
  );
}
