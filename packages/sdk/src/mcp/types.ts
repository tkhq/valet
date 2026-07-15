// ─── MCP Protocol Types ─────────────────────────────────────────────────────

/** An MCP tool definition returned by tools/list. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Optional output JSON Schema. Added in MCP spec 2025-03-26; older
   * servers don't include it, so consumers must handle the missing case.
   */
  outputSchema?: Record<string, unknown>;
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
  };
}

/** Result of calling an MCP tool via tools/call. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  /**
   * MCP spec 2025-06-18 field: the parsed structured result matching the
   * tool's advertised outputSchema. Servers advertising an outputSchema
   * SHOULD populate this; we prefer it over parsing content[].text.
   */
  structuredContent?: unknown;
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
