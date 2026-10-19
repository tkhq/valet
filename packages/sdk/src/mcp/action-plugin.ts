import { decode as decodeToon } from '@toon-format/toon';
import { Type } from 'typebox';
import type { TSchema } from 'typebox';
import type { ActionPlugin, CredentialProvider, CredentialSource, PluginAction, RiskLevel } from '@valet/engine';
import { hasToonCollectionMarker } from '@valet/shared';
import { McpClient, McpHttpError } from './client.js';
import type { McpTool, McpToolResult } from './types.js';

export interface McpActionPluginOptions {
  mcpUrl: string;
  serviceName: string;
  defaultRiskLevel: RiskLevel;
  /** When true, calls MCP server without authentication (for public services). */
  noAuth?: boolean;
  /**
   * Fixed bearer token sent on every call, instead of a per-user stored
   * credential. For servers whose token is instance-wide (config-declared
   * MCP servers with `auth: bearer`). No connect flow: the service's tools
   * are visible to every user.
   */
  staticToken?: string;
  /** Send the credential as this URL query param instead of an Authorization header. */
  authQueryParam?: string;
  /**
   * Credential service to fall back to when the caller has no personal
   * `serviceName` credential connected — the native integration's app
   * identity (docs/specs/2026-10-15-native-integration-credential-policy-design.md
   * Part C). The personal credential always wins when present. Applies to
   * both tool discovery and execute.
   */
  appCredentialService?: string;
  /**
   * Human-readable name for user-facing error text (e.g. "Linear"). Falls
   * back to `serviceName` when absent.
   */
  displayName?: string;
  /**
   * Where an admin reconnects the app identity, as a settings path in words
   * (for example "Settings, Organization, Linear"). The app-token rejection
   * message names it. When absent, the message names no page.
   */
  appConnectHint?: string;
  description?: string;
}

/** The names an auth-rejection message uses. */
interface RejectionText {
  /** `displayName`, or `serviceName` when absent. */
  label: string;
  appConnectHint?: string;
}

interface ResolvedToken {
  token: string | undefined;
  /** Absent for `noAuth`/`staticToken`: no personal or app connection to name. */
  source?: CredentialSource;
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
  const staticToken = opts.staticToken;
  const appCredentialService = opts.appCredentialService;
  const messages: RejectionText = { label: opts.displayName ?? serviceName, appConnectHint: opts.appConnectHint };

