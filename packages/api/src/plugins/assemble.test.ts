import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { assemblePlugins, pluginSessionExtras } from "./assemble.js";

function makeAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

function makeActionPlugin(service: string): ActionPlugin {
  return { service, actions: [makeAction(`${service}.do_thing`)] };
}

function makePlugin(name: string, opts: Partial<ValetPlugin> = {}): ValetPlugin {
  return { name, version: "0.0.1", ...opts };
}

describe("assemblePlugins", () => {
  it("dedupes duplicate plugin names across sources, earlier source wins", () => {
    const early = makePlugin("github", { description: "early" });
    const late = makePlugin("github", { description: "late" });

    const { plugins } = assemblePlugins([[early], [late]]);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.description).toBe("early");
  });

  it("throws when two different plugin names claim the same action service", () => {
    const a = makePlugin("plugin-a", { actions: [makeActionPlugin("shared")] });
    const b = makePlugin("plugin-b", { actions: [makeActionPlugin("shared")] });

    expect(() => assemblePlugins([[a], [b]])).toThrowError(/plugin-a/);
    expect(() => assemblePlugins([[a], [b]])).toThrowError(/plugin-b/);
  });

  it("does not throw when the same plugin (post-dedupe) reappears with the same service", () => {
    const plugin = makePlugin("github", { actions: [makeActionPlugin("github")] });
    const { plugins, actionPluginByService } = assemblePlugins([[plugin], [plugin]]);

    expect(plugins).toHaveLength(1);
    expect(actionPluginByService.get("github")?.plugin.name).toBe("github");
  });

  it("throws when a single source has two plugins with the same name", () => {
    const a = makePlugin("dup");
    const b = makePlugin("dup", { description: "second" });

    expect(() => assemblePlugins([[a, b]])).toThrowError(/duplicate plugin name "dup"/);
  });

  it("builds actionPluginByService across distinct plugins/services", () => {
    const a = makePlugin("plugin-a", { actions: [makeActionPlugin("service-a")] });
    const b = makePlugin("plugin-b", { actions: [makeActionPlugin("service-b")] });

    const { actionPluginByService } = assemblePlugins([[a, b]]);

    expect(actionPluginByService.get("service-a")?.plugin.name).toBe("plugin-a");
    expect(actionPluginByService.get("service-b")?.plugin.name).toBe("plugin-b");
  });
});

describe("pluginSessionExtras", () => {
  it("returns no catalog tools when there are zero action plugins", () => {
    const plugins = [makePlugin("skills-only", { skills: [{ name: "s", content: "c" }] })];
    const { tools } = pluginSessionExtras(plugins);
    // The `skill` tool still ships — a skills-only plugin set has something
    // to reach — but neither catalog tool does.
    expect(tools.map((t) => t.name)).toEqual(["skill"]);
  });

  it("returns no tools at all for a plugin set with neither actions nor skills", () => {
    const { tools } = pluginSessionExtras([makePlugin("inert")]);
    expect(tools).toEqual([]);
  });

  it("returns exactly [list_tools, call_tool] when action plugins exist", () => {
    const plugins = [makePlugin("github", { actions: [makeActionPlugin("github")] })];
    const { tools } = pluginSessionExtras(plugins);
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });

  it("concatenates skills and roles across plugins", () => {
    const plugins = [
      makePlugin("plugin-a", {
        skills: [{ name: "skill-a", content: "a" }],
        roles: [{ name: "role-a", content: "a" }],
      }),
      makePlugin("plugin-b", {
        skills: [{ name: "skill-b", content: "b" }],
        roles: [{ name: "role-b", content: "b" }],
      }),
    ];
    const { skills, roles } = pluginSessionExtras(plugins);
    expect(skills.map((s) => s.name)).toEqual(["skill-a", "skill-b"]);
    expect(roles.map((r) => r.name)).toEqual(["role-a", "role-b"]);
  });

  it("throws when two plugins ship a skill with the same name", () => {
    const plugins = [
      makePlugin("plugin-a", { skills: [{ name: "github", content: "a" }] }),
      makePlugin("plugin-b", { skills: [{ name: "github", content: "b" }] }),
    ];

    expect(() => pluginSessionExtras(plugins)).toThrowError(/plugin-a/);
    expect(() => pluginSessionExtras(plugins)).toThrowError(/plugin-b/);
    expect(() => pluginSessionExtras(plugins)).toThrowError(/github/);
  });

  it("throws when one plugin ships two skills with the same name", () => {
    const plugins = [
      makePlugin("plugin-a", {
        skills: [
          { name: "github", content: "a" },
          { name: "github", content: "b" },
        ],
      }),
    ];

    expect(() => pluginSessionExtras(plugins)).toThrowError(/github/);
  });

  it("adds a protected `skill` tool naming every skill the plugin set ships", () => {
    const plugins = [
      makePlugin("plugin-a", { skills: [{ name: "github", description: "Use GitHub.", content: "a" }] }),
      makePlugin("plugin-b", { skills: [{ name: "workflows", content: "b" }] }),
    ];

    const { tools } = pluginSessionExtras(plugins);
    const skillTool = tools.find((t) => t.name === "skill");

    expect(skillTool).toBeDefined();
    expect(skillTool?.protectedFromPruning).toBe(true);
    expect(skillTool?.description).toContain("github");
    expect(skillTool?.description).toContain("Use GitHub.");
    expect(skillTool?.description).toContain("workflows");
  });

  it("adds no `skill` tool when no plugin ships a skill", () => {
    const plugins = [makePlugin("github", { actions: [makeActionPlugin("github")] })];
    const { tools } = pluginSessionExtras(plugins);
    expect(tools.map((t) => t.name)).not.toContain("skill");
  });

  it("builds a fresh tools array on every call (no module-scope caching)", () => {
    const plugins = [makePlugin("github", { actions: [makeActionPlugin("github")] })];
    const first = pluginSessionExtras(plugins);
    const second = pluginSessionExtras(plugins);
    expect(first.tools).not.toBe(second.tools);
    expect(first.tools[0]).not.toBe(second.tools[0]);
  });
});
