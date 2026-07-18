import { createFileRoute } from "@tanstack/react-router";
import { ActionLogSection } from "~/components/settings/action-log-section";

/**
 * `/settings/organization/action-log` — Organization · Action log
 * (action-policies plan, Task 5). Renders inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/action-log")({
  component: OrganizationActionLogPage,
});

export function OrganizationActionLogPage() {
  return <ActionLogSection />;
}
