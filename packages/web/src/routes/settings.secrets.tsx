import { createFileRoute } from "@tanstack/react-router";
import { SecretsSection } from "~/components/settings/secrets-section";

/** `/settings/secrets` — your personal secrets. A team's are on its Secrets
 * tab, and the organization's on Organization · Security and audit. */
export const Route = createFileRoute("/settings/secrets")({
  component: SecretsPage,
});

export function SecretsPage() {
  return <SecretsSection target={{ scope: "personal" }} />;
}
