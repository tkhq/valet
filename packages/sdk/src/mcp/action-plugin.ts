import { Type } from 'typebox';
import type { TSchema } from 'typebox';
import type { ActionPlugin, CredentialProvider, PluginAction, RiskLevel } from '@valet/engine';
import { McpClient } from './client.js';
import type { McpTool, McpToolResult } from './types.js';

export interface McpActionPluginOptions {
  mcpUrl: string;
  serviceName: string;
  defaultRiskLevel: RiskLevel;
  /** When true, calls MCP server without authentication (for public services). */
  noAuth?: boolean;
  /** Send the credential as this URL query param instead of an Authorization header. */
  authQueryParam?: string;
  description?: string;
}

/**
 * v2 port of `McpActionSource` (packages/sdk/src/mcp/action-source.ts) onto
 * the engine's `ActionPlugin`/`resolveActions` dynamic-discovery seam
 * (packages/engine/src/plugin-catalog.ts). The MCP client invocation,
 * tool→action mapping, and auth header/`authQueryParam` handling are lifted
 * verbatim from `McpActionSource` — only the credential lookup (now via
 * `CredentialProvider.get()` instead of an `ActionListContext`) and the
 * return shape (`PluginAction[]` instead of `ActionDefinition[]`) differ.
 *
 * `resolveActions` is called fresh (subject to the catalog's TTL cache) for
 * every `list_tools`/`call_tool` invocation, so each generated action's
 * `execute` closure re-reads the credential via `ctx.credentials.get()`
 * rather than capturing the token resolved at discovery time — the token
 * may have been refreshed or connected in between.
 */
export function mcpActionPlugin(opts: McpActionPluginOptions): ActionPlugin {
  const client = new McpClient({
    url: opts.mcpUrl,
    serviceName: opts.serviceName,
    authQueryParam: opts.authQueryParam,
  });
  const serviceName = opts.serviceName;
  const defaultRiskLevel = opts.defaultRiskLevel;
  const noAuth = opts.noAuth ?? false;

  return {
    service: serviceName,
    description: opts.description,
    actions: [],
    resolveActions: async ({ credentials }: { credentials: CredentialProvider }) => {
      const token = await resolveToken(credentials, serviceName, noAuth);
      const tools = await client.listTools(token);
      return tools.map((tool) => mapToolToAction(tool, client, serviceName, defaultRiskLevel, noAuth));
    },
  };
}

/**
 * Mirrors the legacy `listActions`/`execute` guard: no credential and not
 * `noAuth` is a hard failure. Unlike the legacy source (which returned `[]`
 * gracefully so unauthenticated catalog listings didn't blow up), the v2
 * seam is documented to throw here — the catalog turns it into a
 * `list_tools` warning (or a `call_tool` error string) rather than silently
 * hiding the service.
 */
async function resolveToken(
  credentials: CredentialProvider,
  serviceName: string,
  noAuth: boolean,
): Promise<string | undefined> {
  if (noAuth) return undefined;
  const cred = await credentials.get();
  if (!cred) throw new Error(`${serviceName}: no credential connected`);
  return cred.accessToken;
}

function mapToolToAction(
  tool: McpTool,
  client: McpClient,
  serviceName: string,
  defaultRiskLevel: RiskLevel,
  noAuth: boolean,
): PluginAction {
  // `tool.inputSchema` is a JSON-Schema-shaped object from the MCP server.
  // TypeBox's `TSchema` is declared as an empty interface
  // (`export interface TSchema {}`), so any JSON-Schema-shaped object is
  // already structurally assignable to it — no `as` bridge needed (same
  // note as packages/workflow/src/nodes/submission-node.ts).
  const parameters: TSchema = tool.inputSchema ?? Type.Record(Type.String(), Type.Unknown());

  return {
    id: `${serviceName}.${tool.name}`,
    name: tool.name,
    description: tool.description || `${serviceName} tool: ${tool.name}`,
    riskLevel: deriveRiskLevel(tool, defaultRiskLevel),
    parameters,
    execute: async (args, ctx) => {
      const token = await resolveToken(ctx.credentials, serviceName, noAuth);
      try {
        const result = await client.callTool(token, tool.name, args);
        return mapToolResult(result);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function deriveRiskLevel(tool: McpTool, defaultRiskLevel: RiskLevel): RiskLevel {
  if (tool.annotations?.readOnlyHint) return 'low';
  if (tool.annotations?.destructiveHint) return 'critical';
  return defaultRiskLevel;
}

function mapToolResult(result: McpToolResult): { success: boolean; data?: unknown; error?: string } {
  if (!result || !result.content) {
    return { success: false, error: 'MCP tool returned empty response' };
  }

  if (result.isError) {
    const errorText = result.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
    return { success: false, error: errorText || 'MCP tool returned an error' };
  }

  const textParts = result.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
  const data = textParts.length === 1 ? textParts[0] : textParts.join('\n');

  return { success: true, data };
}
