import { describe, expect, it } from "vitest";
import { buildCommandRegistry } from "../src/commands/registry.js";

const skill = { name: "review", description: "Review code", content: "# Review\ndo it" };

const promptSkill = {
  name: "standup",
  description: "Daily standup",
  content: "Summarize $1 today. Audience: $2.",
  invocation: "prompt" as const,
  argHint: "<topic> [audience]",
};

describe("buildCommandRegistry", () => {
  it("registers built-ins, prefixed skills, namespaced plugin commands", () => {
    const r = buildCommandRegistry({
      skills: [skill],
      pluginCommands: [{ pluginName: "linear", def: { name: "create-issue", description: "d", action: "create-issue", mapArgs: () => ({}) } }],
      bareSkillNames: false,
    });
    expect(r.resolve("status")?.source).toBe("builtin");
    expect(r.resolve("skill:review")?.source).toBe("skill");
    expect(r.resolve("linear:create-issue")?.source).toBe("plugin");
    expect(r.resolve("review")).toBeUndefined(); // bare names off
  });

  it("registers a bare skill name when the setting is on", () => {
    const r = buildCommandRegistry({ skills: [skill], pluginCommands: [], bareSkillNames: true });
    expect(r.resolve("review")?.source).toBe("skill");
    expect(r.resolve("skill:review")?.source).toBe("skill"); // prefixed always works
  });

  it("skill argHint reaches CommandInfo", () => {
    const r = buildCommandRegistry({ skills: [promptSkill], pluginCommands: [], bareSkillNames: false });
    const info = r.list().find((c) => c.name === "skill:standup");
    expect(info?.argHint).toBe("<topic> [audience]");
  });

  it("suggests near misses", () => {
    const r = buildCommandRegistry({ skills: [], pluginCommands: [], bareSkillNames: false });
    expect(r.nearMiss("statsu")).toBe("status");
    expect(r.nearMiss("zzzzzz")).toBeUndefined();
    expect(r.nearMiss("status")).toBeUndefined(); // exact match is not a near-miss
  });
});
