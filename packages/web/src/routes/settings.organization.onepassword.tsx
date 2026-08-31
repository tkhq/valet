import { createFileRoute, Navigate } from "@tanstack/react-router";

/**
 * Old Organization · 1Password URL. 1Password now lives on `/integrations`.
 */
export const Route = createFileRoute("/settings/organization/onepassword")({
  component: OrganizationOnePasswordRedirect,
});

export function OrganizationOnePasswordRedirect() {
  return <Navigate to="/integrations" />;
}
