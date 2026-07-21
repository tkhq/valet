// End-to-end run of the code-review template through the real interpreter.
//
// The other template tests assert the DAG's literal strings, which cannot tell
// you whether the thing actually posts a review: rename the schema-less LLM
// output wrapper key or the credential field and every one of them stays green
// while the pipeline silently stops short of `github.create_review`. This test
// runs the published definition — trigger → gate → fetch_pr → review →
// has_review → post — with only the GitHub action source and the LLM adapter
// stubbed, and asserts what reaches the final call.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());
const listActionsMock = vi.hoisted(() => vi.fn());
const resolveCredentialsMock = vi.hoisted(() => vi.fn());
const generateStructuredMock = vi.hoisted(() => vi.fn());
const invokeWorkflowActionMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/registry.js', () => ({
  integrationRegistry: {
    getActions: () => ({
      listActions: (...args: unknown[]) => listActionsMock(...args),
      execute: (...args: unknown[]) => executeMock(...args),
    }),
    getProvider: () => ({ service: 'github', authType: 'oauth2' }),
    resolveCredentials: (...args: unknown[]) => resolveCredentialsMock(...args),
    listTemplates: () => [],
  },
}));

vi.mock('../lib/db/disabled-actions.js', () => ({
  isActionDisabled: async () => false,
}));

vi.mock('../services/custom-mcp-connectors.js', () => ({
  loadCustomMcpConnectorContext: async () => ({}),
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: () => ({} as unknown),
}));

vi.mock('../services/actions.js', () => ({
  invokeWorkflowAction: (...args: unknown[]) => invokeWorkflowActionMock(...args),
  markExecuted: async () => {},
  markFailed: async () => {},
}));

vi.mock('../lib/db/actions.js', () => ({
  updateInvocationStatus: async () => {},
}));

vi.mock('../lib/db/channels.js', () => ({
  getUserIdentityLinks: async () => [],
}));

// setExecutionStatus persists the workflow_executions row; its boolean return
// is the runtime's CAS result, so it must report success or the wave loop never
// starts. Nothing here depends on the row itself.
vi.mock('./execution-status.js', () => ({
  setExecutionStatus: async () => true,
  readExecutionCancelState: async () => ({ cancelled: false, status: 'running' }),
}));

vi.mock('./spawned-session-cleanup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spawned-session-cleanup.js')>()),
  terminateWorkflowSpawnedSessions: async () => ({ attempted: 0, terminated: 0, failed: [] }),
}));

vi.mock('../lib/llm/structured-output.js', () => ({
  generateStructured: (...args: unknown[]) => generateStructuredMock(...args),
}));

vi.mock('../lib/llm/provider-env.js', () => ({
  assembleLlmProviderEnv: async () => ({}),
}));

import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { runDag } from './runtime.js';
import { githubTemplates } from '@valet/plugin-github/actions';
import { noopTraceWriter, type WorkflowRunParams } from './types.js';
import type { Env } from '../env.js';

const codeReview = githubTemplates.find((t) => t.id === 'code-review')!;

function makeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, configOrFn: WorkflowStepConfig | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<T>;
      return fn();
    },
    async sleep() { /* noop */ },
    async sleepUntil() { /* noop */ },
    async waitForEvent() { throw new Error('the code-review template must not park on an approval'); },
  } as unknown as WorkflowStep;
}

const PR_PAYLOAD = {
  title: 'Add retry to the queue consumer',
  body: 'Retries a failed consume three times.',
  files: [{ filename: 'src/queue.ts', patch: '@@ -1 +1 @@\n-consume()\n+consumeWithRetry()' }],
};

function params(): WorkflowRunParams {
  return {
    executionId: 'exec-code-review',
    workflowId: 'wf-code-review',
    userId: 'user-1',
    trigger: {
      type: 'webhook',
      timestamp: '2026-07-20T00:00:00.000Z',
      // What the repo-pinned webhook and the GitHub App dispatch both hand the
      // workflow: the review scope with no `action` (the gate's isEmpty arm).
      data: { owner: 'tkhq', repo: 'valet', pullNumber: 74 },
      metadata: { source: 'github-app' },
    },
    definition: codeReview.definition,
    mode: 'production',
  };
}

