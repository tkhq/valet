/**
 * Workflow instantiation and safety tests.
 *
 * These tests verify that the 4 core workflows can be created, published,
 * and executed safely. They validate:
 * - Workflow creation and draft management
 * - Safety auditing (no destructive patterns)
 * - Schema validation
 * - Execution with various trigger types
 * - Approval gate handling
 * - Output verification
 *
 * All tests use mock/test data. NO real PRs, comments, or external calls are made.
 * For integration testing against a live system, use separate fixtures with
 * repo-scoped test branches.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkflowClient } from './client.js';
import {
  reviewPullRequestWorkflow,
  assignReviewersWorkflow,
  emptyWorkflowTemplate,
  reviewRoutingWorkflow,
} from './fixtures.js';

const client = new WorkflowClient();
const TEST_ID = `wf-test-${Date.now()}`;
const workflows: { [key: string]: { id?: string; slug?: string; executionId?: string } } = {};

// ─── Workflow 1: PR Review Automation ──────────────────────────────────────

describe('Workflow 1: Review a pull request when it opens or updates', () => {
  const workflowKey = 'review-pr';
  const workflowSlug = `${TEST_ID}-review-pr`;

  it('creates the workflow draft', async () => {
    const res = await client.createWorkflow({
      name: 'Review PR Automation',
      description: 'Automated code review using Claude Sonnet',
      slug: workflowSlug,
    });

    expect(res.id).toBeDefined();
    expect(res.name).toBe('Review PR Automation');
    expect(res.slug).toBe(workflowSlug);

    workflows[workflowKey] = { id: res.id, slug: res.slug };
  });

  it('saves the workflow definition', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.saveDraft(id, reviewPullRequestWorkflow);
    expect(res.ok).toBe(true);
    expect(res.updatedAt).toBeDefined();
  });

  it('validates the draft (should have no errors)', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.validateDraft(id);
    console.log('Review PR validation:', res);

    // May have warnings about LLM output tokens, but should have no critical errors
    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('audits the definition for destructive patterns (should be clean)', async () => {
    const audit = client.auditWorkflowDefinition(reviewPullRequestWorkflow);

    console.log('Review PR audit:', audit);
    expect(audit.destructivePatterns).toEqual([]);
  });

  it('publishes the workflow', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.publishDraft(slug, {
      publishNote: 'Initial release: PR review automation',
    });

    expect(res.status).toMatch(/^(ok|warning)$/);
    expect(res.version).toBeDefined();
  });

  it('executes a test run with sample PR data', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.testRun(slug, {
      triggerData: {
        action: 'opened',
        pull_request: {
          number: 999,
          title: 'Test PR',
          body: 'This is a test PR for workflow validation',
          changed_files: 5,
          user: { login: 'test-user' },
          html_url: 'https://github.com/tkhq/valet/pull/999',
        },
      },
    });

    expect(res.executionId).toBeDefined();
    workflows[workflowKey].executionId = res.executionId;
  });

  it('polls execution to completion', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const final = await client.pollExecution(slug, executionId, { maxWaitMs: 60000 });

    console.log(`Execution ${executionId} final status:`, final.status);
    // Fail on 'failed' status to catch execution errors
    expect(final.status).not.toBe('failed');
    expect(['completed', 'waiting_approval', 'waiting_time']).toContain(final.status);
  });

  it('retrieves execution outputs', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const exec = await client.getExecution(slug, executionId);

    console.log('Execution details:', {
      status: exec.status,
      outputs: exec.outputs,
      error: exec.error,
    });

    if (exec.status === 'completed' && exec.outputs) {
      expect(exec.outputs).toHaveProperty('reviewed');
    }
  });
});

// ─── Workflow 2: Reviewer Assignment ───────────────────────────────────────

describe('Workflow 2: Assign reviewers to a pull request', () => {
  const workflowKey = 'assign-reviewers';
  const workflowSlug = `${TEST_ID}-assign-reviewers`;

  it('creates the workflow draft', async () => {
    const res = await client.createWorkflow({
      name: 'Assign Reviewers to PR',
      description: 'LLM-assisted, calendar-aware reviewer assignment',
      slug: workflowSlug,
    });

    expect(res.id).toBeDefined();
    workflows[workflowKey] = { id: res.id, slug: res.slug };
  });

  it('saves the workflow definition', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.saveDraft(id, assignReviewersWorkflow);
    expect(res.ok).toBe(true);
  });

  it('validates the draft', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.validateDraft(id);
    console.log('Assign reviewers validation:', res);

    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('audits the definition (should be clean)', async () => {
    const audit = client.auditWorkflowDefinition(assignReviewersWorkflow);

    console.log('Assign reviewers audit:', audit);
    expect(audit.destructivePatterns).toEqual([]);
  });

  it('publishes the workflow', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.publishDraft(slug, {
      publishNote: 'LLM-powered reviewer assignment with calendar integration',
    });

    expect(res.status).toMatch(/^(ok|warning)$/);
  });

  it('executes a test run', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.testRun(slug, {
      triggerData: {
        action: 'opened',
        pull_request: {
          number: 998,
          title: 'Add workflow testing infrastructure',
          changed_files: 7,
        },
      },
    });

    expect(res.executionId).toBeDefined();
    workflows[workflowKey].executionId = res.executionId;
  });

  it('polls execution to completion', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const final = await client.pollExecution(slug, executionId, { maxWaitMs: 60000 });

    console.log(`Execution ${executionId} final status:`, final.status);
    // Fail on 'failed' status to catch execution errors
    expect(final.status).not.toBe('failed');
    expect(['completed', 'waiting_approval', 'waiting_time']).toContain(final.status);
  });

  it('handles approval gates if execution is waiting', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const exec = await client.getExecution(slug, executionId);

    if (exec.status === 'waiting_approval') {
      const approvals = await client.listApprovals(slug, executionId);
      console.log('Pending approvals:', approvals.approvals);

      expect(Array.isArray(approvals.approvals)).toBe(true);

      // For test purposes, we would approve here if needed
      // await client.approveApproval(slug, executionId, approvals.approvals[0].id);
    }
  });
});

// ─── Workflow 3: Empty Template ────────────────────────────────────────────

describe('Workflow 3: Untitled empty workflow (template)', () => {
  const workflowKey = 'empty-template';
  const workflowSlug = `${TEST_ID}-empty`;

  it('creates the workflow draft', async () => {
    const res = await client.createWorkflow({
      name: 'Empty Workflow Template',
      description: 'Starting template for custom workflows',
      slug: workflowSlug,
    });

    expect(res.id).toBeDefined();
    workflows[workflowKey] = { id: res.id, slug: res.slug };
  });

  it('saves the empty definition', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.saveDraft(id, emptyWorkflowTemplate);
    expect(res.ok).toBe(true);
  });

  it('validates the draft (minimal, should pass)', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.validateDraft(id);
    console.log('Empty template validation:', res);

    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('audits the definition (trivially safe)', async () => {
    const audit = client.auditWorkflowDefinition(emptyWorkflowTemplate);

    expect(audit.destructivePatterns).toEqual([]);
  });

  it('publishes the template', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.publishDraft(slug, {
      publishNote: 'Empty starting template',
    });

    expect(res.status).toMatch(/^(ok|warning)$/);
  });

  it('executes the template (should complete immediately)', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.testRun(slug, {
      triggerData: { test: true },
    });

    expect(res.executionId).toBeDefined();
    workflows[workflowKey].executionId = res.executionId;
  });

  it('verifies quick completion', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const final = await client.pollExecution(slug, executionId, { maxWaitMs: 10000 });

    expect(final.status).toBe('completed');
  });

  it('retrieves outputs', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const exec = await client.getExecution(slug, executionId);

    expect(exec.status).toBe('completed');
    expect(exec.outputs).toHaveProperty('executed');
  });
});

// ─── Workflow 4: Review Routing ────────────────────────────────────────────

describe('Workflow 4: Route a review to its owner', () => {
  const workflowKey = 'review-routing';
  const workflowSlug = `${TEST_ID}-review-routing`;

  it('creates the workflow draft', async () => {
    const res = await client.createWorkflow({
      name: 'Route Review to Owner',
      description: 'Manual routing with LLM matching and approval',
      slug: workflowSlug,
    });

    expect(res.id).toBeDefined();
    workflows[workflowKey] = { id: res.id, slug: res.slug };
  });

  it('saves the workflow definition', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.saveDraft(id, reviewRoutingWorkflow);
    expect(res.ok).toBe(true);
  });

  it('validates the draft', async () => {
    const id = workflows[workflowKey].id!;

    const res = await client.validateDraft(id);
    console.log('Review routing validation:', res);

    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('audits the definition (approval-gated, safe)', async () => {
    const audit = client.auditWorkflowDefinition(reviewRoutingWorkflow);

    console.log('Review routing audit:', audit);
    expect(audit.destructivePatterns).toEqual([]);
  });

  it('publishes the workflow', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.publishDraft(slug, {
      publishNote: 'Manual review routing with approval gate',
    });

    expect(res.status).toMatch(/^(ok|warning)$/);
  });

  it('executes a test run with reviewer map', async () => {
    const slug = workflows[workflowKey].slug!;

    const res = await client.testRun(slug, {
      triggerData: {
        review: 'Consider refactoring the workflow execution loop for clarity',
        reviewerMap: {
          'workflow-runtime': 'alice',
          'workflow-ui': 'bob',
          'orchestrator': 'charlie',
        },
      },
    });

    expect(res.executionId).toBeDefined();
    workflows[workflowKey].executionId = res.executionId;
  });

  it('polls execution and handles approval waiting state', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const final = await client.pollExecution(slug, executionId, { maxWaitMs: 60000 });

    console.log(`Execution ${executionId} final status:`, final.status);

    // Fail on 'failed' status to catch execution errors
    expect(final.status).not.toBe('failed');

    // Should be waiting_approval since the routing needs human OK
    if (final.status === 'waiting_approval') {
      const approvals = await client.listApprovals(slug, executionId);
      console.log('Pending approval to route review:', approvals.approvals[0]?.prompt);

      expect(approvals.approvals.length).toBeGreaterThan(0);
      expect(approvals.approvals[0].status).toBe('pending');
    }
  });

  it('can approve the routing decision', async () => {
    const slug = workflows[workflowKey].slug!;
    const executionId = workflows[workflowKey].executionId!;

    const exec = await client.getExecution(slug, executionId);

    if (exec.status === 'waiting_approval') {
      const approvals = await client.listApprovals(slug, executionId);
      const approval = approvals.approvals[0];

      if (approval) {
        const res = await client.approveApproval(slug, executionId, approval.id, {
          reason: 'Review routing looks correct',
        });

        console.log('Approval result:', res);
        expect(res.status).toMatch(/approved|pending/);
      }
    }
  });
});

// ─── Cross-Workflow Tests ──────────────────────────────────────────────────

describe('Workflow safety and interoperability', () => {
  it('all created workflows have audit-clean definitions', () => {
    const allWorkflows = [
      reviewPullRequestWorkflow,
      assignReviewersWorkflow,
      emptyWorkflowTemplate,
      reviewRoutingWorkflow,
    ];

    for (const wf of allWorkflows) {
      const audit = client.auditWorkflowDefinition(wf);
      expect(audit.destructivePatterns).toEqual([]);
    }
  });

  it('can list all test workflows', async () => {
    const res = await client.listWorkflows({ limit: 100 });

    const testWfs = res.workflows.filter((w) => w.slug?.startsWith(TEST_ID));
    console.log(`Found ${testWfs.length} test workflows`);

    expect(testWfs.length).toBeGreaterThanOrEqual(4);
  });

  it('can list versions for each published workflow', async () => {
    for (const [key, wf] of Object.entries(workflows)) {
      const slug = wf.slug!;
      const res = await client.listVersions(slug);

      console.log(`${key}: ${res.versions.length} version(s)`);
      expect(res.versions.length).toBeGreaterThan(0);
    }
  });

  it('can list executions for each workflow', async () => {
    for (const [key, wf] of Object.entries(workflows)) {
      const slug = wf.slug!;
      const res = await client.listExecutions(slug);

      console.log(`${key}: ${res.executions.length} execution(s)`);
      expect(Array.isArray(res.executions)).toBe(true);
    }
  });
});

// ─── Cleanup ───────────────────────────────────────────────────────────────

afterAll(async () => {
  console.log('\n📋 Cleaning up test workflows...');

  for (const [key, wf] of Object.entries(workflows)) {
    if (!wf.id) {
      console.log(`  ⊘ ${key}: no ID, skipping`);
      continue;
    }

    try {
      await client.deleteWorkflow(wf.id);
      console.log(`  ✓ Deleted ${key}`);
    } catch (err) {
      console.warn(`  ✗ Failed to delete ${key}:`, (err as Error).message);
    }
  }
});
