import { describe, expect, it } from "vitest";
import { MAX_PINNED_ACTIONS, pinnedToolName, type ValetPlugin } from "@valet/engine";
import { PINNED_ACTIONS } from "./pinned-actions.js";
import { pluginSessionExtras } from "./assemble.js";
import { workflowsActionPlugin } from "../workflows/actions.js";
import type { WorkflowServiceDeps } from "../workflows/service.js";

const noDeps = (): WorkflowServiceDeps => {
  throw new Error("deps not needed: only the action ids are read");
};

/** The real workflows plugin, wrapped so `pluginSessionExtras` accepts it. */
function workflowsPlugin(): ValetPlugin {
  return {
    name: "workflows",
    version: "0.0.1",
    actions: [workflowsActionPlugin(noDeps)],
  };
}

describe("PINNED_ACTIONS", () => {
  it("stays inside the engine's ceiling", () => {
    expect(PINNED_ACTIONS.length).toBeLessThanOrEqual(MAX_PINNED_ACTIONS);
  });

  it("pins the workflow read/write pair and nothing else", () => {
    expect(PINNED_ACTIONS.map((p) => p.actionId)).toEqual([
      "workflows.get_workflow",
      "workflows.patch_workflow",
    ]);
  });

  it("tells the model that describing a change is not making it", () => {
    const patch = PINNED_ACTIONS.find((p) => p.actionId === "workflows.patch_workflow");
    expect(patch?.guidance).toMatch(/BEFORE you describe it/);
    expect(patch?.guidance).toMatch(/only described is not saved/);
  });

  it("names ids the workflows plugin actually declares", () => {
    // A renamed action would otherwise un-pin itself in silence, and the
    // editor panel would go back to describing edits it never applied.
    const declared = new Set(workflowsActionPlugin(noDeps).actions.map((a) => a.id));
    for (const pin of PINNED_ACTIONS) {
      expect(declared.has(pin.actionId)).toBe(true);
    }
  });

  it("names ids that map to legal tool names", () => {
    for (const pin of PINNED_ACTIONS) {
      expect(pinnedToolName(pin.actionId)).toBeDefined();
    }
  });
});

describe("pluginSessionExtras with pins", () => {
  it("adds a direct tool for each pin, alongside the catalog pair", () => {
    const { tools } = pluginSessionExtras([workflowsPlugin()], [], PINNED_ACTIONS);
    expect(tools.map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
      "workflows__get_workflow",
      "workflows__patch_workflow",
    ]);
  });

  it("ships no direct tools when the caller pins nothing", () => {
    const { tools } = pluginSessionExtras([workflowsPlugin()]);
    expect(tools.map((t) => t.name)).toEqual(["list_tools", "call_tool"]);
  });

  it("keeps the skill tool alongside the pinned tools, with no repeated name", () => {
    // `Thread.buildTools` does not dedupe tool names, so a repeat here would
    // ship two same-named tools to the provider.
    const plugin: ValetPlugin = {
      ...workflowsPlugin(),
      skills: [{ name: "deploy", content: "deploy" }],
    };
    const { tools } = pluginSessionExtras([plugin], [], PINNED_ACTIONS);
    const names = tools.map((t) => t.name);
    expect(names).toContain("skill");
    expect(names).toContain("workflows__patch_workflow");
    expect(new Set(names).size).toBe(names.length);
  });

  it("drops a refused pin without throwing, so a session still builds", () => {
    const { tools } = pluginSessionExtras(
      [workflowsPlugin()],
      [],
      [{ actionId: "workflows.no_such_action" }, ...PINNED_ACTIONS],
    );
    expect(tools.map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
      "workflows__get_workflow",
      "workflows__patch_workflow",
    ]);
  });
});
