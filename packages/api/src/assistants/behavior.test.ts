import { describe, expect, it, vi } from "vitest";
import type { ValetPlugin, SkillSource } from "@valet/engine";
import {
  applyBehaviorToPlugins,
  filterSkillSources,
  parseAssistantBehavior,
  serializeAssistantBehavior,
  validateAssistantBehavior,
} from "./behavior.js";

function makePlugin(overrides: Partial<ValetPlugin> = {}): ValetPlugin {
  return {
    name: "github",
    version: "1.0.0",
    actions: [
      {
        service: "github",
        actions: [
          action("github.create_issue", "Create issue"),
          action("github.delete_repo", "Delete repo"),
        ],
      },
    ],
    skills: [skill("gh-triage")],
    ...overrides,
  };
}

function action(id: string, name: string) {
  return {
    id,
    name,
    description: name,
    riskLevel: "low" as const,
    parameters: { type: "object" as const, properties: {} },
    execute: async () => ({ success: true, data: undefined }),
  };
}

function skill(name: string): SkillSource {
  return { name, description: name, content: `# ${name}` };
}

describe("validateAssistantBehavior", () => {
  it("accepts all/allowlist shapes and rejects unknown modes with a corrective message", () => {
    expect(validateAssistantBehavior({ skills: { mode: "all" } })).toBeNull();
    expect(
      validateAssistantBehavior({
        skills: { mode: "allowlist", names: ["gh-triage"] },
        integrations: {
          mode: "allowlist",
          entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
        },
      }),
    ).toBeNull();
    expect(validateAssistantBehavior({ skills: { mode: "some" } })).toMatch(
      /skills\.mode must be 'all' or 'allowlist'/,
    );
    expect(validateAssistantBehavior({ integrations: { mode: "allowlist" } })).toMatch(
      /entries/,
    );
    expect(
      validateAssistantBehavior({ integrations: { mode: "allowlist", entries: [{ service: 7 }] } }),
    ).toMatch(/service/);
  });
});

describe("parse/serialize round trip", () => {
  it("round-trips a config and returns null for null", () => {
    const behavior = { skills: { mode: "allowlist" as const, names: ["a"] } };
    const raw = serializeAssistantBehavior(behavior);
    expect(parseAssistantBehavior(raw, "asst_1")).toEqual(behavior);
    expect(serializeAssistantBehavior(null)).toBeNull();
    expect(parseAssistantBehavior(null, "asst_1")).toBeNull();
  });

  it("fails open on garbage, with a warning naming the assistant", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseAssistantBehavior("{not json", "asst_9")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("asst_9"));
    warn.mockRestore();
  });
});

describe("applyBehaviorToPlugins", () => {
  it("null behavior returns the plugins untouched", () => {
    const plugins = [makePlugin()];
    expect(applyBehaviorToPlugins(plugins, null)).toBe(plugins);
  });

  it("allowlist keeps only listed services and drops excluded action ids", () => {
    const plugins = [
      makePlugin(),
      makePlugin({
        name: "slack",
        actions: [{ service: "slack", actions: [action("slack.send_message", "Send")] }],
        skills: [],
      }),
    ];
    const out = applyBehaviorToPlugins(plugins, {
      integrations: {
        mode: "allowlist",
        entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
      },
    });
    const github = out.find((p) => p.name === "github");
    const slack = out.find((p) => p.name === "slack");
    expect(github?.actions?.[0]?.actions.map((a) => a.id)).toEqual(["github.create_issue"]);
    expect(slack?.actions).toEqual([]);
    // Plugin skills survive the integrations filter; the skills config governs them.
    expect(slack === undefined || (slack.skills ?? []).length === 0).toBe(true);
    expect(github?.skills?.map((s) => s.name)).toEqual(["gh-triage"]);
  });

  it("wraps resolveActions so dynamically resolved actions honor excludes", async () => {
    const dynamic = makePlugin({
      name: "mcp",
      actions: [
        {
          service: "mcp",
          actions: [],
          resolveActions: async () => [action("mcp.read", "Read"), action("mcp.write", "Write")],
        },
      ],
      skills: [],
    });
    const out = applyBehaviorToPlugins([dynamic], {
      integrations: {
        mode: "allowlist",
        entries: [{ service: "mcp", excludeActions: ["mcp.write"] }],
      },
    });
    const resolve = out[0]?.actions?.[0]?.resolveActions;
    expect(resolve).toBeDefined();
    const resolved = await resolve!({ credentials: {} as never });
    expect(resolved.map((a) => a.id)).toEqual(["mcp.read"]);
  });

  it("skills allowlist filters plugin skills", () => {
    const out = applyBehaviorToPlugins([makePlugin()], {
      skills: { mode: "allowlist", names: ["other"] },
    });
    expect(out[0]?.skills).toEqual([]);
    // Actions untouched: no integrations config was given.
    expect(out[0]?.actions?.[0]?.actions).toHaveLength(2);
  });
});

