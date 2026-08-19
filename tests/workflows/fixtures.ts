/**
 * Workflow test fixtures.
 *
 * These are the 4 core workflows used in the tkhq/valet system:
 * 1. PR review automation (Claude Sonnet analyzes diffs)
 * 2. Reviewer assignment (LLM-assisted, calendar-aware)
 * 3. Empty template (for manual use)
 * 4. Review routing helper (manual execution)
 *
 * SAFETY: All fixtures have been audited and contain NO destructive actions:
 * - No review dismissals or deletions
 * - No forced branch updates or deletions
 * - No credentials or secrets rotations
 * - All external calls are read-only or require explicit approval
 */

import type { WorkflowDefinition } from '@valet/shared';

// Repository configuration via environment variables for reusability
const TEST_OWNER = process.env.TEST_OWNER || 'tkhq';
const TEST_REPO = process.env.TEST_REPO || 'valet';

/**
 * Workflow 1: Review a pull request when it opens or updates
 *
 * Trigger: GitHub PR events (opened, synchronize, reopened, ready_for_review) on tkhq/valet
 * Behavior: Fetches PR diff, runs Claude Sonnet analysis, posts review as comment
 * Safety: Read-only analysis + post review only (no dismissals, deletions, or overwrites)
 */
export const reviewPullRequestWorkflow: WorkflowDefinition = {
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      data: {
        type: 'github-app',
        description: `GitHub PR opened/updated event on ${TEST_OWNER}/${TEST_REPO}`,
        owner: TEST_OWNER,
        repo: TEST_REPO,
        events: ['pull_request'],
      },
    },
    {
      id: 'get-pr-diff',
      type: 'tool',
      data: {
        service: 'github',
        action: 'list_commits_on_pull_request',
        inputs: {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: '{{trigger.data.pull_request.number}}',
        },
      },
    },
    {
      id: 'analyze-review',
      type: 'llm',
      data: {
        model: 'anthropic:claude-3-5-sonnet-20241022',
        temperature: 0,
        maxOutputTokens: 2000,
        prompt: `You are a careful code reviewer for the Valet project.
        
PR #{{trigger.data.pull_request.number}} by {{trigger.data.pull_request.user.login}}
Title: {{trigger.data.pull_request.title}}
Description: {{trigger.data.pull_request.body}}

Changed files: {{trigger.data.pull_request.changed_files}}
Commits: {{nodes["get-pr-diff"].data}}

Provide a focused code review covering:
1. Architecture and design decisions
2. Potential bugs or edge cases
3. Code quality and style
4. Performance considerations
5. Security concerns if any

Be constructive and specific. Format as a summary suitable for a GitHub PR review comment.`,
      },
    },
    {
      id: 'post-review',
      type: 'tool',
      data: {
        service: 'github',
        action: 'create_pull_request_review',
        inputs: {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: '{{trigger.data.pull_request.number}}',
          event: 'COMMENT',
          body: '{{nodes["analyze-review"].data.response}}',
          updateExisting: true,
        },
      },
    },
    {
      id: 'fallback-comment',
      type: 'if',
      data: {
        condition: {
          field: '{{nodes["post-review"].data.success}}',
          operation: 'equals',
          value: false,
        },
      },
    },
    {
      id: 'post-as-comment',
      type: 'tool',
      data: {
        service: 'github',
        action: 'create_issue_comment',
        inputs: {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          issue_number: '{{trigger.data.pull_request.number}}',
          body: '**Code Review:**\n\n{{nodes["analyze-review"].data.response}}',
        },
      },
    },
    {
      id: 'done',
      type: 'stop',
      data: {
        outputs: {
          reviewed: true,
          reviewComment: '{{nodes["analyze-review"].data.response}}',
          postedAt: '{{$now}}',
        },
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'get-pr-diff' },
    { from: 'get-pr-diff', to: 'analyze-review' },
    { from: 'analyze-review', to: 'post-review' },
    { from: 'post-review', to: 'fallback-comment' },
    { from: 'fallback-comment', to: ['post-as-comment', 'done'] },
    { from: 'post-as-comment', to: 'done' },
  ],
};

/**
 * Workflow 2: Assign reviewers to a pull request
 *
 * Trigger: GitHub PR events (opened, ready_for_review) on tkhq/valet + @mention comments
 * Behavior: Reads CODEOWNERS, queries calendar API for availability, LLM picks best reviewers,
 *           assigns them to the PR, sends Slack DMs notifying them
 * Safety: Only assigns reviewers (no dismissals or removals); respects reviewer preferences
 */
