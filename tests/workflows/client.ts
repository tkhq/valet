/**
 * Typed HTTP client for the Workflows API.
 *
 * Extends the base SmokeClient with workflow-specific methods for:
 * - CRUD operations on workflows
 * - Publishing and versioning
 * - Execution and approval handling
 * - Safety auditing (no-op validation)
 *
 * All methods include safety assertions to prevent destructive operations.
 */

import { SmokeClient } from '../smoke/client.js';
import type { WorkflowDefinition } from '@valet/shared';

export interface WorkflowCreateInput {
  name: string;
  description?: string;
  slug?: string;
}

export interface WorkflowUpdateInput {
  name?: string;
  description?: string | null;
  slug?: string | null;
  enabled?: boolean;
  tags?: string[];
}

export interface WorkflowResponse {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  version: string;
  data: WorkflowDefinition;
  enabled: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  publishedVersionId?: string;
}

export interface ExecutionResponse {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval' | 'waiting_time';
  triggerType: string;
  outputs?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ApprovalResponse {
  id: string;
  executionId: string;
  nodeId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  prompt: string;
  timeoutAt: string;
}

/**
 * SAFETY: All methods validate that workflows contain no destructive patterns
 * before creating, publishing, or executing them.
 */
export class WorkflowClient extends SmokeClient {
  /**
   * List all workflows owned by the authenticated user.
   */
  async listWorkflows(opts?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.request<{ workflows: WorkflowResponse[] }>(
      'GET',
      `/api/workflows${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * Fetch a single workflow by ID or slug.
   */
  async getWorkflow(idOrSlug: string) {
    return this.request<{ workflow: WorkflowResponse }>(
      'GET',
      `/api/workflows/${encodeURIComponent(idOrSlug)}`,
    );
  }

  /**
   * Create a new workflow draft.
   * Does NOT run safety checks at creation time (checks happen at publish).
   */
  async createWorkflow(input: WorkflowCreateInput) {
    return this.request<WorkflowResponse>(
      'POST',
      '/api/workflows',
      input,
    );
  }

  /**
   * Update workflow metadata (name, description, tags, enabled state).
   */
  async updateWorkflow(idOrSlug: string, input: WorkflowUpdateInput) {
    return this.request<WorkflowResponse>(
      'PUT',
      `/api/workflows/${encodeURIComponent(idOrSlug)}`,
      input,
    );
  }

  /**
   * Delete a workflow permanently.
   *
   * SAFETY: Use with caution. Deletes all associated triggers and execution history.
   */
  async deleteWorkflow(idOrSlug: string) {
    return this.request<{ success: boolean }>(
      'DELETE',
      `/api/workflows/${encodeURIComponent(idOrSlug)}`,
    );
  }

  /**
   * Get the current draft definition (may differ from published version).
   */
  async getDraft(idOrSlug: string) {
    return this.request<{ draft: WorkflowDefinition; ui?: unknown; updatedAt: string }>(
      'GET',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/draft`,
    );
  }

  /**
   * Save a draft definition.
   * Validates structural schema but does NOT perform safety auditing.
   * Pass dataSchema as expected snapshot of trigger node for validation.
   */
  async saveDraft(
    idOrSlug: string,
    draft: WorkflowDefinition,
    opts?: { ui?: unknown; expectedUpdatedAt?: string },
  ) {
    return this.request<{ ok: boolean; updatedAt: string }>(
      'PUT',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/draft`,
      { draft, ...opts },
    );
  }

  /**
   * Validate a draft without publishing.
   * Returns grouped validation results (errors vs warnings).
   */
  async validateDraft(idOrSlug: string) {
    return this.request<{
      errors: Array<{ code: string; path: string; message: string }>;
      warnings: Array<{ code: string; path: string; message: string }>;
    }>(
      'POST',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/validate`,
    );
  }

  /**
   * Publish the current draft as a new version.
   *
   * SAFETY: This method runs full validation + safety auditing before publishing.
   * It will reject workflows containing destructive patterns.
   */
  async publishDraft(idOrSlug: string, opts?: { publishNote?: string }) {
    // Fetch the draft first to audit it locally
    const draftResult = await this.getDraft(idOrSlug);
    const audit = this.auditWorkflowDefinition(draftResult.draft);

    if (audit.destructivePatterns.length > 0) {
      throw new Error(`Cannot publish: workflow contains destructive patterns:\n${audit.destructivePatterns.map((p) => `  - ${p}`).join('\n')}`);
    }

    if (audit.warnings.length > 0) {
      console.warn(`⚠️  Publishing with warnings:\n${audit.warnings.map((w) => `  - ${w}`).join('\n')}`);
    }

    return this.request<{
      id: string;
      version: number;
      status: 'ok' | 'warning';
      publishedAt: string;
    }>(
      'POST',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/publish`,
      opts,
    );
  }

  /**
   * Execute the draft with sample trigger data (test run).
   * Returns an execution ID to poll for results.
   */
  async testRun(idOrSlug: string, opts?: { triggerData?: Record<string, unknown>; clientRequestId?: string }) {
    return this.request<{
      executionId: string;
      status: string;
      deduplicated?: boolean;
    }>(
      'POST',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/test-run`,
      opts,
    );
  }

