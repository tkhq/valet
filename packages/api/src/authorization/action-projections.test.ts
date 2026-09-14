import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ActionPlugin, PluginAction } from "@valet/engine";
import { ActionProjectionError, actionProjection, quarantineMissingActionProjections } from "./action-projections.js";

const ALL_SAFE = { schemaVersion: 1, mode: "all_safe" } as const;
const action = (id: string, declared = false): PluginAction => ({
  id,
  name: id,
  description: id,
  riskLevel: "low",
  parameters: Type.Object({}),
  ...(declared ? { safeParameterProjection: ALL_SAFE } : {}),
  execute: async () => ({ success: true, data: {} }),
});

function plugin(service: string, actions: PluginAction[], declared = false): ActionPlugin {
  return {
    service,
    actions,
    ...(declared ? { safeParameterProjection: ALL_SAFE } : {}),
  };
}

describe("canonical action projection declarations", () => {
  it("uses versioned action metadata before service metadata", () => {
    const service = plugin("external", [action("external.read", true)], true);
    expect(actionProjection(service, service.actions[0]!)).toEqual(ALL_SAFE);
  });

  it("quarantines only undeclared external static actions with typed corrective diagnostics", () => {
    const good = plugin("good", [action("good.read")], true);
    const mixed = plugin("mixed", [action("mixed.safe", true), action("mixed.unsafe")]);
    const diagnostics = quarantineMissingActionProjections(new Map([
      ["good", { actionPlugin: good }],
      ["mixed", { actionPlugin: mixed }],
    ]));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "missing_action_projection",
        service: "mixed",
        actionId: "mixed.unsafe",
        correctiveAction: expect.stringContaining("Declare safeParameterProjection"),
      }),
    ]);
    expect(good.actions).toHaveLength(1);
    expect(mixed.actions.map(({ id }) => id)).toEqual(["mixed.safe"]);
    expect(() => actionProjection(mixed, action("mixed.unsafe"))).toThrow(ActionProjectionError);
  });

  it("quarantines each undeclared dynamic action without disabling declared siblings", async () => {
    const dynamic = plugin("dynamic", []);
    dynamic.resolveActions = async () => [action("dynamic.safe", true), action("dynamic.unsafe")];
    const diagnostics: unknown[] = [];
    expect(quarantineMissingActionProjections(
      new Map([["dynamic", { actionPlugin: dynamic }]]),
      (item) => diagnostics.push(item),
    )).toEqual([]);
    const resolved = await dynamic.resolveActions!({ credentials: {} as never });
    expect(resolved.map(({ id }) => id)).toEqual(["dynamic.safe"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "missing_action_projection", actionId: "dynamic.unsafe" }),
    ]);
  });
});