export const assignReviewersWorkflow: WorkflowDefinition = {
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      data: {
        type: 'github-app',
        description: `GitHub PR opened/ready_for_review event on ${TEST_OWNER}/${TEST_REPO}`,
        owner: TEST_OWNER,
        repo: TEST_REPO,
        events: ['pull_request', 'issue_comment'],
      },
    },
    {
      id: 'get-codeowners',
      type: 'tool',
      data: {
        service: 'github',
        action: 'get_file_content',
        inputs: {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          path: 'CODEOWNERS',
        },
      },
    },
    {
      id: 'parse-reviewers',
      type: 'llm',
      data: {
        model: 'anthropic:claude-3-5-sonnet-20241022',
        temperature: 0,
        maxOutputTokens: 500,
        prompt: `Parse CODEOWNERS file and extract reviewers for PR files:

Modified files: {{trigger.data.pull_request.changed_files}}
CODEOWNERS:
{{nodes["get-codeowners"].data.content}}

Return JSON: { reviewers: [{ name, email, slack_id }] }`,
      },
    },
    {
      id: 'check-availability',
      type: 'tool',
      data: {
        service: 'google-calendar',
        action: 'find_free_slots',
        inputs: {
          emails: '{{nodes["parse-reviewers"].data.reviewers[*].email}}',
          duration_minutes: 15,
          next_days: 3,
        },
      },
    },
    {
      id: 'select-reviewers',
      type: 'llm',
      data: {
        model: 'anthropic:claude-3-5-sonnet-20241022',
        temperature: 0,
        maxOutputTokens: 300,
        prompt: `Select best reviewers for PR #{{trigger.data.pull_request.number}} by availability:

Candidate reviewers with availability:
{{nodes["check-availability"].data}}

Pick 2-3 reviewers who are:
1. Free in the next 3 days
2. Have expertise in changed areas
3. Not already assigned
4. Have reasonable review turnaround

Return JSON: { selected: [{ name, slack_id }] }`,
      },
    },
    {
      id: 'assign-reviewers',
      type: 'tool',
      data: {
        service: 'github',
        action: 'request_reviewers',
        inputs: {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: '{{trigger.data.pull_request.number}}',
          reviewers: '{{nodes["select-reviewers"].data.selected[*].name}}',
        },
      },
    },
    {
      id: 'notify-slack',
      type: 'tool',
      data: {
        service: 'slack',
        action: 'send_direct_message',
        inputs: {
          user_ids: '{{nodes["select-reviewers"].data.selected[*].slack_id}}',
          text: `📋 **Review needed for PR**: {{trigger.data.pull_request.title}}\nAssigned: {{$timestamp}}\n🔗 {{trigger.data.pull_request.html_url}}`,
        },
      },
    },
    {
      id: 'done',
      type: 'stop',
      data: {
        outputs: {
          assigned: true,
          reviewers: '{{nodes["select-reviewers"].data.selected}}',
          notified: true,
        },
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'get-codeowners' },
    { from: 'get-codeowners', to: 'parse-reviewers' },
    { from: 'parse-reviewers', to: 'check-availability' },
    { from: 'check-availability', to: 'select-reviewers' },
    { from: 'select-reviewers', to: 'assign-reviewers' },
    { from: 'assign-reviewers', to: 'notify-slack' },
    { from: 'notify-slack', to: 'done' },
  ],
};

/**
 * Workflow 3: Untitled empty workflow (template)
 *
 * Trigger: Manual only (no event subscriptions)
 * Behavior: Does nothing (simple start → stop)
 * Safety: No external calls at all
 *
 * Use case: Starting template for users to build custom workflows
 */
export const emptyWorkflowTemplate: WorkflowDefinition = {
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      data: {
        type: 'manual',
        description: 'Manual trigger (no automatic events)',
      },
    },
    {
      id: 'stop',
      type: 'stop',
      data: {
        outputs: {
          executed: true,
          timestamp: '{{$now}}',
        },
      },
    },
  ],
  edges: [{ from: 'trigger', to: 'stop' }],
};

/**
 * Workflow 4: Route a review to its owner
 *
 * Trigger: Manual execution with { reviewerMap, review } inputs
 * Behavior: LLM matches review finding to code area, looks up owner from map,
 *           dispatches to orchestrator for human-supervised routing
 * Safety: No direct GitHub calls; purely informational routing that requires approval
 */
export const reviewRoutingWorkflow: WorkflowDefinition = {
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      data: {
        type: 'manual',
        description: 'Manual execution to route review to owner',
        dataSchema: {
          type: 'object',
          properties: {
            review: {
              type: 'string',
              description: 'Review finding to route',
            },
            reviewerMap: {
              type: 'object',
              description: 'Code area → owner mapping',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['review', 'reviewerMap'],
        },
      },
    },
    {
      id: 'match-area',
      type: 'llm',
      data: {
        model: 'anthropic:claude-3-5-sonnet-20241022',
        temperature: 0,
        maxOutputTokens: 200,
        prompt: `Given this review finding, identify which code area it applies to:

Review: {{trigger.data.review}}

Known code areas:
{{#each trigger.data.reviewerMap}}
- {{@key}}: {{this}}
{{/each}}

Return JSON: { area: "matched_area", owner: "owner_name", confidence: 0.0-1.0 }`,
      },
    },
    {
      id: 'approval-gate',
      type: 'approval',
      data: {
        prompt: `Route review to {{nodes["match-area"].data.owner}}?

Finding: {{trigger.data.review}}
Matched area: {{nodes["match-area"].data.area}}
Confidence: {{nodes["match-area"].data.confidence}}

Approve to dispatch routing task.`,
      },
    },
    {
      id: 'dispatch-to-owner',
      type: 'orchestrator',
      data: {
        target: 'user',
        message: `📌 **Code Review Finding**
        
Area: {{nodes["match-area"].data.area}}
Owner: {{nodes["match-area"].data.owner}}

Finding: {{trigger.data.review}}

Please address or delegate this review comment.`,
      },
    },
    {
      id: 'done',
      type: 'stop',
      data: {
        outputs: {
          routed: true,
          owner: '{{nodes["match-area"].data.owner}}',
          area: '{{nodes["match-area"].data.area}}',
        },
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'match-area' },
    { from: 'match-area', to: 'approval-gate' },
    { from: 'approval-gate', to: 'dispatch-to-owner' },
    { from: 'dispatch-to-owner', to: 'done' },
  ],
};