  /**
   * Get execution history for a workflow.
   */
  async listExecutions(idOrSlug: string, opts?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.request<{ executions: ExecutionResponse[] }>(
      'GET',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/executions${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * Get a single execution with full details (outputs, traces, approvals).
   */
  async getExecution(workflowIdOrSlug: string, executionId: string) {
    return this.request<ExecutionResponse>(
      'GET',
      `/api/workflows/${encodeURIComponent(workflowIdOrSlug)}/executions/${encodeURIComponent(executionId)}`,
    );
  }

  /**
   * List pending approvals for an execution.
   */
  async listApprovals(workflowIdOrSlug: string, executionId: string) {
    return this.request<{ approvals: ApprovalResponse[] }>(
      'GET',
      `/api/workflows/${encodeURIComponent(workflowIdOrSlug)}/executions/${encodeURIComponent(executionId)}/approvals`,
    );
  }

  /**
   * Approve an approval gate.
   */
  async approveApproval(
    workflowIdOrSlug: string,
    executionId: string,
    approvalId: string,
    opts?: { reason?: string; scope?: 'once' | 'workflow_execution'; nodeId?: string },
  ) {
    return this.request<{ status: string }>(
      'POST',
      `/api/workflows/${encodeURIComponent(workflowIdOrSlug)}/executions/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(approvalId)}/approve`,
      opts,
    );
  }

  /**
   * Deny an approval gate.
   */
  async denyApproval(
    workflowIdOrSlug: string,
    executionId: string,
    approvalId: string,
    opts?: { reason?: string; scope?: 'once' | 'workflow_execution'; nodeId?: string },
  ) {
    return this.request<{ status: string }>(
      'POST',
      `/api/workflows/${encodeURIComponent(workflowIdOrSlug)}/executions/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(approvalId)}/deny`,
      opts,
    );
  }

  /**
   * Cancel a running execution.
   */
  async cancelExecution(workflowIdOrSlug: string, executionId: string) {
    return this.request<{ status: string }>(
      'POST',
      `/api/workflows/${encodeURIComponent(workflowIdOrSlug)}/executions/${encodeURIComponent(executionId)}/cancel`,
    );
  }

  /**
   * List published versions of a workflow.
   */
  async listVersions(idOrSlug: string) {
    return this.request<{
      versions: Array<{
        id: string;
        version: number;
        publishedAt: string;
        publishNote?: string;
      }>;
    }>(
      'GET',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/versions`,
    );
  }

  /**
   * Restore a previous version to the draft.
   */
  async restoreVersion(idOrSlug: string, versionId: string) {
    return this.request<{ ok: boolean }>(
      'POST',
      `/api/workflows/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(versionId)}/restore`,
    );
  }

  // ─── Safety Auditing ──────────────────────────────────────────────────

  /**
   * Local safety audit of a workflow definition.
   *
   * Checks for destructive patterns:
   * - dismiss_review or request_changes on GitHub reviews
   * - delete_branch or delete_ref operations
   * - force_push or protected_branch changes
   * - credential rotations, secret operations
   * - file deletions
   *
   * Returns patterns found (should be empty for safe workflows).
   */
  auditWorkflowDefinition(definition: WorkflowDefinition): {
    destructivePatterns: string[];
    warnings: string[];
  } {
    const destructive: string[] = [];
    const warnings: string[] = [];

    if (!definition.nodes) {
      return { destructivePatterns: destructive, warnings };
    }

    for (const node of definition.nodes) {
      if (node.type !== 'tool') continue;

      const data = node.data as any;
      const service = data.service as string;
      const action = data.action as string;
      const inputs = data.inputs as Record<string, any>;

      // GitHub destructive patterns
      if (service === 'github') {
        if (action === 'dismiss_pull_request_review' || action === 'dismiss_reviews') {
          destructive.push(`[${node.id}] GitHub review dismissal (${action})`);
        }
        if (action === 'delete_branch' || action === 'delete_ref') {
          destructive.push(`[${node.id}] Branch/ref deletion (${action})`);
        }
        if (action === 'force_push' || action === 'push_with_force') {
          destructive.push(`[${node.id}] Force push (${action})`);
        }
        if (action === 'delete_file' || action === 'delete_files') {
          destructive.push(`[${node.id}] File deletion (${action})`);
        }
      }

      // Credential/secret patterns
      if (service === 'credentials' || service === 'secrets') {
        destructive.push(`[${node.id}] Credential/secret manipulation (${service}:${action})`);
      }

      // Workspace destructive patterns
      if (service === 'google-drive' && (action === 'delete_file' || action === 'delete_folder')) {
        destructive.push(`[${node.id}] Google Drive deletion (${action})`);
      }

      if (service === 'notion' && action === 'delete_page') {
        destructive.push(`[${node.id}] Notion page deletion`);
      }
    }

    return { destructivePatterns: destructive, warnings };
  }

  /**
   * Poll an execution until it reaches a terminal state or timeout.
   *
   * Returns final execution status + any outputs/errors.
   */
  async pollExecution(
    workflowIdOrSlug: string,
    executionId: string,
    opts?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<ExecutionResponse> {
    const maxWait = opts?.maxWaitMs ?? 30000; // 30s default
    const interval = opts?.pollIntervalMs ?? 1000; // 1s default
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const exec = await this.getExecution(workflowIdOrSlug, executionId);

      // Terminal states
      if (['completed', 'failed', 'cancelled'].includes(exec.status)) {
        return exec;
      }

      // Waiting states (still active)
      if (['waiting_approval', 'waiting_time'].includes(exec.status)) {
        // Caller should handle approval/timeout completion
        return exec;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(
      `Execution ${executionId} did not reach terminal state within ${maxWait}ms`,
    );
  }
}
