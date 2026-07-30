import type { ReactNode } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import type { OrgPermissionWire } from "@valet/api/wire";
import { useOrg } from "~/api/settings";

/**
 * `/settings/organization` layout — guards the whole subtree behind the
 * `features.organizations` gate plus "caller holds at least one org
 * permission" (RBAC design), matching the rail's group-visibility rule.
 * Each individual page additionally guards on the *specific* permission it
 * needs via `OrgPermissionGuard` below (General → `org:manage`,
 * Members/Teams → `members:manage`, Models → `providers:manage`,
 * GitHub/Sandbox images → `infra:manage`) — an operator can reach
 * `/settings/organization/models` but not `/settings/organization` (General)
 * or `/settings/organization/members`.
 *
 * Spec: "Organization settings are managed by your org admins" for a
 * gate-on caller lacking the needed permission; "Organizations aren't
 * enabled" for gate-off — exact strings, quiet empty states, never a crash
 * or redirect loop on direct navigation.
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

  // No flash: render nothing until the gate/permissions are known rather
  // than guessing "not allowed" before data arrives.
  if (orgQ.isLoading) return null;

  if (!orgQ.data?.features.organizations) {
    return <OrgEmptyState message="Organizations aren't enabled" />;
  }

  if (orgQ.data.permissions.length === 0) {
    return <OrgEmptyState message="Organization settings are managed by your org admins" />;
  }

  return <>{children}</>;
}

/** Per-page guard for a single org permission — used inside pages whose
 * content requires more than "any org permission" (the layout's bar). */
export function OrgPermissionGuard({
  permission,
  children,
}: {
  permission: OrgPermissionWire;
  children: ReactNode;
}) {
  const orgQ = useOrg();

  if (orgQ.isLoading) return null;

  if (!orgQ.data?.features.organizations) {
    return <OrgEmptyState message="Organizations aren't enabled" />;
  }

  if (!orgQ.data.permissions.includes(permission)) {
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
