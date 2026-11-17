import { createFileRoute } from "@tanstack/react-router";
import { useTeams } from "~/api/settings";
import { EmptyRow } from "~/components/primitives";
import { SectionHeading } from "~/components/settings/section";
import { UsagePage } from "./usage";

/** A team's spend. The team layout pins the team's scope. */
export const Route = createFileRoute("/settings/teams/$teamId/usage")({
  component: function TeamUsageRoute() {
    return <TeamUsageTab teamId={Route.useParams().teamId} />;
  },
});

/**
 * The usage API answers a team's spend to its members only. An org admin
 * who opens a team they are not on gets a pointer to the organization's
 * spend, not a request that the API refuses.
 */
export function TeamUsageTab({ teamId }: { teamId: string }) {
  const team = useTeams().data?.teams.find((t) => t.id === teamId);
  if (team?.callerRole === null) {
    return (
      <div className="space-y-3">
        <SectionHeading title="Usage" />
        <EmptyRow>Only members of this team can see its usage. To see spend for the whole organization, open Organization → Models and usage → Usage.</EmptyRow>
      </div>
    );
  }
  return <UsagePage />;
}