/** Params for the args of the Nth `execute` call, by action id. */
function callFor(actionId: string) {
  const call = executeMock.mock.calls.find((c) => c[0] === actionId);
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  executeMock.mockReset();
  listActionsMock.mockReset();
  resolveCredentialsMock.mockReset();
  generateStructuredMock.mockReset();
  invokeWorkflowActionMock.mockReset();

  listActionsMock.mockResolvedValue([
    { id: 'github.inspect_pull_request', riskLevel: 'low' },
    { id: 'github.create_review', riskLevel: 'medium' },
  ]);
  resolveCredentialsMock.mockResolvedValue({
    ok: true,
    credential: { accessToken: 'ghs_app_token', credentialType: 'app_install', refreshed: false },
  });
  invokeWorkflowActionMock.mockResolvedValue({ outcome: 'allowed' });
  executeMock.mockImplementation(async (actionId: string) => {
    if (actionId === 'github.inspect_pull_request') return { success: true, data: PR_PAYLOAD };
    return { success: true, data: { id: 991, state: 'COMMENTED' } };
  });
});

describe('code-review template — full interpreter run', () => {
  it('reaches github.create_review with the trigger scope, a COMMENT event and the model write-up', async () => {
    generateStructuredMock.mockResolvedValue({ value: { response: 'Looks good. One note on src/queue.ts.' }, attempts: 1 });

    const result = await runDag({ DB: {} } as Env, params(), makeStep(), noopTraceWriter);

    expect(result.status).toBe('completed');

    // The diff really was fetched for the PR the trigger named, with the patch.
    expect(callFor('github.inspect_pull_request')).toEqual({
      owner: 'tkhq', repo: 'valet', pullNumber: 74, includePatch: true,
    });

    // The review is posted as a review (not an issue comment), advisory-only,
    // carrying the model's text — the wiring the string assertions can't prove.
    expect(callFor('github.create_review')).toEqual({
      owner: 'tkhq',
      repo: 'valet',
      pullNumber: 74,
      event: 'COMMENT',
      body: 'Looks good. One note on src/queue.ts.',
    });

    // 'app' is what makes the review appear under the org bot; a typo here
    // would resolve the workflow owner's personal token instead.
    const credentialCall = resolveCredentialsMock.mock.calls.at(-1);
    expect(credentialCall?.[3]).toMatchObject({ credentialMode: 'app' });

    // The PR body reaches the model wrapped in the untrusted-data delimiters.
    const prompt = String(generateStructuredMock.mock.calls[0][0].prompt);
    expect(prompt).toContain('<pull_request>');
    expect(prompt).toContain('</pull_request>');
    expect(prompt).toContain('Add retry to the queue consumer');
    expect(String(generateStructuredMock.mock.calls[0][0].system)).toContain('UNTRUSTED INPUT');
  });

  it('posts nothing when the model returns only whitespace', async () => {
    generateStructuredMock.mockResolvedValue({ value: { response: '   \n\t ' }, attempts: 1 });

    const result = await runDag({ DB: {} } as Env, params(), makeStep(), noopTraceWriter);

    expect(result.status).toBe('completed');
    expect(callFor('github.inspect_pull_request')).toBeDefined();
    // create_review rejects an empty body, so the gate has to stop short of it.
    expect(callFor('github.create_review')).toBeUndefined();
    expect(result.state.skipped.post).toBeTruthy();
  });

  it('skips the whole review for a webhook event the gate does not accept', async () => {
    generateStructuredMock.mockResolvedValue({ value: { response: 'should never run' }, attempts: 1 });

    const closed = params();
    closed.trigger.data = { owner: 'tkhq', repo: 'valet', pullNumber: 74, action: 'closed' };
    const result = await runDag({ DB: {} } as Env, closed, makeStep(), noopTraceWriter);

    expect(result.status).toBe('completed');
    expect(executeMock).not.toHaveBeenCalled();
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });
});
