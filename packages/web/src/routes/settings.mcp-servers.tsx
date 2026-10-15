import { createFileRoute } from "@tanstack/react-router";
import { useOrg } from "~/api/settings";
import { EmptyRow, ErrorRow } from "~/components/primitives";
import { OrganizationMcpServersPage } from "./settings.organization.mcp-servers";

/**
 * `/settings/mcp-servers` — the config-declared MCP server list while the
 * organizations feature is off. Same page as
 * `/settings/organization/mcp-servers`, but outside the organization route
 * guard: a single-org deployment still loads these servers. The rail shows
 * this entry under Personal workspace only while the Organization group is
 * hidden, and only to an org admin (see `settings-rail.tsx`).
 */
export const Route = createFileRoute("/settings/mcp-servers")({
  component: SettingsMcpServersPage,
});

/**
 * Admits an org admin only, the same `callerRole` rule as the rail.
 * `GET /api/org/mcp-servers` returns 403 to anyone else, so a non-admin who
 * opens the URL gets this notice instead of a failed list.
 */
export function SettingsMcpServersPage() {
  const orgQ = useOrg();
  // Render nothing until the role is known, so a non-admin never sees the
  // list start to load.
  if (orgQ.isLoading) return null;
  if (!orgQ.data) {
    return <ErrorRow>Failed to load organization settings. Reload the page to try again.</ErrorRow>;
  }
  if (orgQ.data.callerRole !== "admin") {
    return <EmptyRow>Only an organization admin can view MCP servers. To see them, ask an organization admin.</EmptyRow>;
  }
  return <OrganizationMcpServersPage />;
}
