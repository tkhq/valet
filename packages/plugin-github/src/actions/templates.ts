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
 *   trigger -> gate (if) -> github.inspect_pull_request (with diff)
 *           -> llm review -> github.create_comment
 *
 * Repo-scoped: point the webhook at a repository once and it reviews every PR
 * there. The `gate` if-node only lets through the events that actually mean
 * "there's new code to review" (opened / reopened / synchronize /
 * ready_for_review), so noise events (closed, labeled, assigned, …) short-
 * circuit before the LLM call. A manual run carries no `action`, so the gate's
 * `isEmpty` arm lets "Run now" through for one specific { owner, repo, pullNumber }.
 */
const codeReviewTemplate: WorkflowTemplate = {
  id: 'code-review',
  name: 'Review pull requests and post a comment',
  description:
    'Point this at a repo and Claude reviews every new or updated pull request — checking the diff against the codebase conventions and whether the change does what it says — then posts an actionable review comment back on the PR.',
  category: 'Developer',
  icon: '🔍',
  apps: ['github', 'claude', 'github'],
  steps: [
    'A pull request is opened or updated on the repo',
    'Claude reviews the diff — intent vs. changeset, conventions, correctness',
    'Post the review as a comment on the pull request',
  ],
  // The "test it now" form is a connected-repo + open-PR picker, not free-text.
  runForm: 'github-pr',
  definition: {
    version: 'dag/v1',
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        // Single source of truth for the "Run now" inputs too: the worker
        // derives the gallery's input form from this schema (templateRunInputs).
        // `action` is part of the invocation contract (the webhook maps the
        // GitHub event action into it, and the gate reads it) but is `hidden`
        // so it doesn't surface as a "Run now" form field. Optional: manual
        // runs carry no action, and the gate's isEmpty arm lets them through.
        dataSchema: {
          owner: { type: 'string', required: true, description: 'Repository owner', label: 'Repo owner', placeholder: 'tkhq' },
          repo: { type: 'string', required: true, description: 'Repository name', label: 'Repo name', placeholder: 'valet' },
          pullNumber: { type: 'number', required: true, description: 'Pull request number', label: 'PR number', placeholder: '74' },
          action: { type: 'string', required: false, hidden: true, description: 'GitHub webhook event action (drives the gate)' },
        },
      },
      {
        // Only review on events that introduce or change code. A native GitHub
        // `pull_request` webhook fires for many actions (closed, labeled,
        // assigned, …); reviewing those would waste an LLM call and post noise.
        // `action isEmpty` is the manual-run arm — "Run now" sends no action.
        id: 'gate',
        type: 'if',
        combinator: 'or',
        conditions: [
          { left: 'trigger.data.action', dataType: 'string', operation: 'equals', right: 'opened' },
          { left: 'trigger.data.action', dataType: 'string', operation: 'equals', right: 'reopened' },
          { left: 'trigger.data.action', dataType: 'string', operation: 'equals', right: 'synchronize' },
          { left: 'trigger.data.action', dataType: 'string', operation: 'equals', right: 'ready_for_review' },
          { left: 'trigger.data.action', dataType: 'string', operation: 'isEmpty' },
        ],
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
          'You are a meticulous senior software engineer reviewing a pull request. You are given the ' +
          "PR title and body (the author's stated intent), the base/head branches, and every changed " +
          "file's unified-diff `patch` (the changed lines plus surrounding context). Judge on three axes:\n" +
          '1. INTENT vs. CHANGESET — does the diff actually accomplish what the title/body claim? Flag ' +
          'scope creep, missing pieces, and anything the description promises but the code does not do (or vice versa).\n' +
          '2. CONVENTIONS — is the change consistent with the patterns visible in the surrounding context and ' +
          'the other changed files (naming, error handling, structure, imports, test style)? Call out deviations.\n' +
          '3. CORRECTNESS — bugs, security issues, edge cases, clear regressions, and missing test coverage.\n' +
          'Skip pure style nits unless they cause bugs. Be concise, specific, and actionable; cite file paths. ' +
          'If the change is solid, say so briefly.',
        prompt:
          'Write a single GitHub-flavored markdown review comment for this pull request. Structure it as:\n' +
          '- A one-line verdict.\n' +
          '- **Intent check**: does the change do what it says? (one or two sentences)\n' +
          '- **Findings**: bullet the most important issues (conventions, correctness, edge cases), each with a file reference.\n' +
          'Keep it focused on the diff; omit a section if you have nothing substantive for it.\n\n' +
          'Pull request:\n{{ nodes.fetch_pr.data }}',
        maxOutputTokens: 2000,
      },
      {
        id: 'post',
        type: 'tool',
        service: 'github',
        action: 'github.create_comment',
        summary: 'Post the review as a PR comment',
        onPolicyDeny: 'fail',
        // Post as the org's GitHub App bot (when installed + app access is on),
        // not the workflow owner's personal identity. Falls back to the owner's
        // credential is NOT done here — 'app' is explicit; see the resolver.
        credential: 'app',
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
      { from: 'trigger', to: 'gate' },
      // Only the gate's `true` branch runs the review; non-code events end here.
      { from: 'gate', to: 'fetch_pr', fromOutput: 'true' },
      { from: 'fetch_pr', to: 'review' },
      { from: 'review', to: 'post' },
    ],
  },
  trigger: {
    name: 'GitHub pull_request webhook',
    path: 'code-review',
    // Maps a native GitHub `pull_request` event payload onto trigger.data. Point a
    // GitHub webhook (content-type application/json) at the returned webhookUrl.
    // `action` drives the gate; the review-scoping fields resolve per event.
    variableMapping: {
      action: '$.action',
      owner: '$.repository.owner.login',
      repo: '$.repository.name',
      pullNumber: '$.pull_request.number',
    },
  },
};

/** Templates the GitHub plugin contributes to the gallery. */
export const githubTemplates: WorkflowTemplate[] = [codeReviewTemplate];
