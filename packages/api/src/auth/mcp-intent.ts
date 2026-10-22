import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOL_INTENT_SCHEMA, TOOL_INTENT_ERROR } from "@valet/shared";

// Zod's overwrite preserves the advertised string schema, unlike a preprocess pipe.
export const intentSchema = z.string({ error: TOOL_INTENT_ERROR })
  .overwrite(value => value.trim())
  .min(TOOL_INTENT_SCHEMA.minLength, TOOL_INTENT_ERROR).max(TOOL_INTENT_SCHEMA.maxLength, TOOL_INTENT_ERROR)
  .regex(new RegExp(TOOL_INTENT_SCHEMA.pattern), TOOL_INTENT_ERROR).describe(TOOL_INTENT_SCHEMA.description);

/** Preserve the SDK's abort signal and progress context when stripping metadata. */
export function registerTool<A extends z.ZodRawShape = Record<never, never>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: A; annotations?: ToolAnnotations },
  handler: (args: z.output<z.ZodObject<A>>, extra: Parameters<ToolCallback<A>>[1]) => Promise<CallToolResult>,
): RegisteredTool {
  const field = name === "call_tool" ? "summary" : "intent";
  const clash = Object.hasOwn(config.inputSchema ?? {}, field);
  if (clash) console.warn(`MCP tool ${name} declares its own ${field} parameter. Intent telemetry is skipped for this tool.`);
  return server.registerTool(name, {
    ...config,
    inputSchema: clash ? config.inputSchema : { ...config.inputSchema, [field]: intentSchema },
  }, async (args, extra) => {
    const rest = { ...args };
    if (!clash) delete rest[field];
    // The SDK validated A before this callback. Remove only injected metadata.
    return handler(rest as z.output<z.ZodObject<A>>, extra);
  });
}
