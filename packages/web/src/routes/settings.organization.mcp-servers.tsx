import { createFileRoute } from "@tanstack/react-router";
import type { OrgMcpServerWire } from "@valet/api/wire";
import { Section } from "~/components/settings/section";
import { Badge, Spinner } from "~/components/primitives";
import { useOrgMcpServers } from "~/api/settings";

/**
 * `/settings/organization/mcp-servers` — Organization · MCP servers. A
 * read-only list of the remote MCP servers the deployment declares in its
 * instance config (`valet.yaml` `mcpServers`). The operator changes servers
 * in that file, so this page has no controls. Users connect per-user servers
 * on the Integrations page.
 */
export const Route = createFileRoute("/settings/organization/mcp-servers")({
  component: OrganizationMcpServersPage,
});

const AUTH_LABEL: Record<OrgMcpServerWire["auth"], string> = {
  oauth: "Per-user OAuth",
  api_key: "Per-user API key",
  bearer: "Shared token",
  none: "No auth",
};

const RISK_LABEL: Record<OrgMcpServerWire["riskLevel"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
};

export function OrganizationMcpServersPage() {
  const serversQ = useOrgMcpServers();

  return (
    <Section
      title="MCP servers"
      description="Remote MCP servers this deployment loads from its config file. To add or change a server, edit mcpServers in valet.yaml."
    >
      {serversQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {serversQ.error && (
        <div className="py-4 text-sm text-danger-500">
          Failed to load MCP servers. Reload the page to try again.
        </div>
      )}

      {serversQ.data && serversQ.data.servers.length === 0 && (
        <div className="py-4 text-sm text-muted">
          No MCP servers are declared. Add entries under mcpServers in valet.yaml.
        </div>
      )}

      {serversQ.data && serversQ.data.servers.length > 0 && (
        <ul className="divide-y divide-line">
          {serversQ.data.servers.map((server) => (
            <ServerRow key={server.name} server={server} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ServerRow({ server }: { server: OrgMcpServerWire }) {
  const titleId = `mcp-server-${server.name}`;
  return (
    <li aria-labelledby={titleId} className="flex flex-col gap-1.5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span id={titleId} className="text-sm font-medium text-ink">
          {server.displayName}
        </span>
        <Badge>{AUTH_LABEL[server.auth]}</Badge>
        <Badge>{RISK_LABEL[server.riskLevel]}</Badge>
        {!server.enabled && <Badge variant="warning">Disabled in config</Badge>}
        {server.enabled && server.connected === true && <Badge variant="success">Connected</Badge>}
        {server.enabled && server.connected === false && <Badge>Not connected</Badge>}
      </div>
      {server.description && <p className="text-xs text-muted">{server.description}</p>}
      <dl className="grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted">URL</dt>
        <dd className="break-all font-mono text-ink">{server.url}</dd>
        <dt className="text-muted">Tools</dt>
        <dd className="font-mono text-ink">{`${server.name}.*`}</dd>
        {server.scopes.length > 0 && (
          <>
            <dt className="text-muted">Scopes</dt>
            <dd className="break-all font-mono text-ink">{server.scopes.join(", ")}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
