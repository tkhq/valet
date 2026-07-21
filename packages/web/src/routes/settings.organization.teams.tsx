import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { Spinner } from "~/components/primitives";
import { TeamsPanel } from "~/components/settings/teams-panel";
import { useOrgMembers } from "~/api/settings";
import { OrgPermissionGuard } from "./settings.organization";

/**
 * `/settings/organization/teams` — Organization · Teams, the first-ever
 * teams management UI over the existing `/api/teams` router. Needs the org
 * roster (`useOrgMembers()`) to resolve member display names and to build
 * the "not yet on this team" add-member list. Gated on `members:manage`
 * (RBAC design) — same permission as `/settings/organization/members`,
 * since the API's team routes gate on the same permission.
 */
export const Route = createFileRoute("/settings/organization/teams")({
  component: OrganizationTeamsPage,
});

export function OrganizationTeamsPage() {
  return (
    <OrgPermissionGuard permission="members:manage">
      <OrganizationTeamsPageContent />
    </OrgPermissionGuard>
  );
}

function OrganizationTeamsPageContent() {
  const membersQ = useOrgMembers();

  return (
    <Section title="Teams" description="Group members for scoped session access.">
      {membersQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {membersQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load organization members.</p>
      )}
      {membersQ.data && <TeamsPanel orgMembers={membersQ.data.members} />}
    </Section>
  );
}
