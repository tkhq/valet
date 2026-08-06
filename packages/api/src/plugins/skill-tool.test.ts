/**
 * Unit tests for the `skill` tool's construction. The end-to-end behaviour
 * (a real session, real plugin skills) lives in
 * `src/engine/host.skill-tool.test.ts`; this file covers the contract
 * `buildSkillTool` holds with its callers.
 */
import { describe, it, expect } from "vitest";
import type { SkillSource } from "@valet/engine";
import { buildSkillTool } from "./skill-tool.js";

function skill(name: string, content: string): SkillSource {
  return { name, description: `Does ${name}.`, content, source: "plugin" };
}

describe("buildSkillTool", () => {
  it("returns null when the plugin set ships no skills", () => {
    expect(buildSkillTool([])).toBeNull();
  });

  it("builds a tool over the skills it is given", () => {
    const tool = buildSkillTool([skill("deploy", "Deploy body.")]);
    expect(tool?.name).toBe("skill");
    expect(tool?.description).toContain("deploy");
  });

  // The name index is a Map, and a Map built from pairs keeps the LAST
  // value for a repeated key. Callers deduplicate before this point, so a
  // duplicate here means that guard was bypassed. Silently serving one
  // skill's body under another's name is the worst available outcome, so
  // this refuses instead.
  it("refuses a list that holds the same name twice", () => {
    expect(() =>
      buildSkillTool([skill("deploy", "First body."), skill("deploy", "Second body.")]),
    ).toThrow(/deploy/);
  });
});
