import { createFileRoute } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { usePolicyDraftContexts } from "~/api/policy-authoring";
import { PolicyBuilder } from "~/components/settings/policy-builder/policy-builder";

export const Route = createFileRoute("/settings/organization/policies")({
  component: OrganizationPoliciesPage,
});

export function OrganizationPoliciesPage() {
  const org = useOrg();
  const contexts = usePolicyDraftContexts();
  if (!org.data)
    return (
      <p role="status" className="text-sm text-muted">
        Loading policy context…
      </p>
    );
  if (contexts.error) return <p role="alert" className="text-sm text-danger">Policy contexts are unavailable. Reload the page to try again.</p>;
  if (!contexts.data) return <p role="status" className="text-sm text-muted">Loading policy contexts…</p>;
  return <PolicyBuilder contexts={contexts.data.contexts} owner={{ kind: "org", id: org.data.id }} />;
}
