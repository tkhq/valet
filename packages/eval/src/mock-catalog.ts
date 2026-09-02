/**
 * Mock plugin catalog (TKAI-335).
 *
 * Exposes the SAME tool schemas as real plugins — actions are read from the
 * real `ValetPlugin` manifests — but every execute returns a canned
 * response from the eval case's `mock_tools` map. This tests the agent's
 * reasoning about integrations (tool selection, argument shape, result
 * interpretation) with no credentials, no network, and no side effects.
 *
 * Only services with at least one mocked action are exposed. Calling an
 * unmocked action of an exposed service returns a "not available" error,
 * mirroring production behavior for a not-connected plugin.
 */
import {
  pluginCatalogTools,
  type ActionPlugin,
  type PluginAction,
  type ToolDef,
  type ValetPlugin,
} from "@valet/engine";
import type { MockToolSpec } from "./types.js";

/** Collect every ActionPlugin from a set of plugin manifests. */
function actionPlugins(plugins: ValetPlugin[]): ActionPlugin[] {
  return plugins.flatMap((p) => p.actions ?? []);
}

/**
 * Build the `[list_tools, call_tool]` pair for a case's `mock_tools` map.
 * Throws when a mocked tool id does not exist in the real manifests, so a
 * typo in the case YAML fails the case instead of silently exposing nothing.
 */
export function buildMockCatalogTools(
  mockTools: Record<string, MockToolSpec>,
  plugins: ValetPlugin[],
  /** Restrict the catalog to these action ids (see EvalCase.allowed_actions). */
  allowedActions?: string[],
): ToolDef[] {
  const real = actionPlugins(plugins);
  const actionsById = new Map<string, { service: string; action: PluginAction }>();
  for (const plugin of real) {
    for (const action of plugin.actions) {
      actionsById.set(action.id, { service: plugin.service, action });
    }
  }

  const mockedServices = new Set<string>();
  for (const id of Object.keys(mockTools)) {
    const entry = actionsById.get(id);
    if (entry === undefined) {
      const service = id.split(".")[0];
      const near = [...actionsById.keys()].filter((k) => k.startsWith(`${service}.`));
      throw new Error(
        `mock_tools names unknown action \`${id}\`.` +
          (near.length > 0
            ? ` Known ${service} actions: ${near.join(", ")}`
            : ` No plugin exposes the service \`${service}\`.`),
      );
    }
    mockedServices.add(entry.service);
  }

  const allowed = allowedActions !== undefined ? new Set(allowedActions) : undefined;
  const wrapped: ActionPlugin[] = real
    .filter((plugin) => mockedServices.has(plugin.service))
    .map((plugin) => ({
      service: plugin.service,
      ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      // No credentials exist in a mock run, and an approval gate would
      // stall an unattended eval — every mocked action is auto-allowed.
      defaultApprovalMode: "allow",
      actions: (allowed !== undefined
        ? plugin.actions.filter((a) => allowed.has(a.id))
        : plugin.actions
      ).map((action) => ({
        id: action.id,
        name: action.name,
        description: action.description,
        riskLevel: action.riskLevel,
        parameters: action.parameters,
        execute: async () => {
          const spec = mockTools[action.id];
          if (spec === undefined) {
            return {
              success: false,
              error: `${action.id} is not available in this eval case. Add it to mock_tools to enable it.`,
            };
          }
          return { success: true, data: spec.response };
        },
      })),
    }));

  return pluginCatalogTools({ plugins: wrapped.filter((p) => p.actions.length > 0) });
}
