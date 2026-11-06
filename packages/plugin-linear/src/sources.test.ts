import { describe, expect, it } from 'vitest';
import { linearSources } from './sources.js';

describe('linearSources', () => {
  it('makes a source from one issue', () => {
    expect(linearSources('get_issue', {
      identifier: 'XOR-123', title: 'Fix deploy', description: 'Deploys fail.', status: 'In Progress',
      url: 'https://linear.app/xors/issue/XOR-123/fix-deploy',
    })).toEqual([{
      service: 'linear', title: 'XOR-123 Fix deploy', url: 'https://linear.app/xors/issue/XOR-123/fix-deploy',
      snippet: 'Deploys fail.', location: 'In Progress',
    }]);
  });

  it('makes a source for each issue in a list and each comment', () => {
    const issues = linearSources('list_issues', { issues: [
      { identifier: 'XOR-1', title: 'A', url: 'https://linear.app/x/issue/XOR-1/a' },
      { identifier: 'XOR-2', title: 'B', url: 'https://linear.app/x/issue/XOR-2/b' },
    ] });
    expect(issues.map((s) => s.title)).toEqual(['XOR-1 A', 'XOR-2 B']);
    const comments = linearSources('list_comments', [
      { body: 'Looks good', user: { name: 'Ana' }, issue: { identifier: 'XOR-1' }, url: 'https://linear.app/x/issue/XOR-1/a#comment-abc' },
    ]);
    expect(comments).toEqual([{ service: 'linear', title: 'Comment on XOR-1', url: 'https://linear.app/x/issue/XOR-1/a#comment-abc', snippet: 'Looks good', location: 'by Ana' }]);
  });

  it('skips items without a Linear link, writes, and other hosts', () => {
    expect(linearSources('get_issue', { identifier: 'XOR-1', title: 'A' })).toEqual([]);
    expect(linearSources('get_issue', { title: 'A', url: 'https://evil.example/issue' })).toEqual([]);
    expect(linearSources('save_issue', { identifier: 'XOR-1', title: 'A', url: 'https://linear.app/x/issue/XOR-1/a' })).toEqual([]);
  });
});
