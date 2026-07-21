import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@valet/sdk';

const requestMock = vi.fn();

vi.mock('octokit', () => ({
  Octokit: class {
    request = requestMock;
  },
}));

const { githubActions } = await import('./actions.js');

function ctx(): ActionContext {
  return { credentials: { access_token: 'ghs-fake' }, userId: 'user-1' };
}

/** Endpoint route and body of the most recent octokit request. */
function lastCall(): { route: string; body: Record<string, any> } {
  const [route, body] = requestMock.mock.calls.at(-1) as [string, Record<string, any>];
  return { route, body };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('github.create_review', () => {
  it('posts to the reviews endpoint with snake_case fields', async () => {
    requestMock.mockResolvedValueOnce({ data: { id: 1, state: 'COMMENTED' } });

    const result = await githubActions.execute(
      'github.create_review',
      {
        owner: 'tkhq',
        repo: 'valet',
        pullNumber: 42,
        body: 'A couple of notes.',
        event: 'COMMENT',
        commitId: 'abc123',
        comments: [
          {
            path: 'src/index.ts',
            body: 'This range needs a guard.',
            line: 20,
            side: 'RIGHT',
            startLine: 18,
            startSide: 'RIGHT',
          },
        ],
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { route, body } = lastCall();
    expect(route).toBe('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews');
    expect(body.pull_number).toBe(42);
    expect(body.commit_id).toBe('abc123');
    expect(body.event).toBe('COMMENT');
    expect(body.comments[0].start_line).toBe(18);
    expect(body.comments[0].start_side).toBe('RIGHT');
    // camelCase keys never reach the API.
    expect(body.pullNumber).toBeUndefined();
    expect(body.commitId).toBeUndefined();
    expect(body.comments[0].startLine).toBeUndefined();
  });

  it('rejects a COMMENT event without a body and issues no request', async () => {
    const result = await githubActions.execute(
      'github.create_review',
      { owner: 'tkhq', repo: 'valet', pullNumber: 42, event: 'COMMENT' },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('body is required');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects REQUEST_CHANGES with a blank body', async () => {
    const result = await githubActions.execute(
      'github.create_review',
      { owner: 'tkhq', repo: 'valet', pullNumber: 42, event: 'REQUEST_CHANGES', body: '   ' },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('accepts an APPROVE with no body', async () => {
    requestMock.mockResolvedValueOnce({ data: { id: 2, state: 'APPROVED' } });

    const result = await githubActions.execute(
      'github.create_review',
      { owner: 'tkhq', repo: 'valet', pullNumber: 7, event: 'APPROVE' },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body.event).toBe('APPROVE');
    expect(body.body).toBeUndefined();
  });

  it('passes inline comments through unchanged', async () => {
    requestMock.mockResolvedValueOnce({ data: { id: 3, state: 'PENDING' } });

    const result = await githubActions.execute(
      'github.create_review',
      {
        owner: 'tkhq',
        repo: 'valet',
        pullNumber: 7,
        comments: [
          { path: 'a.ts', body: 'first', line: 10, side: 'RIGHT' },
          { path: 'b.ts', body: 'second', position: 4 },
        ],
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    const { body } = lastCall();
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0]).toMatchObject({ path: 'a.ts', body: 'first', line: 10, side: 'RIGHT' });
    expect(body.comments[1]).toMatchObject({ path: 'b.ts', body: 'second', position: 4 });
    // No event means GitHub leaves the review pending.
    expect(body.event).toBeUndefined();
  });

  it('routes an API error through handleOctokitError', async () => {
    requestMock.mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const result = await githubActions.execute(
      'github.create_review',
      { owner: 'tkhq', repo: 'valet', pullNumber: 42, event: 'APPROVE' },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Create review');
    expect(result.error).toContain('403');
    expect(result.error).toContain('pull_requests:write');
  });

  it('is registered in the action list', async () => {
    const ids = (await githubActions.listActions()).map((a) => a.id);
    expect(ids).toContain('github.create_review');
  });
});
