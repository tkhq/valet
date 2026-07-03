// Workflow templates contributed by the GitHub plugin.
//
// Templates live in the plugin that owns the actions they use, so enabling /
// disabling the GitHub plugin adds / removes them from the Templates gallery.
// The worker aggregates every plugin's `templates` via the integration registry.

import type { WorkflowTemplate } from '@valet/sdk';

// Default model for the review step. Must be a catalog-available, vendor-prefixed
// id whose provider key is configured in the worker env, or publishDraft rejects
// the install (llm_model_*).
const DEFAULT_REVIEW_MODEL = 'anthropic:claude-sonnet-4-6';

/**
 * Flagship template: review a pull request.
 *   trigger -> github.inspect_pull_request (with diff) -> llm review -> github.create_comment
 * Fires on a GitHub `pull_request` webhook, or on demand via a manual run that
 * supplies { owner, repo, pullNumber }.
 */
const codeReviewTemplate: WorkflowTemplate = {
  id: 'code-review',
  name: 'Review pull requests and post a comment',
  description:
    'When a pull request is opened, Claude reviews the changed lines and posts a concise, actionable review comment back on the PR.',
  category: 'Developer',
  icon: '🔍',
  apps: ['github', 'claude', 'github'],
  steps: [
    'A pull request is opened or updated on GitHub',
    'Claude reviews the diff — correctness, security, edge cases',
    'Post the review as a comment on the pull request',
  ],
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

/** Templates the GitHub plugin contributes to the gallery. */
export const githubTemplates: WorkflowTemplate[] = [codeReviewTemplate];
