import { decode as decodeToon } from '@toon-format/toon';
import { z } from 'zod';
import type {
  ActionDefinition,
  ActionSource,
  ActionListContext,
  ActionContext,
  ActionResult,
  RiskLevel,
} from '../integrations/index.js';
import { McpClient } from './client.js';
import type { McpTool } from './types.js';

export interface McpActionSourceOptions {
  mcpUrl: string;
  serviceName: string;
  defaultRiskLevel?: RiskLevel;
  /** When true, calls MCP server without authentication (for public services). */
  noAuth?: boolean;
  /** When set, token is sent as this URL query parameter instead of Authorization header. */
  authQueryParam?: string;
  tokenAuthHeader?: { name: string; prefix?: string | null };
  additionalHeaders?: Record<string, string>;
  staticAuthHeader?: { name: string; value: string };
  staticAuthQueryParam?: { name: string; value: string };
  fetch?: typeof fetch;
}

/**
 * ActionSource backed by an MCP server.
 *
 * Maps MCP tools to ActionDefinitions. Uses raw JSON Schema from MCP
 * (set as `inputSchema`) so tool discovery avoids Zod serialization.
 * The `params` field is set to a permissive `z.record(z.unknown())` —
 * actual input validation happens on the MCP server side.
 */
export class McpActionSource implements ActionSource {
  private client: McpClient;
  private serviceName: string;
  private defaultRiskLevel: RiskLevel;
  private noAuth: boolean;

  constructor(opts: McpActionSourceOptions) {
    this.client = new McpClient({
      url: opts.mcpUrl,
      serviceName: opts.serviceName,
      authQueryParam: opts.authQueryParam,
      tokenAuthHeader: opts.tokenAuthHeader,
      additionalHeaders: opts.additionalHeaders,
      staticAuthHeader: opts.staticAuthHeader,
      staticAuthQueryParam: opts.staticAuthQueryParam,
      fetch: opts.fetch,
    });
    this.serviceName = opts.serviceName;
    this.defaultRiskLevel = opts.defaultRiskLevel ?? 'medium';
    this.noAuth = opts.noAuth ?? false;
  }

  async listActions(ctx?: ActionListContext): Promise<ActionDefinition[]> {
    const token = ctx?.credentials?.access_token;
    if (!token && !this.noAuth) {
      // Without credentials we can't call the MCP server; return empty gracefully.
      // This happens in unauthenticated contexts like the policy editor catalog.
      return [];
    }

    let tools: McpTool[];
    try {
      tools = await this.client.listTools(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[McpActionSource] ${this.serviceName} listTools failed:`, message);
      // Report through the per-call sink so concurrent callers on a
      // shared source instance don't race on stashed error state.
      ctx?.onListError?.(message);
      return [];
    }

    return tools.map((tool) => this.mapToolToAction(tool));
  }

  async execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult> {
    const token = ctx.credentials.access_token;
    if (!token && !this.noAuth) {
      return { success: false, error: `No access token for ${this.serviceName}` };
    }

    // actionId is "service.toolName" — extract the MCP tool name
    const mcpToolName = actionId.startsWith(`${this.serviceName}.`)
      ? actionId.slice(this.serviceName.length + 1)
      : actionId;

    try {
      const result = await this.client.callTool(token, mcpToolName, params);

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

      // Result data preference:
      //   1. `structuredContent` (MCP 2025-06-18) — canonical parsed
      //      form when the server advertises an outputSchema.
      //   2. `content[].text` parsed as JSON — servers on older spec
      //      revisions (or that omit structuredContent) stringify their
      //      JSON into a text block; without parsing here, downstream
      //      template paths like `{{nodes.query.data.records}}` resolve
      //      to null because `data` is a string, not an object.
      //   3. `content[].text` parsed as TOON, but ONLY when the text
      //      carries a TOON structural marker (`[N]:`, `field[N]:`,
      //      `field[N]{...}:`). Some servers (e.g. Attio) intentionally
      //      emit TOON for token efficiency and do not populate
      //      `structuredContent`. The marker gate is critical: the TOON
      //      parser is lenient enough to coerce plain prose containing
      //      a colon (`"Error: Invalid input"` → `{Error: 'Invalid input'}`)
      //      into a synthetic object, which would silently corrupt
      //      text-returning tools.
      //   4. Raw text — for tools that legitimately return text/markdown
      //      both parses fall through and callers see a string.
      if (result.structuredContent !== undefined) {
        return { success: true, data: result.structuredContent };
      }

      const textParts: string[] = result.content
        .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string' && c.text.length > 0)
        .map((c) => c.text);
      const rawText = textParts.length === 1 ? textParts[0]! : textParts.join('\n');
      const parsed = tryParseJson(rawText) ?? tryDecodeToon(rawText);
      return { success: true, data: parsed !== undefined ? parsed : rawText };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private mapToolToAction(tool: McpTool): ActionDefinition {
    return {
      id: `${this.serviceName}.${tool.name}`,
      name: tool.name,
      description: tool.description || `${this.serviceName} tool: ${tool.name}`,
      riskLevel: this.deriveRiskLevel(tool),
      params: z.record(z.unknown()),
      inputSchema: tool.inputSchema,
      // MCP outputSchema (added 2025-03-26) flows straight through. For
      // older servers, declare the text output that execute() currently
      // extracts from MCP content blocks so downstream workflow tooling
      // never sees an action without an output contract.
      outputSchema: tool.outputSchema ?? { type: 'string' },
    };
  }

  private deriveRiskLevel(tool: McpTool): RiskLevel {
    if (tool.annotations?.readOnlyHint) return 'low';
    if (tool.annotations?.destructiveHint) return 'critical';
    return this.defaultRiskLevel;
  }
}

/**
 * A TOON structural marker: an array-count prefix (`[N]:`), an inline
 * array field (`field[N]:`), or a tabular header (`field[N]{col,col}:`).
 * Plain prose that happens to contain a colon does not match — that is
 * the whole point of gating on this marker before attempting a decode.
 */
const TOON_MARKER = /\[\d+\](?:\{[^}]*\})?:/;

/** Object/array => structured; primitive/null => undefined. */
function asStructured(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? value : undefined;
}

/**
 * Try to parse text as JSON. Returns undefined on parse failure OR when
 * the parsed value is a bare string/number/boolean — bare primitives
 * suggest the tool intentionally returned text (e.g. `"hello"`) rather
 * than structured data, so we prefer the raw text in that case. Only
 * objects and arrays are treated as "the server meant JSON."
 */
function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;
  try {
    return asStructured(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Try to decode text as TOON. Gated on a TOON structural marker
 * (`[N]:`, `field[N]:`, `field[N]{...}:`) because the TOON parser is
 * lenient — it will happily decode `"Error: Invalid input"` into
 * `{Error: 'Invalid input'}`, which would silently corrupt any plain-
 * text tool response containing a colon. Attio's MCP server is the
 * motivating case: its payloads start with `[N]:` and it never
 * populates structuredContent.
 */
function tryDecodeToon(text: string): unknown {
  if (!text || !TOON_MARKER.test(text)) return undefined;
  try {
    return asStructured(decodeToon(text));
  } catch {
    return undefined;
  }
}
