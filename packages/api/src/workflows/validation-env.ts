/**
 * Environment hooks for the dag/v1 definition validator — closes the gap
 * between "definition is structurally valid" and "definition will actually
 * run": unknown model specs and unknown tool service/actions fail at SAVE
 * with an actionable message, instead of at run time inside a node.
 */
import { getModel } from "@mariozechner/pi-ai";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { ValidateEnvironment } from "@valet/workflow";

/**
 * Mirrors `engine-deps.ts`'s `resolveWorkflowModel` matching rules:
 * `provider/model` form is looked up directly; a bare id is tried under
 * the common providers (anthropic first — the engine's own default
 * convention).
 */
export function isKnownModelSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    return getModel(provider as never, modelId as never) != null;
  }
  for (const provider of ["anthropic", "openai", "google"] as const) {
    if (getModel(provider, spec as never) != null) return true;
  }
  return false;
}

export function buildValidateEnvironment(
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>,
): ValidateEnvironment {
  return {
    isKnownModel: isKnownModelSpec,
    isKnownAction: actionPluginByService
      ? (service, action) => {
          const entry = actionPluginByService.get(service);
          if (!entry) return "unknown-service";
          // Plugins with a dynamic action resolver (MCP-style) only know
          // their action list at runtime with credentials in hand — pass.
          if (entry.actionPlugin.resolveActions) return "dynamic";
          const qualified = `${service}.${action}`;
          const known = entry.actionPlugin.actions.some(
            (a) => a.id === qualified || a.id === action,
          );
          return known ? "ok" : "unknown-action";
        }
      : undefined,
  };
}
