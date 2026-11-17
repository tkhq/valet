import { createFileRoute } from "@tanstack/react-router";
import { SecretsSection } from "~/components/settings/secrets-section";

/**
 * `/settings/organization/secrets` — Organization · Security and audit ·
 * Secrets: the secrets every session in the organization can use. It renders
 * inside `/settings/organization`'s `OrgRouteGuard`, which admits only an
 * org admin here.
 */
export const Route = createFileRoute("/settings/organization/secrets")({
  component: OrganizationSecretsPage,
});

export function OrganizationSecretsPage() {
  return <SecretsSection target={{ scope: "company" }} />;
}
