/**
 * What one `tools/list` call says about a connection (MCP health probe,
 * docs/specs/2026-07-20-integration-oauth-design.md). The api calls
 * `McpActionPlugin.probe` when it lists a connected service's tools for the
 * Integrations page, so a provider-side change shows there before a run
 * fails on it.
 */
import type { PluginAction } from '@valet/engine';
import { McpHttpError } from './client.js';
import type { McpTool } from './types.js';

export type McpProbeResult =
  /** The server listed its tools. `actions` is that listing mapped the way
   * `resolveActions` maps it (service-qualified ids, risk from annotations,
   * the input schema as `parameters`), so a caller can cache the tool schema
   * from one call. `missingScopes` are the scopes the grant lacks for the
   * `blockedTools` tools that declare `securitySchemes`. */
  | { kind: 'listed'; actions: PluginAction[]; missingScopes: string[]; blockedTools: number }
  /** The server refused the listing with `insufficient_scope` and named at
   * least one scope the grant lacks. */
  | { kind: 'insufficient_scope'; missingScopes: string[] }
  /** The server refused the credential: a 401, or any other 403. */
  | { kind: 'rejected' };

export interface BearerChallenge {
  /** RFC 6750 §3.1 error code, e.g. `invalid_token`, `insufficient_scope`. */
  error?: string;
  /** The challenge's space-separated `scope` parameter, split. */
  scope?: string[];
}

const BEARER_SCHEME = /^\s*bearer(?:\s+|$)/i;
// One RFC 7235 auth-param: a token name, then a token or a quoted string.
// Sticky, so each match starts where the previous one ended and a name
// inside a quoted value is never read as a parameter.
const AUTH_PARAM = /\s*,?\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))/y;

/** Reads the `error` and `scope` parameters of a Bearer challenge. Returns
 * an empty object for another scheme. */
export function parseBearerChallenge(header: string): BearerChallenge {
  const scheme = BEARER_SCHEME.exec(header);
  if (!scheme) return {};
  const rest = header.slice(scheme[0].length);
  const params = new Map<string, string>();
  AUTH_PARAM.lastIndex = 0;
  for (let match = AUTH_PARAM.exec(rest); match; match = AUTH_PARAM.exec(rest)) {
    const name = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
    if (!params.has(name)) params.set(name, value);
  }
  const challenge: BearerChallenge = {};
  const error = params.get('error');
  if (error) challenge.error = error;
  const scope = params.get('scope')?.split(' ').filter(Boolean);
  if (scope && scope.length > 0) challenge.scope = scope;
  return challenge;
}

/**
 * The scopes a grant lacks for the tools that declare `securitySchemes`.
 * A tool is blocked when it declares schemes and the grant satisfies none:
 * `noauth` is always satisfied, `oauth2` when the grant holds all its
 * scopes. A blocked tool contributes the scopes of its nearest `oauth2`
 * scheme. A tool whose schemes are all of other types is not judged.
 *
 * `granted` undefined means the grant is unknown (a pasted token stores no
 * scopes), so nothing is judged. An empty array is a grant with no scopes.
 */
export function scopeGaps(
  tools: readonly McpTool[],
  granted: readonly string[] | undefined,
): { missingScopes: string[]; blockedTools: number } {
  if (granted === undefined) return { missingScopes: [], blockedTools: 0 };
  const held = new Set(granted);
  const missing = new Set<string>();
  let blockedTools = 0;
  for (const tool of tools) {
    let nearest: string[] | undefined;
    for (const scheme of tool.securitySchemes ?? []) {
      if (scheme.type === 'noauth') {
        nearest = [];
        break;
      }
      if (scheme.type !== 'oauth2') continue;
      const lacks = (scheme.scopes ?? []).filter((scope) => !held.has(scope));
      if (nearest === undefined || lacks.length < nearest.length) nearest = lacks;
    }
    if (nearest === undefined || nearest.length === 0) continue;
    blockedTools += 1;
    for (const scope of nearest) missing.add(scope);
  }
  return { missingScopes: [...missing].sort(), blockedTools };
}

/**
 * Classifies a failed `tools/list` that says something about the
 * credential. Returns undefined for any other failure (transport, 5xx,
 * JSON-RPC error), which says nothing about the connection.
 */
export function refusedListing(err: unknown, granted: readonly string[] | undefined): McpProbeResult | undefined {
  if (!(err instanceof McpHttpError)) return undefined;
  if (err.status === 401) return { kind: 'rejected' };
  if (err.status !== 403) return undefined;
  const challenge = err.wwwAuthenticate ? parseBearerChallenge(err.wwwAuthenticate) : {};
  if (challenge.error === 'insufficient_scope') {
    const held = new Set(granted ?? []);
    const missingScopes = [...new Set(challenge.scope ?? [])].filter((scope) => !held.has(scope)).sort();
    if (missingScopes.length > 0) return { kind: 'insufficient_scope', missingScopes };
  }
  return { kind: 'rejected' };
}
