import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { actionProjection, validateActionProjectionInventory } from "./action-projections.js";

const action = (id: string) => ({ id, name: id, description: id, riskLevel: "low" as const, parameters: Type.Object({}), execute: async () => ({ success: true, data: {} }) });
const plugin = (service: string, ids: string[], dynamic = false) => ({ plugin: { id: service, name: service, version: "1", actions: [] } as unknown as ValetPlugin, actionPlugin: { service, actions: ids.map(action), ...(dynamic ? { resolveActions: async () => [] } : {}) } as ActionPlugin });

describe("canonical action projection inventory", () => {
  it("returns versioned projections and rejects unknown actions", () => {
    expect(actionProjection("github.create_issue")).toEqual({ schemaVersion: 1, mode: "all_safe" });
    expect(() => actionProjection("github.not_registered")).toThrow(/Missing canonical/);
  });

  it("fails closed for missing, extra, and dynamic actions", () => {
    const missing = new Map(); missing.set("github", plugin("github", ["github.create_issue", "github.not_registered"]));
    const extra = new Map(); extra.set("github", plugin("github", ["github.create_issue"]));
    const dynamic = new Map(); dynamic.set("github", plugin("github", [], true));
    expect(() => validateActionProjectionInventory(missing)).toThrow(/missing: github.not_registered/);
    expect(() => validateActionProjectionInventory(extra)).toThrow(/extra:/);
    expect(() => validateActionProjectionInventory(dynamic)).toThrow(/Dynamic plugin/);
  });
});
