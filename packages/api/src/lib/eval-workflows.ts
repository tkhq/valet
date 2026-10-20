/**
 * Workflow access for the eval harness's workflow-authoring cases.
 *
 * The eval package scores the workflow definitions an assistant drafts. It
 * needs two things the api owns: the save validator, and the definitions
 * that a product-drive case saved. This module owns both, so the eval
 * package never touches the workflow service internals or the schema.
 */
import { asc } from "drizzle-orm";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { AppDb } from "./drizzle.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { workflowDefinitions } from "../schema/index.js";
import { validateDefinitionInput } from "../workflows/service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";

/** The step-design heuristic `preview_workflow` warns with: an agent prompt that asks for approval. */
export { approvalRequestWarning } from "@valet/workflow";

let bundledEnv: ReturnType<typeof buildValidateEnvironment> | undefined;

/**
 * Runs the save validator over `definition` with the bundled plugin catalog.
 * Tool steps are checked against the real action schemas, and model ids
 * against the bundled model catalog. There is no org here, so the org's
 * approved-model list does not apply.
 */
export function validateWorkflowDraft(definition: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (bundledEnv === undefined) {
    const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
    for (const plugin of bundledPlugins) {
      for (const actionPlugin of plugin.actions ?? []) {
        actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
      }
    }
    bundledEnv = buildValidateEnvironment(actionPluginByService);
  }
  const result = validateDefinitionInput(definition, bundledEnv);
  return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}

/** Every workflow definition in the database, oldest update first. */
export async function listSavedWorkflows(
  db: AppDb,
): Promise<Array<{ id: string; name: string; definition: unknown; updatedAt: number }>> {
  return db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      definition: workflowDefinitions.definition,
      updatedAt: workflowDefinitions.updatedAt,
    })
    .from(workflowDefinitions)
    .orderBy(asc(workflowDefinitions.updatedAt));
}
