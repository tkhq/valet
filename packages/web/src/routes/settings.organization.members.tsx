import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { Spinner } from "~/components/primitives";
import { MembersTable } from "~/components/settings/members-table";
import { InvitesPanel } from "~/components/settings/invites-panel";
import { useHasPermission, useOrgMembers } from "~/api/settings";
import { OrgPermissionGuard } from "./settings.organization";

/**
 * `/settings/organization/members` — Organization · Members. Roster with
 * per-row role control, plus (permission-gated) the invite affordance and
 * pending invites list — `useOrg()`'s `permissions` carries the
 * `members:manage` signal the `/settings/organization` layout guard only
 * checks loosely ("any org permission"); this page re-checks the specific
 * permission it needs, both to gate the whole route and to gate the Invite
 * button so it never renders for a caller without `members:manage` even if
 * this component is reached directly (e.g. in tests).
 */
export const Route = createFileRoute("/settings/organization/members")({
  component: OrganizationMembersPage,
});

export function OrganizationMembersPage() {
  return (
    <OrgPermissionGuard permission="members:manage">
      <OrganizationMembersPageContent />
    </OrgPermissionGuard>
  );
}

function OrganizationMembersPageContent() {
  const membersQ = useOrgMembers();
  const canManageMembers = useHasPermission("members:manage");

  return (
    <Section title="Members" description="Everyone in your organization.">
      {membersQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {membersQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load members.</p>
      )}
      {membersQ.data && <MembersTable members={membersQ.data.members} />}
      {canManageMembers && <InvitesPanel />}
    </Section>
  );
}
