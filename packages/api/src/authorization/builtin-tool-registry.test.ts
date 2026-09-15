import { BUILTIN_TOOL_NAMES } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { buildMemoryTools } from "../orchestrator/memory-tools.js";
import { buildSecurityPersonaTools, buildSecurityRunnerTools } from "../engine/security-tools.js";
import { buildSkillTool } from "../plugins/skill-tool.js";

describe("API-built canonical tool registry", () => {
  it("gives every assembled API tool canonical metadata", () => {
    const skill = buildSkillTool([{ name: "fixture", description: "fixture", content: "fixture", source: "user", key: "fixture", contentSha: "a".repeat(64) }]);
    const tools = [...buildMemoryTools(), ...buildSecurityRunnerTools(), ...buildSecurityPersonaTools({ review: true, persona: "report" }), ...(skill ? [skill] : [])];
    expect(tools.length).toBeGreaterThan(30);
    const engineAndWrapperNames = ["read", "write", "edit", "bash", "thread_read", "list_threads", "switch_model", "ask_approval", "task", "child_read", "child_send", "child_status", "list_tools", "call_tool"];
    expect([...new Set([...tools.map((tool) => tool.name), ...engineAndWrapperNames])].sort()).toEqual(BUILTIN_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.authorization, tool.name).toMatchObject({ schemaVersion: 1, actionId: `builtin.${tool.name}`, audit: { replay: "at_most_once" } });
    }
  });
});
