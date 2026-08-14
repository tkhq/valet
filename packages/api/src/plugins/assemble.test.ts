import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, ApprovalOverrideRule, PluginAction, SkillSource, ValetPlugin } from "@valet/engine";
import { assemblePlugins, partitionByName, pluginSessionExtras } from "./assemble.js";

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

/**
 * Stored skills join the same collection as plugin skills, but they are
 * user-supplied, so a name clash must never throw — the four session
 * builders in `engine/host.ts` have no try/catch, and a throw here would
 * stop the owner from starting ANY session. A clash shadows instead.
 */
describe("pluginSessionExtras with stored skills", () => {
  const stored = (name: string, content: string): SkillSource => ({
    name,
    content,
    source: "user",
  });

  it("appends a stored skill whose name no plugin uses", () => {
    const plugins = [makePlugin("plugin-a", { skills: [{ name: "github", content: "plugin" }] })];

    const { skills } = pluginSessionExtras(plugins, [stored("deploy", "mine")]);

    expect(skills.map((s) => s.name)).toEqual(["github", "deploy"]);
  });

  it("does not throw when a stored skill collides with a plugin skill", () => {
    const plugins = [makePlugin("plugin-a", { skills: [{ name: "github", content: "plugin" }] })];

    expect(() => pluginSessionExtras(plugins, [stored("github", "mine")])).not.toThrow();
  });

  it("keeps the plugin body and drops the shadowed stored skill", () => {
    const plugins = [makePlugin("plugin-a", { skills: [{ name: "github", content: "plugin" }] })];

    const { skills, shadowedSkills } = pluginSessionExtras(plugins, [stored("github", "mine")]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.content).toBe("plugin");
    expect(shadowedSkills.map((s) => s.name)).toEqual(["github"]);
  });

  it("keeps the first of two stored skills that share a name", () => {
    const plugins = [makePlugin("plugin-a", { skills: [{ name: "github", content: "plugin" }] })];

    const { skills, shadowedSkills } = pluginSessionExtras(plugins, [
      stored("deploy", "personal"),
      stored("deploy", "team"),
    ]);

    expect(skills.filter((s) => s.name === "deploy").map((s) => s.content)).toEqual(["personal"]);
    expect(shadowedSkills.map((s) => s.content)).toEqual(["team"]);
  });

  it("still throws when two plugins ship one skill name, extras or not", () => {
    const plugins = [
      makePlugin("plugin-a", { skills: [{ name: "github", content: "a" }] }),
      makePlugin("plugin-b", { skills: [{ name: "github", content: "b" }] }),
    ];

    expect(() => pluginSessionExtras(plugins, [stored("deploy", "mine")])).toThrowError(/github/);
  });

  it("names a stored skill in the `skill` tool description", () => {
    const { tools } = pluginSessionExtras([], [stored("deploy", "mine")]);
    const skillTool = tools.find((t) => t.name === "skill");

    expect(skillTool).toBeDefined();
    expect(skillTool?.description).toContain("deploy");
  });

  it("reports no shadowing when nothing collides", () => {
    const { shadowedSkills } = pluginSessionExtras([], [stored("deploy", "mine")]);
    expect(shadowedSkills).toEqual([]);
  });
});

describe("pluginSessionExtras with approvalOverrides", () => {
  it("blocks all tools when a wildcard deny override is set", async () => {
    const plugins = [makePlugin("svc", { actions: [makeActionPlugin("svc")] })];
    const overrides: ApprovalOverrideRule[] = [{ match: "*", mode: "deny" }];
    const { tools } = pluginSessionExtras(plugins, [], { approvalOverrides: overrides });

    const callTool = tools.find((t) => t.name === "call_tool");
    expect(callTool).toBeDefined();

    // Executing the call_tool with any action should return blocked text.
    const result = await callTool!.execute({ tool_id: "svc.do_thing", params: {} }, {} as never);
    expect(typeof result).toBe("object");
    expect((result as { text: string }).text).toContain("blocked by org policy");
  });

  it("allows tools when no overrides are set", async () => {
    const plugins = [makePlugin("svc", { actions: [makeActionPlugin("svc")] })];
    const { tools } = pluginSessionExtras(plugins);

    const callTool = tools.find((t) => t.name === "call_tool");
    expect(callTool).toBeDefined();

    const result = await callTool!.execute({ tool_id: "svc.do_thing", params: {} }, {} as never);
    // The fixture action returns { success: true } — not a denied-policy result.
    expect((result as { text: string }).text).not.toContain("blocked by org policy");
  });

  it("produces a fresh tools array per call when overrides differ", () => {
    const plugins = [makePlugin("svc", { actions: [makeActionPlugin("svc")] })];
    const overrides: ApprovalOverrideRule[] = [{ match: "*", mode: "deny" }];
    const withOverrides = pluginSessionExtras(plugins, [], { approvalOverrides: overrides });
    const withoutOverrides = pluginSessionExtras(plugins);
    expect(withOverrides.tools).not.toBe(withoutOverrides.tools);
  });
});

describe("partitionByName", () => {
  it("splits candidates on the names already taken", () => {
    const { kept, shadowed } = partitionByName(["github"], [
      { name: "github", id: "1" },
      { name: "deploy", id: "2" },
    ]);

    expect(kept.map((c) => c.id)).toEqual(["2"]);
    expect(shadowed.map((c) => c.id)).toEqual(["1"]);
  });

  it("shadows the later of two candidates sharing one name", () => {
    const { kept, shadowed } = partitionByName([], [
      { name: "deploy", id: "1" },
      { name: "deploy", id: "2" },
    ]);

    expect(kept.map((c) => c.id)).toEqual(["1"]);
    expect(shadowed.map((c) => c.id)).toEqual(["2"]);
  });
});
