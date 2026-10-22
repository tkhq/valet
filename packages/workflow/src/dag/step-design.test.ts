import { describe, expect, it } from 'vitest';
import { approvalRequestWarning, pushesGitCommits, scheduledRunMisses } from './step-design.js';

const session = (prompt: string) => ({ type: 'session', prompt });

describe('approvalRequestWarning', () => {
  it('flags an agent step that tells its agent to get approval', () => {
    expect(approvalRequestWarning(session(
      'Send the people lead a DM: "Linear project creation is ready for approval. Open the workflow run to approve or deny the project creation." Then create the project.',
    ))).toContain('tool step');
    expect(approvalRequestWarning(session('Ask the hiring manager for approval before you send the offer.'))).toBeDefined();
    expect(approvalRequestWarning({ type: 'orchestrator', prompt: 'Call ask_approval before posting.' })).toBeDefined();
    expect(approvalRequestWarning(session('Wait for sign-off from finance, then pay the invoice.'))).toBeDefined();
  });

  it('stays quiet for prompts that forbid asking, or never mention approval', () => {
    expect(approvalRequestWarning(session('The project already exists. Do not ask anyone for approval or send DMs.'))).toBeUndefined();
    expect(approvalRequestWarning(session('Never request approval; report what you need instead.'))).toBeUndefined();
    expect(approvalRequestWarning(session('Summarize the approved budget in three bullets.'))).toBeUndefined();
    expect(approvalRequestWarning({ type: 'llm', prompt: 'Ask for approval.' })).toBeUndefined();
  });
});

describe('pushesGitCommits', () => {
  it('flags an agent step that tells its agent to commit or push', () => {
    expect(pushesGitCommits(session('If {{trigger.data.push}} is true, commit and push data/dashboard.json to main.'))).toBe(true);
    expect(pushesGitCommits(session('Run `git push origin HEAD` when the tests pass.'))).toBe(true);
    expect(pushesGitCommits({ type: 'orchestrator', prompt: 'Push the changes to the main branch.' })).toBe(true);
  });

  it('flags a push that follows a negation in an earlier clause', () => {
    expect(pushesGitCommits(session("Don't open a PR; commit and push straight to main."))).toBe(true);
    expect(pushesGitCommits(session('No review needed, just commit and push to main.'))).toBe(true);
    expect(pushesGitCommits(session('Skip the pull request, never wait: git push origin main'))).toBe(true);
  });

  it('stays quiet for a step that opens a pull request for a person to merge', () => {
    expect(pushesGitCommits(session('Create a branch, commit the fix, push the branch and open a pull request.'))).toBe(false);
    expect(pushesGitCommits(session('git push origin fix-branch, then gh pr create'))).toBe(false);
  });

  it('stays quiet for prompts that forbid pushing, never mention git, or are not agent steps', () => {
    expect(pushesGitCommits(session('Read the diff and comment on it. Do not commit or push anything.'))).toBe(false);
    expect(pushesGitCommits(session('Summarize the open pull requests in three bullets.'))).toBe(false);
    expect(pushesGitCommits(session('Send a push notification to the on-call channel.'))).toBe(false);
    expect(pushesGitCommits(session('Summarize the incidents and push the update to the main Slack channel.'))).toBe(false);
    expect(pushesGitCommits({ type: 'llm', prompt: 'Commit and push the file.' })).toBe(false);
  });
});

describe('scheduledRunMisses', () => {
  it('lists trigger.data fields a scheduled run leaves empty, by node', () => {
    const definition = {
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'gate', type: 'if', conditions: [{ left: 'trigger.data.push', dataType: 'boolean', operation: 'true' }] },
        { id: 'each', type: 'foreach', items: '{{trigger.data.input.rows}}', body: { type: 'tool', params: { to: '{{trigger.data.channel}}' } } },
        { id: 'both', type: 'session', prompt: '{{trigger.data.input.push || trigger.data.push}} {{exists(trigger.data.flag)}}' },
        { id: 'own', type: 'session', prompt: '{{trigger.data.scheduleName}} {{trigger.data.cron}} {{trigger.data.input}} {{trigger.data}}' },
      ],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([
      ['gate', [{ field: 'push', sites: ['expression'] }]],
      ['each', [{ field: 'channel', sites: ['template'] }]],
    ]);
  });

  it('lists a trigger.data read in an edge condition under the edge\'s from node', () => {
    const definition = {
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'publish', type: 'session', prompt: 'go' }, { id: 'skip', type: 'stop' }],
      edges: [
        { from: 'start', to: 'publish', when: 'trigger.data.push' },
        { from: 'start', to: 'skip', when: '!trigger.data.push' },
        { from: 'publish', to: 'skip', when: 'trigger.data.input.dry || trigger.data.dry' },
      ],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([['start', [{ field: 'push', sites: ['expression'] }]]]);
  });

  it('reports a field read both in a template and in a condition once, with both sites', () => {
    const definition = {
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'publish', type: 'session', prompt: 'Dry run: {{trigger.data.dry}}' }, { id: 'skip', type: 'stop' }],
      edges: [{ from: 'publish', to: 'skip', when: 'trigger.data.dry' }],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([['publish', [{ field: 'dry', sites: ['template', 'expression'] }]]]);
  });
});
