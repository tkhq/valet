import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionContext } from '@valet/sdk';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('octokit', () => ({
  // Octokit is invoked with `new`; a regular function returning an object makes
  // `new Octokit(...)` yield our mock instead of the constructed instance.
  Octokit: vi.fn(function () { return { request: mocks.request }; }),
}));

import { githubActions } from './actions.js';

function actionContext(): ActionContext {
  return {
    credentials: { access_token: 'ghp-token' },
    userId: 'user-1',
  };
}

function actionContextWithAnalytics(): { ctx: ActionContext; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { ctx: { ...actionContext(), analytics: { emit } }, emit };
}

describe('githubActions analytics emits', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('create_pull_request', () => {
    it('emits github.pr_created with repo/number/draft on success', async () => {
      mocks.request.mockResolvedValueOnce({
        data: { number: 42, html_url: 'https://gh/pr/42', title: 'feat', state: 'open', draft: true },
      });
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.create_pull_request', {
        owner: 'acme', repo: 'valet', title: 'feat', head: 'topic', base: 'main', draft: true,
      }, ctx);

      expect(result.success).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('github.pr_created', { properties: { repo: 'valet', number: 42, draft: true } });
    });

    it('does not emit github.pr_created when the request fails', async () => {
      mocks.request.mockRejectedValueOnce(Object.assign(new Error('unprocessable'), { status: 422 }));
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.create_pull_request', {
        owner: 'acme', repo: 'valet', title: 'feat', head: 'topic', base: 'main',
      }, ctx);

      expect(result.success).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('merge_pull_request', () => {
    it('emits github.pr_merged with repo/number when the merge succeeds', async () => {
      mocks.request.mockResolvedValueOnce({ data: { merged: true, message: 'Pull Request merged', sha: 'abc' } });
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.merge_pull_request', {
        owner: 'acme', repo: 'valet', pullNumber: 7,
      }, ctx);

      expect(result.success).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('github.pr_merged', { properties: { repo: 'valet', number: 7 } });
    });

    it('does not emit github.pr_merged when GitHub reports the PR was not merged', async () => {
      mocks.request.mockResolvedValueOnce({ data: { merged: false, message: 'Base branch was modified' } });
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.merge_pull_request', {
        owner: 'acme', repo: 'valet', pullNumber: 7,
      }, ctx);

      expect(result.success).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does not emit github.pr_merged when the merge request throws', async () => {
      mocks.request.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.merge_pull_request', {
        owner: 'acme', repo: 'valet', pullNumber: 7,
      }, ctx);

      expect(result.success).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('create_issue', () => {
    it('emits github.issue_created with repo/number on success', async () => {
      mocks.request.mockResolvedValueOnce({ data: { number: 99, title: 'bug' } });
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.create_issue', {
        owner: 'acme', repo: 'valet', title: 'bug',
      }, ctx);

      expect(result.success).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('github.issue_created', { properties: { repo: 'valet', number: 99 } });
    });

    it('does not emit github.issue_created when the request fails', async () => {
      mocks.request.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
      const { ctx, emit } = actionContextWithAnalytics();

      const result = await githubActions.execute('github.create_issue', {
        owner: 'acme', repo: 'valet', title: 'bug',
      }, ctx);

      expect(result.success).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
