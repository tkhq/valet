import { createFileRoute } from "@tanstack/react-router";
import { SecretsSection } from "~/components/settings/secrets-section";

/** A team's Secrets tab. Any team member may change them; the API reports
 * that as `canWrite`, so an org admin who is not on the team reads them. */
export const Route = createFileRoute("/settings/teams/$teamId/secrets")({
  component: function TeamSecretsRoute() {
    return <TeamSecretsTab teamId={Route.useParams().teamId} />;
  },
});

export function TeamSecretsTab({ teamId }: { teamId: string }) {
  return <SecretsSection target={{ scope: "team", teamId }} />;
}
