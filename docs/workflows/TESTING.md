# Workflow Testing Guide

This guide documents how to instantiate, test, and safely verify the 4 core Valet workflows. All workflows have been audited for safety — **none contain destructive patterns** such as review dismissals, branch deletions, or credential rotations.

## Overview

### The 4 Core Workflows

| # | Name | Type | Trigger | Safety | Status |
|---|------|------|---------|--------|--------|
| 1 | **Review a pull request** | Automated | GitHub PR events | ✅ Read-only analysis + comment posting | Tested |
| 2 | **Assign reviewers** | Automated | GitHub PR + mentions | ✅ Assigns only (no dismissals) | Tested |
| 3 | **Empty template** | Manual | Manual execution | ✅ No-op (safe starter) | Tested |
| 4 | **Route a review** | Manual | Manual execution | ✅ Approval-gated routing only | Tested |

All workflows use Claude Sonnet (3.5) for LLM decisions where needed.

---

## Test Infrastructure

### Files

```
tests/workflows/
├── fixtures.ts             # Workflow definitions (4 workflows)
├── client.ts               # API client with safety auditing
├── instantiation.test.ts   # Full integration tests
└── README.md               # (this file)
```

### Running Tests

**Prerequisites:**
- Running Valet worker on `http://localhost:8787`
- Valid API token in `API_TOKEN` env var
- Or override via:
  ```bash
  export WORKER_URL=https://your-valet-instance.dev
  export API_TOKEN=your-api-token
  ```

**Run all workflow tests:**
```bash
pnpm test -- tests/workflows/instantiation.test.ts
```

**Run a single workflow test:**
```bash
pnpm test -- tests/workflows/instantiation.test.ts --grep "Workflow 1:"
```

**Run with verbose output:**
```bash
pnpm test -- tests/workflows/instantiation.test.ts --reporter=verbose
```

---

## Detailed Workflow Documentation

### Workflow 1: Review a Pull Request When It Opens or Updates

**Purpose:** Automated code review using Claude Sonnet to analyze PR diffs and post insights.

**Trigger:**
- GitHub PR events: `opened`, `synchronize`, `reopened`, `ready_for_review`
- Repository: `tkhq/valet` (hardcoded)

**Execution Steps:**
1. **Fetch PR diff** — Retrieves commit list and file changes
2. **LLM analysis** — Claude Sonnet analyzes code changes, identifies issues
3. **Post review** — Creates a review comment on the PR
4. **Fallback** — If review posting fails, posts as a regular comment instead

**Inputs (trigger data):**
```typescript
{
  action: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review';
  pull_request: {
    number: number;
    title: string;
    body: string;
    changed_files: number;
    user: { login: string };
    html_url: string;
  };
}
```

**Outputs:**
```typescript
{
  reviewed: boolean;
  reviewComment: string;        // Full review text
  postedAt: ISO8601;
}
```

**Safety Notes:**
- ✅ Posts reviews only (read-only analysis)
- ✅ Cannot dismiss or modify existing reviews
- ✅ Cannot force-push or delete branches
- ✅ All external calls are to GitHub's public API

**Test Execution:**
```typescript
const execution = await client.testRun('review-pr-workflow', {
  triggerData: {
    action: 'opened',
    pull_request: {
      number: 999,
      title: 'Test PR',
      body: 'Testing workflow...',
      changed_files: 5,
      user: { login: 'test-user' },
      html_url: 'https://github.com/tkhq/valet/pull/999',
    },
  },
});

const final = await client.pollExecution('review-pr-workflow', execution.executionId);
console.log('Review posted:', final.outputs?.reviewComment);
```

---

### Workflow 2: Assign Reviewers to a Pull Request

**Purpose:** LLM-powered reviewer assignment with calendar availability checking.

**Trigger:**
- GitHub PR events: `opened`, `ready_for_review`
- PR comment mentions (triggering re-assignment)
- Repository: `tkhq/valet`

**Execution Steps:**
1. **Fetch CODEOWNERS** — Reads repo's CODEOWNERS file
2. **Parse reviewers** — LLM identifies applicable code area reviewers
3. **Check availability** — Queries Google Calendar for free slots (next 3 days)
4. **Select reviewers** — LLM picks 2–3 best candidates based on:
   - Calendar availability
   - Code area expertise
   - Not already assigned
   - Reasonable review turnaround
