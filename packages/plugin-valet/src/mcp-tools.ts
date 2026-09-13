import type { McpToolDef, McpToolPort } from "@valet/engine";
import { z } from "zod";

function viaPort(operation: string) {
  return (args: Record<string, unknown>, port: McpToolPort) => port.call(operation, args);
}

export const valetMcpTools: McpToolDef[] = [
  {
    name: "list_skills",
    description: "List the skills selected for an orchestrator that you can access.",
    inputSchema: {
      orchestratorId: z.string().trim().min(1).max(256).describe("The orchestrator session id."),
    },
    readOnly: true,
    execute: viaPort("list_skills"),
  },
  {
    name: "skill",
    description: "Read one skill selected for an orchestrator that you can access.",
    inputSchema: {
      orchestratorId: z.string().trim().min(1).max(256).describe("The orchestrator session id."),
      name: z.string().trim().min(1).max(256).describe("The skill name from list_skills."),
    },
    readOnly: true,
    execute: viaPort("skill"),
  },
];
