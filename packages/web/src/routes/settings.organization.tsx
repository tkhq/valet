import type { ReactNode } from "react";
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { Button } from "~/components/primitives";
import { ORG_ONEPASSWORD_PATH, ORG_TEAMS_PATH } from "~/components/settings/settings-rail";

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

/**
 * True when `pathname` is a page every org member may open: Teams (or a
 * descendant of it), and 1Password. The router matches routes
 * slash-tolerantly and case-insensitively while `location.pathname` stays
 * raw, so a pasted "/settings/organization/teams/" must not read as a
 * different page.
 *
 * 1Password is here because the page carries the member's own personal
 * service-account token beside the admin-only org token: the panel already
 * hides the org row and the toggle from a non-admin, and
 * `GET /api/onepassword/settings` answers any member. Without it the
 * allow-personal toggle an admin turns on has no member-facing surface at
 * all, and a member can neither connect nor revoke their own token.
 */
export function isMemberVisiblePath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  if (normalized === ORG_ONEPASSWORD_PATH) return true;
  return normalized === ORG_TEAMS_PATH || normalized.startsWith(`${ORG_TEAMS_PATH}/`);
}

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

  // A failed org fetch with no cache must not read as "gate off" — that is
  // a statement about org configuration the client does not know. Say what
  // failed and offer the retry.
  if (orgQ.isError && !orgQ.data) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted">
        <p>Failed to load organization settings.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => void orgQ.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!orgQ.data?.features.organizations) {
    return <OrgEmptyState message="Organizations aren't enabled" />;
  }

  if (orgQ.data.callerRole !== "admin" && !isMemberVisiblePath(pathname)) {
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
