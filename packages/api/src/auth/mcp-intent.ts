import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOL_INTENT_SCHEMA, toolIntentError } from "@valet/shared";

// Zod's overwrite preserves the advertised string schema, unlike a preprocess pipe.
function fieldSchema(field: string) {
  const error = toolIntentError(field);
  return z.string({ error }).overwrite(value => value.trim())
    .min(TOOL_INTENT_SCHEMA.minLength, error).max(TOOL_INTENT_SCHEMA.maxLength, error)
    .regex(new RegExp(TOOL_INTENT_SCHEMA.pattern), error).describe(TOOL_INTENT_SCHEMA.description);
}
export const intentSchema = fieldSchema("intent");
export interface McpToolIntent { name: string; intent: string | null }
const observers = new WeakMap<McpServer, (call: McpToolIntent) => void>();
export function observeMcpToolIntent(server: McpServer, observe: (call: McpToolIntent) => void): void {
  observers.set(server, observe);
}

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
  const metadataSchema = fieldSchema(field);
  const schema = z.object(clash ? config.inputSchema ?? {} : { ...config.inputSchema, [field]: metadataSchema })
    .refine(args => {
      const parsed = clash ? undefined : metadataSchema.safeParse(args?.[field]);
      observers.get(server)?.({ name, intent: parsed?.success ? parsed.data : null });
      return true;
    // Observe failed validation too. The SDK still rejects invalid arguments before the handler.
    }, { when: () => true });
  return server.registerTool(name, {
    ...config,
    inputSchema: schema,
  }, async (args, extra) => {
    const rest = { ...args };
    if (!clash) delete rest[field];
    // The SDK validated A before this callback. Remove only injected metadata.
    return handler(rest as z.output<z.ZodObject<A>>, extra);
  });
}
