import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { Spinner } from "~/components/primitives";
import { MembersTable } from "~/components/settings/members-table";
import { InvitesPanel } from "~/components/settings/invites-panel";
import { useOrg, useOrgMembers } from "~/api/settings";

/**
 * `/settings/organization/members` — Organization · Members. Roster with
 * per-row role control, plus (admin only) the invite affordance and pending
 * invites list — `useOrg()`'s `callerRole` is the same admin signal the
 * `/settings/organization` layout guard already gates this whole route on,
 * reused here rather than re-derived so the Invite button never renders for
 * a member even if this component is reached directly (e.g. in tests).
 */
export const Route = createFileRoute("/settings/organization/members")({
  component: OrganizationMembersPage,
});

export function OrganizationMembersPage() {
  const membersQ = useOrgMembers();
  const orgQ = useOrg();
  const isAdmin = orgQ.data?.callerRole === "admin";

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
      {isAdmin && <InvitesPanel />}
    </Section>
  );
}
