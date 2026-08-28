import type { ReactNode } from "react";
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";

/**
 * `/settings/organization` layout — guards the org sections behind the
 * feature gate, and all but Teams behind org admin, matching the rail's
 * visibility rule (spec: "Organization settings are managed by your org
 * admins" for a gate-on non-admin; "Organizations aren't enabled" for
 * gate-off — exact strings, quiet empty states, never a crash or redirect
 * loop on direct navigation).
 *
 * Teams (amended 2026-08-28) admits every org member: any member can
 * create a team and administer the teams they created, so the page itself
 * scopes what it shows (`GET /api/teams` returns only the caller's teams
 * to a plain member, and the panel hides controls the API would refuse).
 */
export const Route = createFileRoute("/settings/organization")({
  component: OrganizationLayout,
});

/** The org sub-route every org member may open; the rest are admin-only. */
const MEMBER_VISIBLE_PATH = "/settings/organization/teams";

export function OrganizationLayout() {
  return (
    <OrgRouteGuard>
      <Outlet />
    </OrgRouteGuard>
  );
}

export function OrgRouteGuard({ children }: { children: ReactNode }) {
  const orgQ = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // No flash: render nothing until the gate/role are known rather than
  // guessing "not allowed" before data arrives.
  if (orgQ.isLoading) return null;

  if (!orgQ.data?.features.organizations) {
    return <OrgEmptyState message="Organizations aren't enabled" />;
  }

  if (orgQ.data.callerRole !== "admin" && pathname !== MEMBER_VISIBLE_PATH) {
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
