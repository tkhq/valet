import type { ReactNode } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";

/**
 * `/settings/organization` layout — guards General/Members/Teams behind
 * gate+admin, matching the rail's visibility rule (spec: "Organization
 * settings are managed by your org admins" for a gate-on non-admin;
 * "Organizations aren't enabled" for gate-off — exact strings, quiet empty
 * states, never a crash or redirect loop on direct navigation).
 */
export const Route = createFileRoute("/settings/organization")({
  component: OrganizationLayout,
});

export function OrganizationLayout() {
  return (
    <OrgRouteGuard>
      <Outlet />
    </OrgRouteGuard>
  );
}

export function OrgRouteGuard({ children }: { children: ReactNode }) {
  const orgQ = useOrg();

  // No flash: render nothing until the gate/role are known rather than
  // guessing "not allowed" before data arrives.
  if (orgQ.isLoading) return null;

  if (!orgQ.data?.features.organizations) {
    return <OrgEmptyState message="Organizations aren't enabled" />;
  }

  if (orgQ.data.callerRole !== "admin") {
    return <OrgEmptyState message="Organization settings are managed by your org admins" />;
  }

  return <>{children}</>;
}

function OrgEmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6 py-10 text-center text-sm text-muted">
      <p>{message}</p>
    </div>
  );
}
