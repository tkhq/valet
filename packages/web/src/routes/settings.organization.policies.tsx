import { createFileRoute } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { PolicyBuilder } from "~/components/settings/policy-builder/policy-builder";

export const Route = createFileRoute("/settings/organization/policies")({
  component: OrganizationPoliciesPage,
});

export function OrganizationPoliciesPage() {
  const org = useOrg();
  if (!org.data)
    return (
      <p role="status" className="text-sm text-muted">
        Loading policy context…
      </p>
    );
  return <PolicyBuilder owner={{ kind: "org", id: org.data.id }} />;
}
