/**
 * The fully-qualified action id convention, alone in a leaf module so pure
 * consumers (`assistants/behavior.ts`) can share it without importing
 * `action-invoker.ts`'s db/policy graph.
 */
import type { PluginAction } from "@valet/engine";

/** The canonical policy-facing action id: the fully-qualified fqid
 * (`service.action`), mirroring the plugin-catalog's list_tools convention.
 * Both invocation paths resolve to this form, so one org policy / override /
 * grant targets both (spec Deviations T6 #3). */
export function qualifiedActionId(service: string, action: PluginAction): string {
  return action.id.includes(".") ? action.id : `${service}.${action.id}`;
}
