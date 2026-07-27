// PR code-review feature: enable Claude PR reviews on a repository via the org's
// GitHub App. Arming installs a dedicated, published workflow (owned by the
// caller) and a `github-app` trigger scoped to owner/repo; the App webhook
// dispatch (services/webhooks.ts) then runs that workflow per pull_request event
// and posts the review as the App bot. The workflow definition itself is the
// GitHub plugin's `code-review` template (templates are plugin-owned; the
// gallery and this one-click enable path install the same definition), re-
// exported here under its historical name.

import { and, eq } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { WorkflowDefinition } from '@valet/shared';
import { githubTemplates } from '@valet/plugin-github/actions';
import { triggers } from '../lib/schema/workflows.js';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { createWorkflow, deleteWorkflow } from './workflows.js';
import { saveDraft, publishDraft, getPublishedDefinition } from './workflow-versions.js';
import { resolveAvailableModels } from './model-catalog.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';
import { createTrigger } from '../lib/db/triggers.js';
import { assertCallerCanAdministerRepo } from './github-repo-authority.js';
import { hasCredential } from './credentials.js';

const codeReviewTemplate = githubTemplates.find((t) => t.id === 'code-review');
if (!codeReviewTemplate?.trigger) {
  throw new Error('GitHub plugin no longer contributes the code-review template');
}

const WORKFLOW_NAME = codeReviewTemplate.name;
const WORKFLOW_DESCRIPTION = codeReviewTemplate.description;

/**
 * The review workflow (dag/v1) — the plugin template's definition, re-exported
 * under the name this module has always used:
 *   trigger -> gate (if) -> github.inspect_pull_request (with diff)
 *           -> llm review -> has_review (if) -> github.create_review
 * See plugin-github/src/actions/templates.ts for the node-level rationale.
 */
export const CODE_REVIEW_WORKFLOW_DEFINITION: WorkflowDefinition = codeReviewTemplate.definition;

// Maps a native GitHub webhook payload onto trigger.data. `action` drives the
// gate; the scoping fields resolve per event. Used for the github-app trigger.
export const CODE_REVIEW_VARIABLE_MAPPING: Record<string, string> = codeReviewTemplate.trigger.variableMapping;

export interface EnableCodeReviewResult {
  workflowId: string;
  triggerId: string;
  owner: string;
  repo: string;
  alreadyArmed: boolean;
  /** Set on re-arm when the installed workflow was outdated and got republished. */
  refreshed?: boolean;
}

/**
 * Enable Claude PR reviews on a repository via the org GitHub App. Installs the
 * review workflow (created, published) and a `github-app` trigger scoped to
 * owner/repo. Idempotent per (user, repo): re-arming returns the existing
 * trigger instead of installing a second workflow.
 *
 * The caller must have write access to the repo AND the App must reach the
 * owner — owning a workflow says nothing about the repo, so without this any
 * member could point the App at a private repo they cannot read and have the
 * review step hand them the diff.
 */
export async function enableCodeReview(
  db: AppDb,
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<EnableCodeReviewResult> {
  // Personal until shared workflows exist: the review runs as the arming user's
  // GitHub identity, so require them to have connected it. This is stricter than
  // repo authority alone — a public repo passes assertCallerCanAdministerRepo
  // with no linked account (world-readable), but a personal automation still
  // needs an identity to run as, so gate on the connection first.
  if (!(await hasCredential(env, 'user', userId, 'github'))) {
    throw new ValidationError(
      'Connect your GitHub account in Settings → Integrations before enabling code review — reviews run as your GitHub identity.',
    );
  }

  // Coverage + authority, before anything is created: the App must reach the
  // owner and the caller must personally have write access to the repo.
  await assertCallerCanAdministerRepo(db, env, userId, owner, repo);

  // Idempotent: one github-app trigger per (user, repo). The name is unique per
  // user (idx_triggers_user_name), so re-arming would collide — return the
  // existing trigger instead of a raw constraint error (500).
  const triggerName = `GitHub App: ${owner}/${repo}`;
  const existing = await db
    .select({ id: triggers.id, workflowId: triggers.workflowId })
    .from(triggers)
    .where(and(eq(triggers.userId, userId), eq(triggers.type, 'github-app'), eq(triggers.name, triggerName)))
    .get();
  if (existing) {
    // An armed repo snapshots the workflow definition it was installed with, so
    // a re-arm is the supported way to pick up a newer definition (prompt,
    // post behaviour) without touching the trigger. Republishing runs the same
    // validation gate as a fresh install; when the published definition already
    // matches, this is a read and nothing else.
    const published = await getPublishedDefinition(db, existing.workflowId).catch(() => null);
    const outdated = JSON.stringify(published) !== JSON.stringify(CODE_REVIEW_WORKFLOW_DEFINITION);
    if (outdated) {
      await saveDraft(db, existing.workflowId, CODE_REVIEW_WORKFLOW_DEFINITION);
      const providerEnv = await assembleLlmProviderEnv(db, env);
      const validationEnv = { ...env, ...providerEnv } as Env;
      const availableModels = await resolveAvailableModels(db, validationEnv);
      await publishDraft(db, existing.workflowId, {
        userId,
        env: validationEnv,
        availableModels,
        publishNote: 'Refreshed by code review re-arm',
      });
    }
    return { workflowId: existing.workflowId, triggerId: existing.id, owner, repo, alreadyArmed: true, refreshed: outdated };
  }

  // 1. Create the workflow (blank draft). Everything after is wrapped so a later
  // failure (publish rejection, trigger conflict) rolls the workflow back rather
  // than leaving an orphaned/half-installed row.
  const { workflow } = await createWorkflow(db, userId, {
    name: WORKFLOW_NAME,
    description: WORKFLOW_DESCRIPTION,
  });

  try {
    // 2. Write the definition, 3. publish (publishDraft independently runs full
    // structural + env/model validation).
    await saveDraft(db, workflow.id, CODE_REVIEW_WORKFLOW_DEFINITION);
    const providerEnv = await assembleLlmProviderEnv(db, env);
    const validationEnv = { ...env, ...providerEnv } as Env;
    const availableModels = await resolveAvailableModels(db, validationEnv);
    await publishDraft(db, workflow.id, {
      userId,
      env: validationEnv,
      availableModels,
      publishNote: 'Installed by code review setup',
    });

    // 4. Arm it for the repo. The pull_request event drives the initial review;
    // issue_comment drives @Valet re-review.
    const triggerId = crypto.randomUUID();
    await createTrigger(db, {
      id: triggerId,
      userId,
      workflowId: workflow.id,
      name: triggerName,
      enabled: true,
      type: 'github-app',
      config: JSON.stringify({ type: 'github-app', owner, repo, events: ['pull_request', 'issue_comment'] }),
      variableMapping: JSON.stringify(CODE_REVIEW_VARIABLE_MAPPING),
      now: new Date().toISOString(),
    });

    return { workflowId: workflow.id, triggerId, owner, repo, alreadyArmed: false };
  } catch (err) {
    // Roll back the workflow (cascades to its versions) so a failed enable leaves
    // nothing behind.
    await deleteWorkflow(db, userId, workflow.id).catch((cleanupErr) => {
      console.warn(
        `[enableCodeReview] rollback of workflow ${workflow.id} failed, orphaned row may remain:`,
        cleanupErr,
      );
    });
    throw err;
  }
}
