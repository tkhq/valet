import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { stripToolIntent, TOOL_INTENT_SCHEMA, TOOL_INTENT_ERROR } from "@valet/shared";

// Zod's overwrite preserves the advertised string schema, unlike a preprocess pipe.
export const intentSchema = z.string({ error: TOOL_INTENT_ERROR })
  .overwrite(value => value.trim())
  .min(TOOL_INTENT_SCHEMA.minLength, TOOL_INTENT_ERROR).max(TOOL_INTENT_SCHEMA.maxLength, TOOL_INTENT_ERROR)
  .regex(new RegExp(TOOL_INTENT_SCHEMA.pattern), TOOL_INTENT_ERROR).describe(TOOL_INTENT_SCHEMA.description);

/** The only registration path for external MCP tools. Intent never enters a handler. */
export function registerTool<A extends z.ZodRawShape = Record<never, never>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: A; annotations?: ToolAnnotations },
  handler: (args: z.output<z.ZodObject<A>>) => Promise<CallToolResult>,
): RegisteredTool {
  return server.registerTool(name, {
    ...config,
    inputSchema: { ...config.inputSchema, intent: intentSchema },
  }, async (args) => {
    const { args: rest } = stripToolIntent("mcp", args);
    // The SDK validated A before this callback. Removing only intent preserves A.
    return handler(rest as z.output<z.ZodObject<A>>);
  });
}
