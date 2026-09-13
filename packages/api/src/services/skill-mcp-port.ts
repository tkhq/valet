import type { McpToolPort, McpToolResult, SkillSource } from "@valet/engine";
import type { EngineHost } from "../engine/host.js";
import { userPrincipal } from "../lib/request-principal.js";
import type { AppDb } from "../lib/drizzle.js";
import { canViewAssistantOwner, assistantOwner } from "../assistants/access.js";
import { loadAssistant } from "../assistants/service.js";
import { isOrgMember } from "./org.js";

const ORCHESTRATOR_UNAVAILABLE =
  "This orchestrator is unavailable. Select an orchestrator you can access and try again.";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provide a non-empty ${key} value and try again.`);
  }
  return value;
}

interface SkillMetadata {
  name: string;
  description: string;
  source: SkillSource["source"];
  revision?: string;
}

function metadata(skill: SkillSource): SkillMetadata {
  return {
    name: skill.name,
    description: skill.description ?? "",
    source: skill.source ?? "plugin",
    ...(skill.contentSha ? { revision: skill.contentSha } : {}),
  };
}

/** MCP adapter for the orchestrator's production skill assembly. */
export class SkillMcpPort implements McpToolPort {
  constructor(
    private readonly db: AppDb,
    private readonly engineHost: EngineHost,
    private readonly userId: string,
  ) {}

  async call(operation: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const orchestratorId = stringArg(args, "orchestratorId");
    const assistant = await loadAssistant(this.db, orchestratorId);
    if (
      !assistant ||
      assistant.archivedAt !== null ||
      !(await isOrgMember(this.db, assistant.orgId, this.userId)) ||
      !(await canViewAssistantOwner(this.db, assistantOwner(assistant), userPrincipal(this.userId)))
    ) {
      throw new Error(ORCHESTRATOR_UNAVAILABLE);
    }
    const skills = await this.engineHost.skillSourcesForAssistant(assistant);
    if (operation === "list_skills") {
      return { text: JSON.stringify(skills.map(metadata)) };
    }
    if (operation === "skill") {
      const name = stringArg(args, "name");
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) {
        throw new Error("This skill is unavailable. Call list_skills and select a listed skill.");
      }
      return { text: skill.content };
    }
    throw new Error("This skill operation is unavailable. Call list_skills or skill.");
  }
}
