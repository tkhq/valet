import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseExpression, renderTemplate } from './expression.js';
import { approvalRequestWarning, listingAgentStepWarnings, pushesGitCommits, rewriteStepWarnings, scheduledRunMisses, scheduledTriggerData } from './step-design.js';

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
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'publish', type: 'session', prompt: 'Push setting: {{trigger.data.input.push}}' }, { id: 'skip', type: 'stop' }],
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
      nodes: [{ id: 'start', type: 'trigger' }, { id: 'publish', type: 'session', prompt: 'Dry run: {{trigger.data.dry}} (scheduled: {{trigger.data.input.dry}})' }, { id: 'skip', type: 'stop' }],
      edges: [{ from: 'publish', to: 'skip', when: 'trigger.data.dry' }],
    };
    expect([...scheduledRunMisses(definition)]).toEqual([['publish', [{ field: 'dry', sites: ['template', 'expression'] }]]]);
  });

  it('lists nothing for a workflow that reads its input only at the top level, which a scheduled run copies there', () => {
    const definition = { nodes: [{ id: 'scan', type: 'tool', params: { query: '{cluster=~"{{trigger.data.cluster}}"}', start: 'now-{{trigger.data.lookback}}' } }] };
    expect(scheduledRunMisses(definition).size).toBe(0);
  });
});

