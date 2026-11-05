// ─── MCP Protocol Types ─────────────────────────────────────────────────────

/** An MCP tool definition returned by tools/list. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /**
   * The ways a caller may authenticate to call this tool (draft SEP-1488).
   * Any one scheme is enough. Absent means the server says nothing.
   */
  securitySchemes?: McpSecurityScheme[];
}

/** One `securitySchemes` entry. `noauth` needs no credential; `oauth2`
 * needs every scope in `scopes`. Other types are passed through unread. */
export interface McpSecurityScheme {
  type: string;
  scopes?: string[];
}

/** Result of calling an MCP tool via tools/call. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}
