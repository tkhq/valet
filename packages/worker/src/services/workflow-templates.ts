// Workflow template registry + install ("Templates" gallery, Zapier-style).
//
// A template bundles a ready-to-publish dag/v1 WorkflowDefinition with the
// metadata the client needs to render a card, collect run inputs, and — for
// templates that declare one — provision a webhook trigger at install time.
//
// Install mirrors the canonical create->publish path the HTTP routes use:
//   createWorkflow -> saveDraft(definition) -> publishDraft -> createTrigger
// so an installed template is a real, published, runnable workflow (the
// executor reads the published version, never the draft/`data`).

import { NotFoundError, ValidationError, type WorkflowDefinition } from '@valet/shared';
import type { WorkflowTemplateInput } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { createWorkflow, deleteWorkflow } from './workflows.js';
import { saveDraft, publishDraft } from './workflow-versions.js';
import { resolveAvailableModels } from './model-catalog.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';
import { createTrigger, generateWebhookToken } from '../lib/db/triggers.js';
import { validateDefinition } from '../lib/workflow-dag/validator.js';

/**
 * A webhook trigger to provision alongside the workflow. `variableMapping`
 * maps the incoming webhook JSON payload onto `trigger.data` using `$.`-prefixed
 * dotted paths (the receiver does a full nested traversal).
 */
interface TemplateWebhookTrigger {
  name: string;
  /** Base webhook path; install appends a unique suffix to keep it globally unique. */
  path: string;
  variableMapping: Record<string, string>;
}

/** Worker-internal template shape — holds the full definition + wiring. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string | null;
  /** Inputs the "Run now" dialog collects (become trigger.data via a manual run). */
  inputs: WorkflowTemplateInput[];
  definition: WorkflowDefinition;
  trigger?: TemplateWebhookTrigger;
}

// The default model for LLM nodes in first-party templates. Must be a
// catalog-available, vendor-prefixed id whose provider key is configured in the
// worker env, or publishDraft rejects the install (llm_model_* ).
const DEFAULT_REVIEW_MODEL = 'anthropic/claude-sonnet-4-6';

/**
 * Flagship template: review a pull request.
 *   trigger -> github.inspect_pull_request (with diff) -> llm review -> github.create_comment
 * Fires on a GitHub `pull_request` webhook, or on demand via a manual run that
 * supplies { owner, repo, pullNumber }.
 */
const codeReviewTemplate: WorkflowTemplate = {
  id: 'code-review',
  name: 'PR code review',
  description:
    'Reviews a pull request and posts a concise, actionable review comment. Fetches the diff, reviews the changed lines with an LLM, then comments back on the PR.',
  category: 'Developer',
  icon: '🔍',
  inputs: [
    { name: 'owner', label: 'Repo owner', type: 'string', required: true, placeholder: 'tkhq' },
    { name: 'repo', label: 'Repo name', type: 'string', required: true, placeholder: 'valet' },
    { name: 'pullNumber', label: 'PR number', type: 'number', required: true, placeholder: '74' },
  ],
  definition: {
    version: 'dag/v1',
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        dataSchema: {
          owner: { type: 'string', required: true, description: 'Repository owner' },
          repo: { type: 'string', required: true, description: 'Repository name' },
          pullNumber: { type: 'number', required: true, description: 'Pull request number' },
        },
      },
      {
        id: 'fetch_pr',
        type: 'tool',
        service: 'github',
        action: 'github.inspect_pull_request',
        summary: 'Fetch the PR metadata + diff',
        params: {
          owner: '{{ trigger.data.owner }}',
          repo: '{{ trigger.data.repo }}',
          pullNumber: '{{ trigger.data.pullNumber }}',
          includePatch: true,
        },
      },
      {
        id: 'review',
        type: 'llm',
        model: DEFAULT_REVIEW_MODEL,
        system:
          'You are a meticulous senior software engineer reviewing a pull request. ' +
          'Review ONLY the changed lines shown in each file\'s `patch`. Focus on correctness, ' +
          'security, edge cases, and clear regressions — skip style nits unless they cause bugs. ' +
          'Be concise, specific, and actionable; reference file paths. If the change looks good, say so briefly.',
        prompt:
          'Write a single GitHub-flavored markdown review comment for this pull request. ' +
          'Lead with a one-line verdict, then bullet the most important findings (with file references). ' +
          'Keep it focused on the diff.\n\nPull request:\n{{ nodes.fetch_pr.data }}',
        maxOutputTokens: 2000,
      },
      {
        id: 'post',
        type: 'tool',
        service: 'github',
        action: 'github.create_comment',
        summary: 'Post the review as a PR comment',
        onPolicyDeny: 'fail',
        params: {
          owner: '{{ trigger.data.owner }}',
          repo: '{{ trigger.data.repo }}',
          // create_comment posts via /issues/{n}/comments — pass the PR number as issueNumber.
          issueNumber: '{{ trigger.data.pullNumber }}',
          // A schema-less LLM node wraps its text as { response: <text> }, so the
          // review string lives at `.data.response` — referencing `.data` alone
          // would hand create_comment an object and fail its `body: z.string()`.
          body: '{{ nodes.review.data.response }}',
        },
      },
    ],
    edges: [
      { from: 'trigger', to: 'fetch_pr' },
      { from: 'fetch_pr', to: 'review' },
      { from: 'review', to: 'post' },
    ],
  },
  trigger: {
    name: 'GitHub pull_request webhook',
    path: 'code-review',
    // Maps a native GitHub `pull_request` event payload onto trigger.data. Point a
    // GitHub webhook (content-type application/json) at the returned webhookUrl.
    variableMapping: {
      owner: '$.repository.owner.login',
      repo: '$.repository.name',
      pullNumber: '$.pull_request.number',
    },
  },
};

const TEMPLATES: readonly WorkflowTemplate[] = [codeReviewTemplate];

const TEMPLATES_BY_ID = new Map<string, WorkflowTemplate>(TEMPLATES.map((t) => [t.id, t]));

export function listWorkflowTemplates(): readonly WorkflowTemplate[] {
  return TEMPLATES;
}

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}

export interface InstallTemplateResult {
  workflowId: string;
  workflowName: string;
  trigger: { id: string; name: string; path: string; webhookToken: string } | null;
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
    await deleteWorkflow(db, userId, workflow.id).catch(() => {});
    throw err;
  }
}
