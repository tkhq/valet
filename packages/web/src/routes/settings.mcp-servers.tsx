import { createFileRoute } from "@tanstack/react-router";
import { OrganizationMcpServersPage } from "./settings.organization.mcp-servers";

/**
 * `/settings/mcp-servers` — the config-declared MCP server list while the
 * organizations feature is off. Same page as
 * `/settings/organization/mcp-servers`, but outside the organization route
 * guard: a single-org deployment still loads these servers, and
 * `GET /api/org/mcp-servers` answers any org member with the gate off. The
 * rail shows this entry under Personal workspace only while the
 * Organization group is hidden (see `settings-rail.tsx`), the same rule as
 * `/settings/models`.
 */
export const Route = createFileRoute("/settings/mcp-servers")({
  component: OrganizationMcpServersPage,
});
