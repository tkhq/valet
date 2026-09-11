import { createFileRoute } from "@tanstack/react-router";
import { PolicyOverridesSection } from "~/components/settings/policy-overrides-section";
import { GrantsSection } from "~/components/settings/grants-section";
import { PoliciesSection } from "~/components/settings/policies-section";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { useMe, useTeams } from "~/api/settings";

/**
 * `/settings/policies` follows the workspace: team policies or personal overrides.
 * Team membership gates reads; only team admins edit. Switching scope drops drafts.
 * Per-user surface: MY policy overrides (own overrides on top of org
 * policy, bounds-checked at write time) and MY active runtime grants. Lives
 * under "You" rather than "Organization" — these rows are scoped to the
 * caller (`user.id`), not admin-managed org state, and the routes
 * (`/api/me/policy-overrides`, `/api/me/grants`) require no admin gate, so
 * they belong with the rest of the caller's own settings.
 */
export const Route = createFileRoute("/settings/policies")({
  component: PoliciesPage,
});

export function PoliciesPage() {
  const { teamId } = useWorkspaceScope();
  return teamId === undefined ? <PersonalPoliciesPage /> : <TeamPoliciesPage key={teamId} teamId={teamId} />;
}

function TeamPoliciesPage({ teamId }: { teamId: string }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  if (teamsQ.error || meQ.error) return <p role="alert">Could not load this team. Reload to check your access.</p>;
  if (!teamsQ.data || !meQ.data) return <p role="status">Loading team…</p>;
  const team = teamsQ.data.teams.find((team) => team.id === teamId);
  const orgAdmin = meQ.data.orgRole === "admin";
  if (!team || (team.callerRole === null && !orgAdmin)) return <p role="alert">Team unavailable. Choose another workspace.</p>;
  const canEdit = orgAdmin || team.callerRole === "admin";
  return <div className="space-y-6">
    <h1 className="break-words font-display text-2xl text-ink">Policies · {team.name}</h1>
    <PoliciesSection key={`${teamId}:${canEdit}`} teamId={teamId} canEdit={canEdit} />
  </div>;
}

function PersonalPoliciesPage() {
  return (
    <div className="space-y-10">
      <PolicyOverridesSection />
      <GrantsSection />
    </div>
  );
}