describe('scheduledTriggerData', () => {
  const schedule = (input: unknown) => ({ scheduleName: 'Nightly', cron: '0 8 * * *', input });
  const nested = (input: Record<string, unknown>) => ({ scheduleName: 'Nightly', cron: '0 8 * * *', input });
  /** What `source` renders to with the old nested-only data and with the new data. */
  const renders = (definition: unknown, source: string, input: Record<string, unknown>) => [
    renderTemplate(source, { trigger: { data: nested(input) } }),
    renderTemplate(source, { trigger: { data: scheduledTriggerData(definition, schedule(input)) } }),
  ];

  it('copies the input to the top level for a workflow written for manual runs', () => {
    // An error scan whose scheduled runs all failed: both reads rendered null.
    const source = '{cluster=~"{{trigger.data.cluster}}"} since now-{{trigger.data.lookback}}';
    const definition = { nodes: [{ id: 'scan', type: 'tool', params: { query: source } }] };
    expect(scheduledTriggerData(definition, schedule({ cluster: '.+', lookback: '7h' }))).toEqual({
      cluster: '.+', lookback: '7h', scheduleName: 'Nightly', cron: '0 8 * * *', input: { cluster: '.+', lookback: '7h' },
    });
    expect(renders(definition, source, { cluster: '.+', lookback: '7h' })).toEqual(['{cluster=~""} since now-', '{cluster=~".+"} since now-7h']);
  });

  it('renders a workflow that reads a field under trigger.data.input exactly as before', () => {
    // Concatenation as a fallback: a copy would render "mainmain".
    const joined = '{{trigger.data.ref}}{{trigger.data.input.ref}}';
    const either = '{{trigger.data.input.push || trigger.data.push}}';
    const definition = { nodes: [{ id: 'set', type: 'set', values: { ref: joined } }, { id: 'refresh', type: 'session', prompt: either }] };
    const input = { ref: 'main', push: true, other: 'x' };
    for (const source of [joined, either]) {
      const [before, after] = renders(definition, source, input);
      expect(after).toEqual(before);
    }
    expect(scheduledTriggerData(definition, schedule(input))).toMatchObject({ other: 'x' });
    expect(scheduledTriggerData(definition, schedule(input))).not.toHaveProperty('ref');
  });

  it('counts a nested read in an if condition or an edge', () => {
    const definition = {
      nodes: [{ id: 'live', type: 'if', conditions: [{ left: 'trigger.data.input.dry_run', operation: 'isFalse' }] }],
      edges: [{ from: 'live', to: 'post', when: 'trigger.data.input.channel' }],
    };
    expect(scheduledTriggerData(definition, schedule({ dry_run: true, channel: 'C1' }))).toEqual(nested({ dry_run: true, channel: 'C1' }));
  });

  it('copies nothing when a step reads the whole envelope', () => {
    const definition = { nodes: [{ id: 'sweep', type: 'session', prompt: 'Full trigger envelope: {{trigger.data}}' }] };
    expect(scheduledTriggerData(definition, schedule({ mode: 'sweep' }))).toEqual(nested({ mode: 'sweep' }));
    const inputWhole = { nodes: [{ id: 'sweep', type: 'session', prompt: '{{trigger.data.input}}' }] };
    expect(scheduledTriggerData(inputWhole, schedule({ mode: 'sweep' }))).toEqual(nested({ mode: 'sweep' }));
  });

  it('copies no field that a step probes with exists, so a manual-versus-scheduled branch keeps its answer', () => {
    const probe = 'exists(trigger.data.dryRun)';
    const definition = {
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { dryRun: { type: 'boolean', default: false } } },
        { id: 'manual', type: 'if', conditions: [{ left: probe, operation: 'isTrue' }] },
        { id: 'note', type: 'session', prompt: 'Manual: {{exists(trigger.data["dryRun"])}}' },
      ],
      edges: [{ from: 'manual', to: 'note', when: probe }],
    };
    const data = scheduledTriggerData(definition, schedule({ dryRun: true, other: 1 }));
    expect(data).toEqual({ other: 1, scheduleName: 'Nightly', cron: '0 8 * * *', input: { dryRun: true, other: 1 } });
    expect(evaluateExpression(parseExpression(probe), { trigger: { data } })).toBe(false);
  });

  it('reads an exists probe in every path syntax the parser accepts', () => {
    for (const probe of ['exists(trigger.data.dryRun)', 'exists(trigger.data["dryRun"])', 'exists(trigger.data[dryRun])', 'exists(trigger["data"].dryRun)']) {
      const definition = { nodes: [{ id: 'manual', type: 'if', conditions: [{ left: probe, operation: 'isTrue' }] }] };
      const data = scheduledTriggerData(definition, schedule({ dryRun: true }));
      expect(data, probe).not.toHaveProperty('dryRun');
      expect(evaluateExpression(parseExpression(probe), { trigger: { data } }), probe).toBe(false);
    }
    const whole = { nodes: [{ id: 's', type: 'session', prompt: '{{ exists(trigger.data) }}' }] };
    expect(scheduledTriggerData(whole, schedule({ dryRun: true }))).toEqual(nested({ dryRun: true }));
  });

  it('keeps an input key named like a schedule key under input only', () => {
    const data = scheduledTriggerData({ nodes: [] }, schedule({ cron: 'mine', input: 'mine', scheduleName: 'mine', ok: 1 }));
    expect(data).toEqual({ ok: 1, scheduleName: 'Nightly', cron: '0 8 * * *', input: { cron: 'mine', input: 'mine', scheduleName: 'mine', ok: 1 } });
  });

  it('gives a field the schedule leaves out its dataSchema default, as a manual run does', () => {
    const definition = {
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: {
          lookback: { type: 'string', default: '7h' },
          cluster: { type: 'string', default: '.+', required: true },
          channel: { type: 'string', required: true },
        } },
        { id: 'scan', type: 'tool', params: { query: '{cluster=~"{{trigger.data.cluster}}"} since now-{{trigger.data.lookback}} to {{trigger.data.channel}}' } },
      ],
    };
    const data = scheduledTriggerData(definition, schedule({ cluster: 'prod' }));
    // The sent value wins over the default; a field with no default stays absent instead of failing the run.
    expect(data).toEqual({ cluster: 'prod', lookback: '7h', scheduleName: 'Nightly', cron: '0 8 * * *', input: { cluster: 'prod' } });
    expect(renderTemplate('since now-{{trigger.data.lookback}}', { trigger: { data } })).toBe('since now-7h');
  });

  it('adds no default for a field the definition reads under trigger.data.input, or when it reads the envelope whole', () => {
    const schema = { dry_run: { type: 'boolean', default: true } };
    const nestedRead = { nodes: [{ id: 'trigger', type: 'trigger', dataSchema: schema }, { id: 'live', type: 'if', conditions: [{ left: 'trigger.data.input.dry_run', operation: 'isFalse' }] }] };
    expect(scheduledTriggerData(nestedRead, schedule({}))).toEqual(nested({}));
    const whole = { nodes: [{ id: 'trigger', type: 'trigger', dataSchema: schema }, { id: 's', type: 'session', prompt: '{{trigger.data}}' }] };
    expect(scheduledTriggerData(whole, schedule({}))).toEqual(nested({}));
  });

  it('copies nothing for a missing or non-object input', () => {
    expect(scheduledTriggerData({ nodes: [] }, schedule(null))).toEqual({ scheduleName: 'Nightly', cron: '0 8 * * *', input: null });
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

  it('stays quiet for an agent step that reads item content to choose the list', () => {
    const definition = { nodes: [
      { id: 'inventory', type: 'session', toolScope: { actions: ['slack.list_channels', 'slack.read_history'] } },
      { id: 'review', type: 'foreach', items: '{{nodes.inventory.result.output.items}}', body: { id: 'r', type: 'llm', prompt: '{{item.text}}' } },
    ] };
    expect(listingAgentStepWarnings(definition).size).toBe(0);
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

  it('flags a step named for an edit pass even when its prompt does not say so', () => {
    const definition = { nodes: [
      { id: 'compose', type: 'llm', prompt: 'Write the reply.' },
      { id: 'tighten', type: 'llm', prompt: 'Make it read like live chat: {{nodes.compose.result.output.text}}' },
      { id: 'send', type: 'tool', service: 'slack', action: 'send_message', params: { text: '{{nodes.tighten.result.output.text}}' } },
    ] };
    expect([...rewriteStepWarnings(definition).keys()]).toEqual(['tighten']);
  });

  it('stays quiet for a step that writes a message from data an agent gathered', () => {
    // Gather with tools, then compose: two jobs, not a rewrite.
    const definition = { nodes: [
      { id: 'gather', type: 'orchestrator', prompt: 'Call tools to gather tomorrow\'s tasks and meetings.' },
      { id: 'compose', type: 'llm', prompt: 'Write a Slack reminder from {{nodes.gather.result.response}}. Do not rewrite task titles.' },
      { id: 'send', type: 'tool', service: 'slack', action: 'send_message', params: { text: '{{nodes.compose.result.output.text}}' } },
    ] };
    expect(rewriteStepWarnings(definition).size).toBe(0);
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
