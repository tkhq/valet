import { describe, expect, it } from "vitest";
import { buildCommandRegistry } from "../src/commands/registry.js";

const skill = { name: "review", description: "Review code", content: "# Review\ndo it" };
const tmpl = (name: string, origin: "repo" | "user") => ({ name, content: `body-${origin}`, origin });

describe("buildCommandRegistry", () => {
  it("registers built-ins, prefixed skills, templates, namespaced plugin commands", () => {
    const r = buildCommandRegistry({
      skills: [skill], templates: [tmpl("standup", "repo")],
      pluginCommands: [{ pluginName: "linear", def: { name: "create-issue", description: "d", action: "create-issue", mapArgs: () => ({}) } }],
      bareSkillNames: false,
    });
    expect(r.resolve("status")?.source).toBe("builtin");
    expect(r.resolve("skill:review")?.source).toBe("skill");
    expect(r.resolve("standup")?.source).toBe("template");
    expect(r.resolve("linear:create-issue")?.source).toBe("plugin");
    expect(r.resolve("review")).toBeUndefined(); // bare names off
  });

  it("user template shadows repo template, with diagnostic", () => {
    const r = buildCommandRegistry({ skills: [], templates: [tmpl("x", "repo"), tmpl("x", "user")], pluginCommands: [], bareSkillNames: false });
    const resolved = r.resolve("x");
    expect(resolved?.source === "template" && resolved.template.origin).toBe("user");
    expect(r.diagnostics().some((d) => d.name === "x")).toBe(true);
  });

  it("template shadows bare skill name when the setting is on", () => {
    const r = buildCommandRegistry({ skills: [skill], templates: [tmpl("review", "user")], pluginCommands: [], bareSkillNames: true });
    expect(r.resolve("review")?.source).toBe("template");
    expect(r.resolve("skill:review")?.source).toBe("skill"); // prefixed always works
    expect(r.diagnostics().some((d) => d.name === "review")).toBe(true);
  });

  it("suggests near misses", () => {
    const r = buildCommandRegistry({ skills: [], templates: [], pluginCommands: [], bareSkillNames: false });
    expect(r.nearMiss("statsu")).toBe("status");
    expect(r.nearMiss("zzzzzz")).toBeUndefined();
    expect(r.nearMiss("status")).toBeUndefined(); // exact match is not a near-miss
  });
});
