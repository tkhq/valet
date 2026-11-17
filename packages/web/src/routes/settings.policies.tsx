import { createFileRoute } from "@tanstack/react-router";
import { PolicyOverridesSection } from "~/components/settings/policy-overrides-section";
import { GrantsSection } from "~/components/settings/grants-section";
import { TeamPolicyOverrides } from "~/components/settings/team-policy-overrides";
import { SectionHeading } from "~/components/settings/section";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { PinnedWorkspaceScope, useWorkspaceScope } from "~/lib/workspace-scope";
import { useMe, useTeams } from "~/api/settings";

/**
 * `PoliciesPage` follows the pinned scope: personal overrides on
 * `/settings/policies`, team policies on `/settings/teams/$teamId/policies`.
 * Team membership gates reads; only team admins edit. Switching scope drops drafts.
 * The personal page shows the caller's own overrides on top of org policy
 * (bounds-checked at write time) and the caller's active runtime grants. It
 * sits under Personal rather than Organization: these rows are scoped to the
 * caller (`user.id`), and the routes (`/api/me/policy-overrides`,
 * `/api/me/grants`) require no admin gate.
 */
export const Route = createFileRoute("/settings/policies")({
  component: () => (
    <PinnedWorkspaceScope teamId={undefined}>
      <PoliciesPage />
    </PinnedWorkspaceScope>
  ),
});

export function PoliciesPage() {
  const { teamId } = useWorkspaceScope();
  return teamId === undefined ? <PersonalPoliciesPage /> : <TeamPoliciesPage key={teamId} teamId={teamId} />;
}

function TeamPoliciesPage({ teamId }: { teamId: string }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  if (teamsQ.error || meQ.error) return <ErrorRow>Could not load this team. Reload to check your access.</ErrorRow>;
  if (!teamsQ.data || !meQ.data) return <LoadingRow label="Loading team…" />;
  const team = teamsQ.data.teams.find((team) => team.id === teamId);
  const orgAdmin = meQ.data.orgRole === "admin";
  if (!team || (team.callerRole === null && !orgAdmin)) {
    return <ErrorRow>You are not a member of this team. Choose a team under Your teams.</ErrorRow>;
  }
  const canEdit = orgAdmin || team.callerRole === "admin";
  return <TeamPolicyOverrides key={`${teamId}:${canEdit}`} teamId={teamId} canEdit={canEdit} />;
}

function PersonalPoliciesPage() {
  return (
    <div className="space-y-10">
      <SectionHeading title="Policies" description="Your own overrides on top of organization policy, and your active grants." />
      <PolicyOverridesSection />
      <GrantsSection />
    </div>
  );
}
