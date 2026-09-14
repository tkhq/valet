import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ActionPlugin, PluginAction, ValetPlugin } from "@valet/engine";
import { actionProjection, validateActionProjectionInventory } from "./action-projections.js";

const action = (id: string): PluginAction => ({
  id,
  name: id,
  description: id,
  riskLevel: "low",
  parameters: Type.Object({}),
  execute: async () => ({ success: true, data: {} }),
});

function plugin(service: string, ids: string[], dynamic = false): { plugin: ValetPlugin; actionPlugin: ActionPlugin } {
  const actionPlugin: ActionPlugin = {
    service,
    actions: ids.map(action),
    ...(dynamic ? { resolveActions: async () => [] } : {}),
  };
  return {
    plugin: { name: service, version: "1", actions: [actionPlugin] },
    actionPlugin,
  };
}

describe("canonical action projection inventory", () => {
  it("returns versioned projections and rejects unknown actions", () => {
    expect(actionProjection("github.create_issue")).toEqual({ schemaVersion: 1, mode: "all_safe" });
    expect(() => actionProjection("github.not_registered")).toThrow(/Missing canonical/);
  });

  it.each(["cloudflare.workers_list", "deepwiki.ask_question", "figma.get_file", "linear.save_issue", "notion.search", "sentry.find_issues", "stripe.list_customers", "typefully.create_draft"])("uses an explicit all-safe handler for dynamic action %s", (actionId) => {
    expect(actionProjection(actionId)).toEqual({ schemaVersion: 1, mode: "all_safe" });
  });

  it("fails closed for missing, extra, and unhandled dynamic actions", () => {
    const missing = new Map(); missing.set("github", plugin("github", ["github.create_issue", "github.not_registered"]));
    const extra = new Map(); extra.set("github", plugin("github", ["github.create_issue"]));
    const dynamic = new Map(); dynamic.set("github", plugin("github", [], true));
    expect(() => validateActionProjectionInventory(missing)).toThrow(/missing: github.not_registered/);
    expect(() => validateActionProjectionInventory(extra)).toThrow(/extra:/);
    expect(() => validateActionProjectionInventory(extra, false)).not.toThrow();
    expect(() => validateActionProjectionInventory(dynamic)).toThrow(/Dynamic plugin/);
  });
});
