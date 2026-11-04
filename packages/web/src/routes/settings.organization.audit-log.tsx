import { createFileRoute } from "@tanstack/react-router";
import { AuditLogSection } from "~/components/settings/audit-log-section";

/**
 * `/settings/organization/audit-log` — Organization · Audit log. Renders
 * inside `/settings/organization`'s `OrgRouteGuard`, so there is no
 * per-page admin check here. The api refuses non-admins with 403.
 */
export const Route = createFileRoute("/settings/organization/audit-log")({
  component: AuditLogSection,
});
