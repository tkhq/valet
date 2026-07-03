// Workflow template install ("Templates" gallery, Zapier-style).
//
// Templates themselves are PLUGIN-OWNED: each plugin ships the templates for the
// actions it owns (e.g. the GitHub code-review template lives in plugin-github),
// and the integration registry aggregates them (registry.listTemplates()). So
// enabling/disabling a plugin adds/removes its templates. This module only
// exposes the read accessors + the source-agnostic install path.
//
// Install mirrors the canonical create->publish path the HTTP routes use:
//   createWorkflow -> saveDraft(definition) -> publishDraft -> createTrigger
// so an installed template is a real, published, runnable workflow (the
// executor reads the published version, never the draft/`data`).

import { and, eq } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { WorkflowTemplateInput } from '@valet/shared';
import type { WorkflowTemplate } from '@valet/sdk';
import { triggers } from '../lib/schema/workflows.js';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { integrationRegistry } from '../integrations/registry.js';
import { createWorkflow, deleteWorkflow } from './workflows.js';
import { saveDraft, publishDraft } from './workflow-versions.js';
import { resolveAvailableModels } from './model-catalog.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';
import { createTrigger, generateWebhookToken, getWorkflowForTrigger } from '../lib/db/triggers.js';
import { getGithubInstallationByLogin } from '../lib/db/github-installations.js';
import { validateDefinition } from '../lib/workflow-dag/validator.js';

/** Every template contributed by a registered plugin (flattened). */
export function listWorkflowTemplates(): readonly WorkflowTemplate[] {
  return integrationRegistry.listTemplates();
}

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return integrationRegistry.listTemplates().find((t) => t.id === id);
}

/**
 * The "Run now" input fields for a template, derived from its trigger node's
 * dataSchema — the same single source of truth manual runs validate against.
 * Templates declare each field once; `label`/`placeholder` are the optional
 * presentation extras on `WorkflowInputDefinition`.
 */
export function templateRunInputs(t: WorkflowTemplate): WorkflowTemplateInput[] {
  const trigger = t.definition.nodes.find((n) => n.type === 'trigger');
  return Object.entries(trigger?.dataSchema ?? {})
    .filter(([, s]) => !s.hidden && (s.type === 'string' || s.type === 'number'))
    .map(([name, s]) => ({
      name,
      label: s.label ?? name,
      type: s.type as 'string' | 'number',
      required: s.required,
      placeholder: s.placeholder,
      description: s.description,
    }));
}

export interface InstallTemplateResult {
  workflowId: string;
  workflowName: string;
  trigger: { id: string; name: string; path: string; webhookToken: string } | null;
}

/**
 * Arm an installed template workflow for a repo via the org's GitHub App — the
 * no-webhook-setup alternative. Creates a `github-app` trigger scoped to
 * owner/repo, reusing the template's webhook variableMapping so App-delivered
 * events map into trigger.data exactly as a manual webhook would. Requires the
 * caller to own the workflow and the App to be installed on the owner.
 */
