import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { Spinner } from "~/components/primitives";
import { TeamsPanel } from "~/components/settings/teams-panel";
import { TeamSyncSection } from "~/components/settings/team-sync-section";
import { useOrgDirectory } from "~/api/settings";

/**
 * `/settings/organization/teams` — Organization · Teams, the first-ever
 * teams management UI over the existing `/api/teams` router. Open to every
 * org member (amended 2026-08-28): any member can create a team, and the
 * creator administers it as its team admin. The org directory
 * (`useOrgDirectory()`) — not the admin-only roster — resolves member
 * display names and builds the "not yet on this team" add-member list, so
 * the picker works for a team admin who is not an org admin.
 *
 * `TeamSyncSection` sits above the panel because the teams it governs are
 * on this page: it is the gate that decides whether an `origin: "idp"` row
 * below reads "Identity provider" (locked) or "(paused)" (editable). It
 * self-gates to org admins.
 */
export const Route = createFileRoute("/settings/organization/teams")({
  component: OrganizationTeamsPage,
});

export function OrganizationTeamsPage() {
  const directoryQ = useOrgDirectory();

  return (
    <Section title="Teams" description="Group members for scoped session access.">
      <TeamSyncSection />
      {directoryQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {directoryQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load organization members.</p>
      )}
      {directoryQ.data && <TeamsPanel orgMembers={directoryQ.data.users} />}
    </Section>
  );
}