  return {
    service: serviceName,
    description: opts.description,
    actions: [],
    requiresCredential: !noAuth && staticToken === undefined,
    appCredentialService,
    resolveActions: async ({ credentials }: { credentials: CredentialProvider }) => {
      const { token, source } = await resolveToken(credentials, serviceName, noAuth, staticToken, appCredentialService);
      let tools: McpTool[];
      try {
        tools = await client.listTools(token);
      } catch (err) {
        const rejection = authRejectionMessage(err, source, messages);
        throw rejection ? new Error(rejection) : err;
      }
      return tools.map((tool) =>
        mapToolToAction(tool, client, serviceName, defaultRiskLevel, noAuth, staticToken, appCredentialService, messages),
      );
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
 *
 * When `appCredentialService` is set and the caller has no personal
 * `serviceName` credential, fall back to the named app-identity service
 * before refusing (Part C, native-integration-credential-policy). The
 * personal credential always wins when present.
 */
async function resolveToken(
  credentials: CredentialProvider,
  serviceName: string,
  noAuth: boolean,
  staticToken?: string,
  appCredentialService?: string,
): Promise<ResolvedToken> {
  if (noAuth) return { token: undefined };
  if (staticToken !== undefined) return { token: staticToken };
  const cred = await credentials.get();
  // A host that does not say whose account it is gives the caller's own.
  if (cred) return { token: cred.accessToken, source: cred.source ?? { kind: 'personal' } };
  if (appCredentialService) {
    const appCred = await credentials.get(appCredentialService);
    if (appCred) return { token: appCred.accessToken, source: { kind: 'app' } };
  }
  throw new Error(`${serviceName}: no credential connected`);
}

/**
 * The MCP server rejected the bearer token (401/403): the connection it
 * answered with is bad, not the request. Name which credential it was and
 * the fix, per CLAUDE.md's "every user-facing error names the corrective
 * action" rule. The fix goes to whoever holds the account: the caller for
 * their own, the team owner for the team's, the sharing member for a share,
 * an admin for the org's or the app's. Returns undefined for any other failure (bad request,
 * transport error, 5xx) — those keep today's verbatim error text, and for
 * `noAuth`/`staticToken` calls there is no personal/app connection to name.
 *
 * Detects the rejection via `McpHttpError.status`, not a text match on the
 * message: the message's tail is the server's own response body (up to 200
 * chars, verbatim), so a 500 whose body happens to say "upstream returned
 * HTTP 401" must not be misclassified as an auth rejection.
 */
function authRejectionMessage(
  err: unknown,
  source: CredentialSource | undefined,
  { label, appConnectHint }: RejectionText,
): string | undefined {
  if (!source) return undefined;
  if (!(err instanceof McpHttpError) || (err.status !== 401 && err.status !== 403)) return undefined;
  const own = `connect your own ${label} account on the Integrations page`;
  switch (source.kind) {
    case 'app': {
      const where = appConnectHint ? ` in ${appConnectHint}` : '';
      return `${label} rejected the Valet app's access. Ask an admin to reconnect the ${label} app${where}, or ${own}.`;
    }
    case 'team':
      return `${label} rejected the team's ${label} connection. Ask the team owner to reconnect ${label} for the team, or ${own}.`;
    case 'shared': {
      const member = source.memberName ?? 'the member who shared it';
      return `${label} rejected the ${label} account that ${member} shared with the team. Ask ${member} to reconnect ${label}, or ${own}.`;
    }
    case 'org':
      return `${label} rejected the organization's ${label} credential. Ask an organization admin to reconnect ${label} in Settings, Organization, or ${own}.`;
    case 'vault':
      return `${label} rejected the token from its 1Password item. Ask the owner of the ${label} item in 1Password to update it, or ${own}.`;
    case 'personal':
      return `${label} rejected your connected account. Reconnect ${label} on the Integrations page.`;
  }
}

function mapToolToAction(
  tool: McpTool,
  client: McpClient,
  serviceName: string,
  defaultRiskLevel: RiskLevel,
  noAuth: boolean,
  staticToken: string | undefined,
  appCredentialService: string | undefined,
  messages: RejectionText,
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
      const { token, source } = await resolveToken(ctx.credentials, serviceName, noAuth, staticToken, appCredentialService);
      try {
        const result = await client.callTool(token, tool.name, args);
        return mapToolResult(result);
      } catch (err) {
        const rejection = authRejectionMessage(err, source, messages);
        if (rejection) return { success: false, error: rejection };
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Map MCP tool annotations (spec 2025-03-26) to a risk level. Only explicit
 * hints move risk: the spec defines defaults for absent hints
 * (destructiveHint true, openWorldHint true), but we cannot tell "server
 * chose the default" from "server never set annotations", so absent hints
 * keep the service default instead of inflating every unannotated write
 * to critical.
 *
 * Explicit hints override the service default in BOTH directions — the
 * configured riskLevel is the assumption for unannotated tools, not a cap
 * or a floor. A `low` service default does not keep an open-world write at
 * `low`, just as destructiveHint true has always raised any default to
 * critical.
 */
function deriveRiskLevel(tool: McpTool, defaultRiskLevel: RiskLevel): RiskLevel {
  const hints = tool.annotations;
  if (!hints) return defaultRiskLevel;
  if (hints.readOnlyHint === true) return 'low';
  if (hints.destructiveHint === true) return 'critical';
  if (hints.destructiveHint === false) {
    // Declared non-destructive write. Idempotent → retry-safe update.
    // Open-world without idempotency → outward side effects (e.g. send
    // email) that cannot be un-sent, so gate harder than a plain write.
    if (hints.idempotentHint === true) return 'medium';
    if (hints.openWorldHint === true) return 'high';
  }
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

  if (result.structuredContent !== undefined) {
    return { success: true, data: result.structuredContent };
  }

  const textParts = result.content
    .filter((c): c is typeof c & { text: string } => c.type === 'text' && typeof c.text === 'string' && c.text.length > 0)
    .map((c) => c.text);
  const text = textParts.length === 1 ? textParts[0] : textParts.join('\n');
  return { success: true, data: tryParseJson(text) ?? tryDecodeToon(text) ?? text };
}

function asStructured(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? value : undefined;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;
  try {
    return asStructured(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function tryDecodeToon(text: string): unknown {
  // MCP text remains collection-only because it has no trusted engine boundary.
  if (!hasToonCollectionMarker(text)) return undefined;
  try {
    return asStructured(decodeToon(text));
  } catch {
    return undefined;
  }
}
