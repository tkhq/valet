import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "./usage";

/**
 * `/settings/organization/usage` — Organization · Models and usage · Usage:
 * every member's spend, with the by-member table. It renders inside
 * `/settings/organization`'s `OrgRouteGuard`, which admits only an org
 * admin here. Personal Usage shows the viewer's own spend only.
 */
export const Route = createFileRoute("/settings/organization/usage")({
  component: OrganizationUsagePage,
});

export function OrganizationUsagePage() {
  return <UsagePage org />;
}
