import type { ActionPlugin, PluginAction } from "@valet/engine";
import type { SafeParameterProjectionV1 } from "@valet/engine/authorization";

export class ActionProjectionError extends TypeError {
  readonly code = "missing_action_projection";
  constructor(readonly actionId: string) {
    super(`Action ${actionId} has no canonical safe-parameter projection. Add safeParameterProjection schemaVersion 1 to the action or service.`);
    this.name = "ActionProjectionError";
  }
}

export function actionProjection(plugin: ActionPlugin, action: PluginAction): SafeParameterProjectionV1 {
  const projection = action.safeParameterProjection ?? plugin.safeParameterProjection;
  if (!projection) throw new ActionProjectionError(qualifiedId(plugin.service, action));
  return projection;
}

export interface ActionProjectionDiagnostic {
  readonly code: "missing_action_projection";
  readonly service: string;
  readonly actionId: string;
  readonly correctiveAction: string;
}

/**
 * Disables external actions that do not declare a secret-safe projection.
 * One bad plugin cannot stop unrelated API services from starting.
 */
export function quarantineMissingActionProjections(
  plugins: ReadonlyMap<string, { actionPlugin: ActionPlugin }>,
  onDynamicDiagnostic?: (diagnostic: ActionProjectionDiagnostic) => void,
): ActionProjectionDiagnostic[] {
  const diagnostics: ActionProjectionDiagnostic[] = [];
  for (const [service, { actionPlugin }] of plugins) {
    actionPlugin.actions = actionPlugin.actions.filter((action) => {
      if (action.safeParameterProjection ?? actionPlugin.safeParameterProjection) return true;
      diagnostics.push(diagnostic(service, qualifiedId(service, action)));
      return false;
    });
    const resolveActions = actionPlugin.resolveActions;
    if (resolveActions && !actionPlugin.safeParameterProjection) {
      actionPlugin.resolveActions = async (context) => {
        const resolved = await resolveActions(context);
        return resolved.filter((action) => {
          if (action.safeParameterProjection) return true;
          onDynamicDiagnostic?.(diagnostic(service, qualifiedId(service, action)));
          return false;
        });
      };
    }
  }
  return diagnostics;
}

function diagnostic(service: string, actionId: string): ActionProjectionDiagnostic {
  return {
    code: "missing_action_projection",
    service,
    actionId,
    correctiveAction: "Declare safeParameterProjection schemaVersion 1 on the action or service, then restart Valet.",
  };
}

function qualifiedId(service: string, action: PluginAction): string {
  return action.id.includes(".") ? action.id : `${service}.${action.id}`;
}