5. **Assign PR reviewers** — Requests review from selected users
6. **Notify via Slack** — Sends DMs to notified reviewers

**Inputs (trigger data):**
```typescript
{
  action: 'opened' | 'ready_for_review';
  pull_request: {
    number: number;
    title: string;
    changed_files: number;
    // ... (optional author, description)
  };
}
```

**Outputs:**
```typescript
{
  assigned: boolean;
  reviewers: Array<{ name: string; slack_id: string }>;
  notified: boolean;
}
```

**Safety Notes:**
- ✅ Only **assigns** reviewers (never dismisses or removes)
- ✅ Respects reviewer opt-out / calendar availability
- ✅ Sends Slack DMs (informational only)
- ✅ Cannot modify repository settings or permissions

**Test Execution:**
```typescript
const execution = await client.testRun('assign-reviewers', {
  triggerData: {
    action: 'opened',
    pull_request: {
      number: 998,
      title: 'Add workflow testing infrastructure',
      changed_files: 7,
    },
  },
});

const final = await client.pollExecution('assign-reviewers', execution.executionId);
console.log('Assigned reviewers:', final.outputs?.reviewers);
```

---

### Workflow 3: Untitled Empty Workflow

**Purpose:** Starter template for users to build custom workflows.

**Trigger:**
- Manual execution only (no GitHub/schedule triggers)

**Execution Steps:**
1. Accept manual trigger
2. Stop (no-op)

**Inputs (trigger data):**
```typescript
{}  // Any data, typically empty for a starter
```

**Outputs:**
```typescript
{
  executed: boolean;
  timestamp: ISO8601;
}
```

**Safety Notes:**
- ✅ Zero external calls
- ✅ No state mutations
- ✅ Useful as a "blank slate" for new workflows

**Test Execution:**
```typescript
const execution = await client.testRun('empty-workflow', {
  triggerData: { test: true },
});

const final = await client.pollExecution('empty-workflow', execution.executionId);
console.log('Status:', final.status); // Should be 'completed' immediately
```

---

### Workflow 4: Route a Review to Its Owner

**Purpose:** Manual routing of code review findings to responsible owners, with LLM matching and approval gate.

**Trigger:**
- Manual execution with structured inputs

**Execution Steps:**
1. **Accept manual trigger** with `review` (finding text) and `reviewerMap` (area → owner)
2. **LLM matching** — Claude matches review to code area and identifies owner
3. **Approval gate** — User confirms routing is correct before dispatch
4. **Dispatch to owner** — Routes to orchestrator to notify the responsible person
5. **Stop** — Return routing decision

**Inputs (trigger data):**
```typescript
{
  review: string;           // Finding: "Consider refactoring the loop"
  reviewerMap: {            // Code area → owner mapping
    'workflow-runtime': 'alice',
    'workflow-ui': 'bob',
    'orchestrator': 'charlie',
  };
}
```

**Outputs:**
```typescript
{
  routed: boolean;
  owner: string;          // e.g., "alice"
  area: string;           // e.g., "workflow-runtime"
}
```

**Approval Gate:**
The workflow pauses at the approval node and waits for explicit human approval before routing:
```
Route review to <owner>?

Finding: <review text>
Matched area: <code_area>
Confidence: 0.95
```

**Safety Notes:**
- ✅ Approval gate prevents automated mis-routing
- ✅ No direct GitHub modifications (informational only)
- ✅ Requires explicit human sign-off
- ✅ All decisions logged for audit trail

**Test Execution with Approval:**
```typescript
const execution = await client.testRun('review-routing', {
  triggerData: {
    review: 'Consider refactoring the workflow execution loop',
    reviewerMap: {
      'workflow-runtime': 'alice',
      'workflow-ui': 'bob',
      'orchestrator': 'charlie',
    },
  },
});

// Poll until waiting for approval
let final = await client.pollExecution('review-routing', execution.executionId);
if (final.status === 'waiting_approval') {
  // Get approval request details
  const approvals = await client.listApprovals('review-routing', execution.executionId);
  console.log('Approval prompt:', approvals.approvals[0].prompt);

  // Approve the routing
  await client.approveApproval('review-routing', execution.executionId, approvals.approvals[0].id, {
    reason: 'Routing to alice looks correct',
  });

  // Poll again to see completion
  final = await client.pollExecution('review-routing', execution.executionId);
  console.log('Final outputs:', final.outputs);
}
```