export async function enableTemplateGithubApp(
  db: AppDb,
  userId: string,
  templateId: string,
  workflowId: string,
  owner: string,
  repo: string,
): Promise<{ triggerId: string; owner: string; repo: string; alreadyArmed: boolean }> {
  const template = getWorkflowTemplate(templateId);
  if (!template) throw new NotFoundError('WorkflowTemplate', templateId);
  if (!template.trigger) {
    throw new ValidationError(`Template "${templateId}" has no event trigger to arm.`);
  }

  // Ownership: the workflow must belong to the caller.
  const workflow = await getWorkflowForTrigger(db, userId, workflowId);
  if (!workflow) throw new NotFoundError('Workflow', workflowId);

  // Coverage: the App must be installed on the repo owner, else the trigger
  // would never fire.
  const installation = await getGithubInstallationByLogin(db, owner);
  if (!installation) {
    throw new ValidationError(
      `The Valet GitHub App is not installed on "${owner}". Ask an admin to install it, then try again.`,
    );
  }

  // Idempotent: one github-app trigger per (user, repo). The name is unique per
  // user (idx_triggers_user_name), so re-arming the same repo — or arming it on
  // a second installed workflow — would collide. Return the existing trigger
  // instead of throwing a raw constraint error (500).
  const name = `GitHub App: ${owner}/${repo}`;
  const existing = await db
    .select({ id: triggers.id })
    .from(triggers)
    .where(and(eq(triggers.userId, userId), eq(triggers.type, 'github-app'), eq(triggers.name, name)))
    .get();
  if (existing) {
    return { triggerId: existing.id, owner, repo, alreadyArmed: true };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await createTrigger(db, {
    id,
    userId,
    workflowId: workflow.id,
    name,
    enabled: true,
    type: 'github-app',
    // pull_request drives the initial review; issue_comment drives @Valet re-review.
    config: JSON.stringify({ type: 'github-app', owner, repo, events: ['pull_request', 'issue_comment'] }),
    variableMapping: JSON.stringify(template.trigger.variableMapping),
    now,
  });
  return { triggerId: id, owner, repo, alreadyArmed: false };
}

/**
 * Install a template as a real, published workflow (and its webhook trigger, if
 * any). Structural validation runs up front so a bad template fails before any
 * row is created; publishDraft enforces the env/model gate.
 */
export async function installWorkflowTemplate(
  db: AppDb,
  env: Env,
  userId: string,
  templateId: string,
): Promise<InstallTemplateResult> {
  const template = getWorkflowTemplate(templateId);
  if (!template) {
    throw new NotFoundError('WorkflowTemplate', templateId);
  }

  // Fail fast on a structurally-invalid template (before creating any rows).
  // llm_maxoutput_warning is non-blocking and filtered by the publish gate too.
  const structuralErrors = validateDefinition(template.definition).filter(
    (e) => e.code !== 'llm_maxoutput_warning',
  );
  if (structuralErrors.length > 0) {
    throw new ValidationError(
      `Template "${template.id}" is invalid: ${structuralErrors.map((e) => e.code).join(', ')}`,
    );
  }

  // 1. Create the workflow (blank draft). Everything after this is wrapped so a
  // later failure (publish rejection, trigger conflict) rolls the workflow back
  // instead of leaving an orphaned/half-installed row.
  const { workflow } = await createWorkflow(db, userId, {
    name: template.name,
    description: template.description,
  });

  try {
    // 2. Overwrite the draft with the template definition, 3. publish it
    // (publishDraft independently runs full structural + env/model validation).
    await saveDraft(db, workflow.id, template.definition);

    const providerEnv = await assembleLlmProviderEnv(db, env);
    const validationEnv = { ...env, ...providerEnv } as Env;
    const availableModels = await resolveAvailableModels(db, validationEnv);
    await publishDraft(db, workflow.id, {
      userId,
      env: validationEnv,
      availableModels,
      publishNote: `Installed from template "${template.id}"`,
    });

    // 4. Optionally provision the webhook trigger. The token is minted once here
    // and surfaced by the route exactly once in the install response.
    let trigger: InstallTemplateResult['trigger'] = null;
    if (template.trigger) {
      const id = crypto.randomUUID();
      const suffix = id.slice(0, 8);
      const webhookToken = generateWebhookToken();
      // Both path and name must be unique (webhook paths are globally unique;
      // triggers have a per-user unique index on name), so suffix each with the
      // fresh uuid — otherwise a second install would collide.
      const path = `${template.trigger.path}-${suffix}`;
      const name = `${template.trigger.name} (${suffix})`;
      const now = new Date().toISOString();
      await createTrigger(db, {
        id,
        userId,
        workflowId: workflow.id,
        name,
        enabled: true,
        type: 'webhook',
        config: JSON.stringify({ type: 'webhook', path, method: 'POST' }),
        variableMapping: JSON.stringify(template.trigger.variableMapping),
        now,
        webhookToken,
      });
      trigger = { id, name, path, webhookToken };
    }

    // workflow.name comes back loosely-typed (unknown); it's exactly template.name.
    return { workflowId: workflow.id, workflowName: template.name, trigger };
  } catch (err) {
    // Roll back the workflow (cascades to its versions) so a failed install
    // leaves nothing behind.
    await deleteWorkflow(db, userId, workflow.id).catch((cleanupErr) => {
      console.warn(
        `[installWorkflowTemplate] rollback of workflow ${workflow.id} failed, orphaned row may remain:`,
        cleanupErr,
      );
    });
    throw err;
  }
}
