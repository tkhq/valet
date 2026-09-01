import { createFileRoute } from "@tanstack/react-router";
import { OnePasswordPanel } from "~/components/integrations/onepassword-panel";

/**
 * `/settings/organization/onepassword` — Organization · 1Password: the org
 * and personal service-account tokens, and the `op://` reference credentials
 * built from them. Renders inside `/settings/organization`'s `OrgRouteGuard`,
 * so there is no per-page admin re-check.
 *
 * It sits beside GitHub and Slack rather than on `/integrations`: those are
 * per-provider setup pages, and this is the same kind of thing. The
 * integrations grid answers "what can the assistant reach", which a token
 * form and a credential table crowded out.
 */
export const Route = createFileRoute("/settings/organization/onepassword")({
  component: OrganizationOnePasswordPage,
});

export function OrganizationOnePasswordPage() {
  return <OnePasswordPanel />;
}