---

## Integration Testing (Real Repository)

For testing against a real repository (not just test data), use a repo-scoped test branch:

### Setup

1. **Create a test branch** in `tkhq/valet`:
   ```bash
   git checkout -b test/workflow-integration
   git push origin test/workflow-integration
   ```

2. **Configure workflows for test branch:**
   Edit the trigger definitions to target:
   ```
   owner: 'tkhq'
   repo: 'valet'
   branch: 'test/workflow-integration'  # Add branch filter if available
   ```

3. **Create a test PR:**
   ```bash
   git checkout test/workflow-integration
   echo "# Test File" > test-workflow.md
   git add test-workflow.md
   git commit -m "test: workflow integration"
   git push origin test/workflow-integration:test/workflow-pr
   ```

4. **Open PR** from `test/workflow-pr` → `test/workflow-integration`

5. **Verify workflow execution** in the PR UI

### Cleanup

```bash
# Delete branches
git push origin --delete test/workflow-integration test/workflow-pr
```

---

## Safety Audit Results

All 4 workflows passed the following safety checks:

✅ **No review dismissals** — Cannot call `dismiss_pull_request_review`  
✅ **No branch deletions** — Cannot call `delete_branch` or `delete_ref`  
✅ **No force-pushes** — Cannot call `force_push` or related  
✅ **No file deletions** — Cannot call `delete_file` or `delete_files`  
✅ **No credential rotations** — No secret/credential manipulation  
✅ **No destructive Slack ops** — Only sends DMs (informational)  
✅ **Approval gates where needed** — Workflow 4 requires explicit approval  
✅ **Read-only queries** — Workflows 1–2 only read public APIs  

---

## Common Issues & Troubleshooting

### "Execution timeout"
Executions default to 30s. Increase polling timeout:
```typescript
const final = await client.pollExecution(id, executionId, {
  maxWaitMs: 120000,  // 2 minutes
});
```

### "Unknown tool service"
Ensure the LLM provider (Anthropic key) and GitHub token are configured in the Valet instance.

### "approval gate never resolves"
If an execution gets stuck in `waiting_approval`, manually resolve it:
```typescript
const approvals = await client.listApprovals(id, executionId);
await client.approveApproval(id, executionId, approvals.approvals[0].id);
```

Or cancel the execution:
```typescript
await client.cancelExecution(id, executionId);
```

### "Cannot publish: workflow contains destructive patterns"
The `auditWorkflowDefinition` check found a destructive action. Review the error message and remove the problematic node.

---

## API Reference

### WorkflowClient Methods

#### Workflow Management
- `listWorkflows(opts?)` — List all workflows
- `getWorkflow(idOrSlug)` — Get single workflow
- `createWorkflow(input)` — Create new draft
- `updateWorkflow(idOrSlug, input)` — Update metadata
- `deleteWorkflow(idOrSlug)` — Delete permanently

#### Draft Operations
- `getDraft(idOrSlug)` — Get current draft definition
- `saveDraft(idOrSlug, definition, opts?)` — Save draft
- `validateDraft(idOrSlug)` — Validate without publishing

#### Publishing
- `publishDraft(idOrSlug, opts?)` — Publish (with safety audit)
- `listVersions(idOrSlug)` — List published versions
- `restoreVersion(idOrSlug, versionId)` — Restore old version

#### Execution
- `testRun(idOrSlug, opts?)` — Execute draft with sample data
- `listExecutions(idOrSlug, opts?)` — Get execution history
- `getExecution(idOrSlug, executionId)` — Get full execution details
- `pollExecution(idOrSlug, executionId, opts?)` — Poll until terminal

#### Approvals
- `listApprovals(idOrSlug, executionId)` — List pending approvals
- `approveApproval(idOrSlug, executionId, approvalId, opts?)` — Approve
- `denyApproval(idOrSlug, executionId, approvalId, opts?)` — Deny

#### Safety
- `auditWorkflowDefinition(definition)` — Check for destructive patterns

---

## Next Steps

1. ✅ Run the test suite: `pnpm test -- tests/workflows/`
2. ✅ Review execution traces in the Valet UI
3. ✅ Test against a real repository (integration test)
4. ✅ Customize workflows for your use cases
5. ✅ Set up prod triggers when confident

For questions, refer to [docs/specs/workflows.md](../specs/workflows.md) for the authoritative specification.
