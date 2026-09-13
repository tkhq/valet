import type { McpToolDef, McpToolPort } from "@valet/engine";
import { z } from "zod";

export const MEMORY_MCP_ORIGIN = "mcp:external";

function viaPort(operation: string) {
  return (args: Record<string, unknown>, port: McpToolPort) => port.call(operation, args);
}

export const memoryMcpTools: McpToolDef[] = [
  {
    name: "mem_capture",
    description: "Capture one new memory in today's personal inbox. Valet chooses the path and fixes the origin.",
    inputSchema: {
      title: z.string().trim().min(1).max(160).describe("Short title used to create the inbox filename."),
      content: z.string().min(1).max(1_000_000).describe("Markdown content to capture. Embedded frontmatter is removed."),
    },
    readOnly: false,
    execute: viaPort("capture"),
    auditArguments: (args) => ({
      title: args.title,
      content: "[redacted memory content]",
    }),
  },
  {
    name: "mem_search",
    description: "Search personal memory and memory owned by teams you currently belong to.",
    inputSchema: {
      query: z.string().trim().min(1).max(1_024).describe("Full-text search query."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum results. Default 20."),
    },
    readOnly: true,
    execute: viaPort("search"),
  },
  {
    name: "mem_read",
    description: "Read one accessible personal or team memory path as Open Knowledge Format (OKF).",
    inputSchema: {
      path: z.string().trim().min(1).max(1_024).describe("Personal path or team:{teamId}/ virtual path from mem_search."),
    },
    readOnly: true,
    execute: viaPort("read"),
  },
];
