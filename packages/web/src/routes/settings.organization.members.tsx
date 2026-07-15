import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { Spinner } from "~/components/primitives";
import { MembersTable } from "~/components/settings/members-table";
import { useOrgMembers } from "~/api/settings";

/**
 * `/settings/organization/members` — Organization · Members. Roster with
 * per-row role control; footer note is spec-verbatim ("Invites arrive with
 * real login.") since there's no invite/remove flow until real auth ships.
 */
export const Route = createFileRoute("/settings/organization/members")({
  component: OrganizationMembersPage,
});

export function OrganizationMembersPage() {
  const membersQ = useOrgMembers();

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
    </Section>
  );
}
