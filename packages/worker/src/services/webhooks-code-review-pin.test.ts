// The repo-pinned code-review webhook trigger.
//
// A template install mints a trigger token and points a workflow that reads PR
// diffs and posts App-authored reviews at one repository. Nothing about the
// token itself says which repository, so without the pin one token would review
// — and leak the diff of — any repo the App can reach. These tests cover the
// delivery-side half: the pin is enforced, and the same author-trust and
// org/owner policy the App path applies also apply here.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(
    async (_env: unknown, _input: unknown) => ({ executionId: 'exec-1', status: 'pending' as const }),
  ),
}));
vi.mock('./workflow-dispatch.js', () => ({ dispatchWorkflowExecution: dispatchMock }));

const { getServiceConfigMock } = vi.hoisted(() => ({ getServiceConfigMock: vi.fn() }));
vi.mock('../lib/db/service-configs.js', () => ({ getServiceConfig: getServiceConfigMock }));

const { getGitHubMetadataMock } = vi.hoisted(() => ({ getGitHubMetadataMock: vi.fn() }));
vi.mock('./github-config.js', async (orig) => ({
  ...(await orig<typeof import('./github-config.js')>()),
  getGitHubMetadata: getGitHubMetadataMock,
}));

const { getUserByIdMock, checkIdempotencyKeyMock, updateTriggerLastRunMock } = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  checkIdempotencyKeyMock: vi.fn(),
  updateTriggerLastRunMock: vi.fn(),
}));
vi.mock('../lib/db.js', async (orig) => ({
  ...(await orig<typeof import('../lib/db.js')>()),
  getUserById: getUserByIdMock,
  checkIdempotencyKey: checkIdempotencyKeyMock,
  updateTriggerLastRunUnchecked: updateTriggerLastRunMock,
}));

vi.mock('./executions.js', () => ({
  checkWorkflowConcurrency: async () => ({ allowed: true, activeUser: 0, activeGlobal: 0 }),
}));

vi.mock('../lib/drizzle.js', () => ({ getDb: () => ({} as unknown) }));

import { dispatchWebhookForTrigger, type TriggerWebhookRow } from './webhooks.js';
import type { DispatchWorkflowInput } from './workflow-dispatch.js';
import type { Env } from '../env.js';

const env = { DB: {}, ENCRYPTION_KEY: 'k' } as unknown as Env;

/** The trigger an install of the code-review template creates, pinned to tkhq/valet. */
function pinnedTrigger(): TriggerWebhookRow {
  return {
    id: 'trg-1',
    workflow_id: 'wf-1',
    workflow_name: 'Review pull requests',
    user_id: 'u1',
    version: '1',
    data: '{}',
    config: JSON.stringify({
      type: 'webhook',
      path: 'code-review-abcd1234',
      method: 'POST',
      github: { codeReview: true, owner: 'tkhq', repo: 'valet' },
    }),
    variable_mapping: JSON.stringify({
      action: '$.action',
      owner: '$.repository.owner.login',
      repo: '$.repository.name',
      pullNumber: '$.pull_request.number',
    }),
    webhook_token: 'tok',
  };
}

function prPayload(opts: { owner?: string; repo?: string; action?: string; fork?: boolean; association?: string } = {}) {
  const owner = opts.owner ?? 'tkhq';
  const repo = opts.repo ?? 'valet';
  return {
    action: opts.action ?? 'opened',
    repository: { name: repo, owner: { login: owner } },
    pull_request: {
      number: 74,
      draft: false,
      head: { repo: { full_name: opts.fork ? `stranger/${repo}` : `${owner}/${repo}` } },
      author_association: opts.association ?? 'MEMBER',
    },
  };
}

function deliver(payload: unknown, headers: Record<string, string> = { 'x-github-event': 'pull_request' }) {
  return dispatchWebhookForTrigger(
    env,
    pinnedTrigger(),
    'code-review-abcd1234',
    'POST',
    JSON.stringify(payload),
    headers,
    {},
    '',
  );
}

beforeEach(() => {
  dispatchMock.mockClear();
  getGitHubMetadataMock.mockReset();
  getUserByIdMock.mockReset();
  checkIdempotencyKeyMock.mockReset();
  updateTriggerLastRunMock.mockReset();
  getServiceConfigMock.mockResolvedValue({ config: { appSlug: 'valet-turnkey' }, metadata: {}, configuredBy: null, updatedAt: '' });
  getGitHubMetadataMock.mockResolvedValue({});
  getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: true, codeReviewMentionOnly: false });
  checkIdempotencyKeyMock.mockResolvedValue(null);
});

describe('repo-pinned code-review webhook delivery', () => {
  it('dispatches with the pinned scope for a PR on the armed repo', async () => {
    const { result, statusCode } = await deliver(prPayload());

    expect(statusCode).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    // The scope comes from the pin, never from the body — and carries no
    // `action`, matching the App path (the template gate's isEmpty arm).
    expect(arg.trigger.data).toEqual({ owner: 'tkhq', repo: 'valet', pullNumber: 74 });
    expect(result.dispatched).toBe(true);
  });

  it('refuses a delivery naming a different repository', async () => {
    const { statusCode, result } = await deliver(prPayload({ owner: 'victim-org', repo: 'secret' }));

    expect(statusCode).toBe(403);
    expect(result.reason).toBe('repo_not_allowed');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('refuses a delivery whose payload names no repository at all', async () => {
    const { statusCode } = await deliver({ action: 'opened', pull_request: { number: 74 } });

    expect(statusCode).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('skips a fork PR from an unaffiliated author', async () => {
    const { statusCode } = await deliver(prPayload({ fork: true, association: 'NONE' }));

    expect(statusCode).toBe(200);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('skips an event the review policy does not act on', async () => {
    const { statusCode } = await deliver(prPayload({ action: 'synchronize' }));

    expect(statusCode).toBe(200);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('honours the org master switch', async () => {
    getGitHubMetadataMock.mockResolvedValue({ codeReviewEnabled: false });
    await deliver(prPayload());
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('honours the owner opt-out', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', codeReviewEnabled: false, codeReviewMentionOnly: false });
    await deliver(prPayload());
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('re-reviews on an @mention from someone in the repo', async () => {
    const payload = {
      action: 'created',
      repository: { name: 'valet', owner: { login: 'tkhq' } },
      issue: { number: 74, pull_request: { url: 'x' } },
      comment: { body: '@valet-turnkey re-review', user: { type: 'User' }, author_association: 'MEMBER' },
    };
    const { statusCode } = await deliver(payload, { 'x-github-event': 'issue_comment' });

    expect(statusCode).toBe(200);
    const arg = dispatchMock.mock.calls[0][1] as DispatchWorkflowInput;
    expect(arg.trigger.data).toEqual({ owner: 'tkhq', repo: 'valet', pullNumber: 74 });
  });
});