describe("pin exemption", () => {
  const WORKFLOW_PLUGIN = makePlugin({
    name: "workflows",
    actions: [
      {
        service: "workflows",
        actions: [
          action("workflows.get_workflow", "Read workflow"),
          action("workflows.patch_workflow", "Patch workflow"),
          action("workflows.save_workflow", "Save workflow"),
        ],
      },
    ],
    skills: [],
  });
  const PINNED = new Set(["workflows.get_workflow", "workflows.patch_workflow"]);

  it("keeps pinned actions when their service is not allowlisted, and drops the rest of the plugin", () => {
    const out = applyBehaviorToPlugins(
      [WORKFLOW_PLUGIN, makePlugin()],
      { integrations: { mode: "allowlist", entries: [{ service: "github" }] } },
      PINNED,
    );
    const workflows = out.find((p) => p.name === "workflows");
    expect(workflows?.actions?.[0]?.actions.map((a) => a.id)).toEqual([
      "workflows.get_workflow",
      "workflows.patch_workflow",
    ]);
  });

  it("drops a non-allowlisted plugin entirely when it carries no pinned action", () => {
    const out = applyBehaviorToPlugins(
      [
        makePlugin({
          name: "slack",
          actions: [{ service: "slack", actions: [action("slack.send_message", "Send")] }],
          skills: [],
        }),
      ],
      { integrations: { mode: "allowlist", entries: [{ service: "github" }] } },
      PINNED,
    );
    expect(out[0]?.actions).toEqual([]);
  });

  it("excludeActions cannot name a pinned action away", () => {
    const out = applyBehaviorToPlugins(
      [WORKFLOW_PLUGIN],
      {
        integrations: {
          mode: "allowlist",
          entries: [
            {
              service: "workflows",
              excludeActions: ["workflows.patch_workflow", "workflows.save_workflow"],
            },
          ],
        },
      },
      PINNED,
    );
    expect(out[0]?.actions?.[0]?.actions.map((a) => a.id)).toEqual([
      "workflows.get_workflow",
      "workflows.patch_workflow",
    ]);
  });
});

describe("validation caps and unknown keys", () => {
  it("rejects unknown keys nested under skills, integrations, and entries", () => {
    expect(validateAssistantBehavior({ skills: { mode: "all", junk: "x" } })).toMatch(
      /skills\.junk is not a recognized field/,
    );
    expect(validateAssistantBehavior({ integrations: { mode: "all", extra: [1] } })).toMatch(
      /integrations\.extra is not a recognized field/,
    );
    expect(
      validateAssistantBehavior({
        integrations: { mode: "allowlist", entries: [{ service: "github", payload: "x" }] },
      }),
    ).toMatch(/entries\[\]\.payload is not a recognized field/);
  });

  it("rejects oversized allowlists and names the cap", () => {
    expect(
      validateAssistantBehavior({
        skills: { mode: "allowlist", names: Array.from({ length: 501 }, (_, i) => `s${i}`) },
      }),
    ).toMatch(/limited to 500 entries/);
    expect(
      validateAssistantBehavior({
        integrations: {
          mode: "allowlist",
          entries: Array.from({ length: 101 }, (_, i) => ({ service: `svc${i}` })),
        },
      }),
    ).toMatch(/limited to 100 entries/);
  });
});

describe("normalization at serialize time", () => {
  it("drops an empty excludeActions and keeps stable field order", () => {
    const raw = serializeAssistantBehavior({
      integrations: { mode: "allowlist", entries: [{ service: "github", excludeActions: [] }] },
      skills: { mode: "all" },
    });
    expect(raw).toBe(
      JSON.stringify({
        skills: { mode: "all" },
        integrations: { mode: "allowlist", entries: [{ service: "github" }] },
      }),
    );
  });
});

describe("filterSkillSources", () => {
  it("filters stored skills by the allowlist and passes everything through otherwise", () => {
    const skills = [skill("a"), skill("b")];
    expect(filterSkillSources(skills, null)).toBe(skills);
    expect(
      filterSkillSources(skills, { skills: { mode: "allowlist", names: ["b"] } }).map(
        (s) => s.name,
      ),
    ).toEqual(["b"]);
  });
});
