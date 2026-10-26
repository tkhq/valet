import { describe, expect, it } from 'vitest';
import { approvalRequestWarning, listingAgentStepWarnings, pushesGitCommits, rewriteStepWarnings, scheduledRunMisses } from './step-design.js';

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
    expect(pushesGitCommits(session('Commit dashboard.json and push.'))).toBe(true);
    expect(pushesGitCommits(session('Run `git -C /workspace/repo push origin main`.'))).toBe(true);
  });

  it('flags a push that follows a negation in an earlier clause', () => {
    expect(pushesGitCommits(session("Don't open a PR; commit and push straight to main."))).toBe(true);
    expect(pushesGitCommits(session('No review needed, just commit and push to main.'))).toBe(true);
    expect(pushesGitCommits(session('Skip the pull request, never wait: git push origin main'))).toBe(true);
  });

  it('reads a long prompt of repeated git options in linear time', () => {
    // Before the option loop was bounded, 200 KB of this took seconds.
    const prompt = 'git -C '.repeat(30_000);
    const started = performance.now();
    expect(pushesGitCommits(session(prompt))).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
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

  it('lets a nested input read cover a top-level read only inside the same expression', () => {
    const definition = {
      nodes: [{ id: 'refresh', type: 'session', prompt: 'Scheduled push setting: {{trigger.data.input.push}}. If {{trigger.data.push}} is true, save the report.' }],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([['refresh', [{ field: 'push', sites: ['template'] }]]]);
  });

  it('reports a field read both in a template and in a condition once, with both sites', () => {
    const definition = {
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'publish', type: 'session', prompt: 'Dry run: {{trigger.data.dry}}' }, { id: 'skip', type: 'stop' }],
      edges: [{ from: 'publish', to: 'skip', when: 'trigger.data.dry' }],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([['publish', [{ field: 'dry', sites: ['template', 'expression'] }]]]);
  });
});

/** The shape of a weekly release report whose output drifted: an agent lists the PRs, and a final agent rewrites the draft. */
const releaseReport = {
  nodes: [
    { id: 'trigger', type: 'trigger' },
    { id: 'inventory', type: 'session', prompt: 'List the PRs merged since {{trigger.timestamp}}.', toolScope: { tools: ['call_tool'], actions: ['github.search_issues'] } },
    { id: 'qualify', type: 'foreach', items: '{{nodes.inventory.result.output.batches}}', itemAlias: 'batch',
      body: { id: 'qualify_batch', type: 'session', prompt: 'Qualify {{batch.prs}}.', toolScope: { actions: ['github.inspect_pull_request'] } } },
    { id: 'assemble', type: 'session', prompt: 'Assemble the report from {{nodes.qualify.result.items}}.' },
    { id: 'verify_and_revise', type: 'session', prompt: 'Check the draft {{nodes.assemble.result.output}} against {{nodes.qualify.result.items}}.' },
    { id: 'post', type: 'tool', service: 'slack', action: 'send_message', params: { text: '{{nodes.verify_and_revise.result.output.text}}' } },
    { id: 'replies', type: 'foreach', items: '{{nodes.verify_and_revise.result.output.thread_replies}}', itemAlias: 'reply',
      body: { id: 'reply', type: 'tool', service: 'slack', action: 'send_message', params: { text: '{{reply.text}}' } } },
  ],
};

describe('listingAgentStepWarnings', () => {
  it('flags a read-only agent step that builds a foreach list', () => {
    const warnings = listingAgentStepWarnings(releaseReport);
    expect([...warnings.keys()]).toEqual(['inventory']);
    expect(warnings.get('inventory')).toContain('foreach step "qualify"');
  });

  it('stays quiet for a tool-step list, an agent step that can write, or one with no action scope', () => {
    const list = (step: Record<string, unknown>) => ({ nodes: [step, { id: 'each', type: 'foreach', items: '{{nodes.list.result.items}}', body: { id: 'b', type: 'llm', prompt: 'x' } }] });
    expect(listingAgentStepWarnings(list({ id: 'list', type: 'tool', service: 'github', action: 'search_issues' })).size).toBe(0);
    expect(listingAgentStepWarnings(list({ id: 'list', type: 'session', toolScope: { actions: ['github.search_issues', 'github.create_issue'] } })).size).toBe(0);
    expect(listingAgentStepWarnings(list({ id: 'list', type: 'session', prompt: 'Run the script.' })).size).toBe(0);
  });
});

describe('rewriteStepWarnings', () => {
  it('flags a model step that rewrites a draft before a tool step sends it', () => {
    const warnings = rewriteStepWarnings(releaseReport);
    expect([...warnings.keys()]).toEqual(['verify_and_revise']);
    expect(warnings.get('verify_and_revise')).toContain('model step "assemble"');
  });

  it('stays quiet when the checking step reads a tool result and feeds an if step', () => {
    // A sales tracker: the model compares the sheet read-back with its own proposal.
    const definition = {
      nodes: [
        { id: 'propose', type: 'llm', prompt: 'Propose values.' },
        { id: 'write', type: 'tool', service: 'sheets', action: 'write_spreadsheet', params: { values: '{{nodes.propose.result.output.values}}' } },
        { id: 'readback', type: 'tool', service: 'sheets', action: 'read_spreadsheet' },
        { id: 'verify', type: 'llm', prompt: 'Compare {{nodes.readback.result}} with {{nodes.propose.result.output}}.' },
        { id: 'ok', type: 'if', conditions: [{ left: 'nodes.verify.result.output.verified', op: 'eq', right: true }] },
      ],
    };
    expect(rewriteStepWarnings(definition).size).toBe(0);
  });

  it('stays quiet for one model step that writes the post from foreach results', () => {
    const definition = {
      nodes: [
        { id: 'list', type: 'tool', service: 'github', action: 'search_issues' },
        { id: 'classify', type: 'foreach', items: '{{nodes.list.result.items}}', body: { id: 'c', type: 'llm', prompt: '{{item.title}}' } },
        { id: 'compose', type: 'llm', prompt: 'Write the post from {{nodes.classify.result.items}}.' },
        { id: 'post', type: 'tool', service: 'slack', action: 'send_message', params: { text: '{{nodes.compose.result.output.text}}' } },
      ],
    };
    expect(rewriteStepWarnings(definition).size).toBe(0);
    expect(listingAgentStepWarnings(definition).size).toBe(0);
  });
});
