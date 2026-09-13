import type { McpToolDef, McpToolPort } from "@valet/engine";
import { z } from "zod";

function viaPort(operation: string) {
  return (args: Record<string, unknown>, port: McpToolPort) => port.call(operation, args);
}

export const valetMcpTools: McpToolDef[] = [
  {
    name: "list_tools",
    description: "List governed plugin actions available to an orchestrator.",
    inputSchema: {
      orchestratorId: z.string().trim().regex(/^asst_/).max(256),
      threadId: z.string().trim().min(1).max(256).optional(),
      service: z.string().trim().min(1).max(128).optional(),
      query: z.string().trim().min(1).max(1024).optional(),
      actionId: z.string().trim().min(1).max(256).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    execute: viaPort("list_tools"),
  },
  {
    name: "call_tool",
    description: "Invoke one governed plugin action with durable at-most-once safety. Live and replayed results use the 8 KiB audit-field cap.",
    inputSchema: {
      invocationId: z.string().trim().min(1).max(256),
      orchestratorId: z.string().trim().regex(/^asst_/).max(256),
      threadId: z.string().trim().min(1).max(256).optional(),
      actionId: z.string().trim().min(1).max(256),
      params: z.record(z.string(), z.unknown()),
      summary: z.string().trim().min(1).max(500),
    },
    readOnly: false,
    audit: "owned",
    execute: viaPort("call_tool"),
  },
  {
    name: "list_skills",
    description: "List the skills selected for an orchestrator that you can access.",
    inputSchema: {
      orchestratorId: z.string().trim().min(1).max(256).describe("The orchestrator ID from orchestrator_list."),
    },
    readOnly: true,
    execute: viaPort("list_skills"),
  },
  {
    name: "skill",
    description: "Read one skill selected for an orchestrator that you can access.",
    inputSchema: {
      orchestratorId: z.string().trim().min(1).max(256).describe("The orchestrator ID from orchestrator_list."),
      name: z.string().trim().min(1).max(256).describe("The skill name from list_skills."),
    },
    readOnly: true,
    execute: viaPort("skill"),
  },
];
