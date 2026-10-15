/**
 * The V1 converter. Each case pastes what V1 returned and checks the graph
 * and the checklist. Every definition the converter returns must pass the
 * validator, so `convert` asserts that once for every case.
 */
import { describe, expect, it } from 'vitest';

import { renderTemplate } from './dag/expression.js';
import type { WorkflowNode } from './dag/nodes.js';
import { resolveTriggerInput, triggerDataSchema } from './dag/trigger-input.js';
import { validateWorkflowDefinition } from './dag/validate.js';
import {
  convertV1Workflows,
  readV1Paste,
  v1ChecklistPrompt,
  v1CronDifference,
  type V1Conversion,
  type V1ConvertedWorkflow,
} from './v1-convert.js';

function convert(input: unknown): V1Conversion {
  const result = convertV1Workflows(input);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  for (const wf of result.value.workflows) {
    expect(validateWorkflowDefinition(wf.definition)).toEqual({ ok: true });
  }
  return result.value;
}

function one(steps: unknown[]): V1ConvertedWorkflow {
  const workflows = convert({ steps }).workflows;
  expect(workflows).toHaveLength(1);
  return workflows[0]!;
}

function node(wf: V1ConvertedWorkflow, id: string): WorkflowNode {
  const found = wf.definition.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id} in ${wf.definition.nodes.map((n) => n.id).join(', ')}`);
  return found;
}

function edges(wf: V1ConvertedWorkflow): string[] {
  return wf.definition.edges.map((e) => `${e.from}->${e.to}${e.fromOutput ? `:${e.fromOutput}` : ''}`);
}

/** Node ids the trigger reaches when node `without` never lets a run past it. */
function reachableWithout(wf: V1ConvertedWorkflow, without: string): string[] {
  const seen = new Set(['trigger']);
  const queue = ['trigger'];
  for (let from = queue.shift(); from !== undefined; from = queue.shift()) {
    if (from === without) continue;
    for (const e of wf.definition.edges) {
      if (e.from === from && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  seen.delete(without);
  return [...seen];
}

function prompt(n: WorkflowNode): string {
  if (n.type !== 'session' && n.type !== 'approval') throw new Error(`${n.id} is a ${n.type} node`);
  return String(renderTemplate(n.prompt, {}));
}

describe('convertV1Workflows: steps', () => {
  const cases: { name: string; steps: unknown[]; check: (wf: V1ConvertedWorkflow) => void }[] = [
    {
      name: 'one agent message becomes one session node',
      steps: [{ id: 'triage', type: 'agent_message', content: 'Triage the open issues.' }],
      check: (wf) => {
        expect(wf.name).toBe('Imported V1 workflow');
        expect(prompt(node(wf, 'triage'))).toBe('Triage the open issues.');
        expect(edges(wf)).toEqual(['trigger->triage', 'triage->stop']);
        expect(wf.checklist).toEqual([]);
      },
    },
    {
      name: 'consecutive messages and commands share one session node, in order',
      steps: [
        { id: 'pull', type: 'bash', command: 'git pull', cwd: '/workspace/app' },
        { id: 'fix', type: 'agent_message', message: 'Fix the failing test.' },
        { id: 'push', type: 'tool', tool: 'bash', arguments: { command: 'git push' } },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.type)).toEqual(['trigger', 'session', 'stop']);
        const text = prompt(node(wf, 'pull'));
        expect(text.startsWith('Complete these steps in order.')).toBe(true);
        expect(text.indexOf('git pull')).toBeLessThan(text.indexOf('Fix the failing test.'));
        expect(text.indexOf('Fix the failing test.')).toBeLessThan(text.indexOf('git push'));
        expect(text).toContain('Run it in /workspace/app.');
      },
    },
    {
      name: 'an approval splits the shared session, and the checklist says so',
      steps: [
        { id: 'draft', type: 'agent_message', content: 'Draft the release notes.' },
        { id: 'ok', type: 'approval', prompt: 'Publish the notes?' },
        { id: 'publish', type: 'agent_message', content: 'Publish them.' },
      ],
      check: (wf) => {
        expect(prompt(node(wf, 'ok'))).toBe('Publish the notes?');
        expect(edges(wf)).toEqual(['trigger->draft', 'draft->ok', 'ok->publish', 'publish->stop']);
        expect(wf.checklist).toEqual([expect.stringContaining('2 session nodes ("draft", "publish")')]);
      },
    },
    {
      name: 'a conditional with equals becomes an if node on the trigger input',
      steps: [
        {
          id: 'env',
          type: 'conditional',
          condition: { variable: 'target', equals: 'prod' },
          then: [{ id: 'deploy', type: 'agent_message', content: 'Deploy.' }],
          else: [{ id: 'skip', type: 'approval' }],
        },
      ],
      check: (wf) => {
        expect(node(wf, 'env')).toEqual({
          id: 'env',
          type: 'if',
          conditions: [{ left: 'trigger.data.target', dataType: 'string', operation: 'equals', right: 'prod' }],
        });
        expect(edges(wf)).toEqual(['trigger->env', 'env->deploy:true', 'env->skip:false', 'deploy->stop', 'skip->stop']);
        expect(node(wf, 'trigger')).toMatchObject({ dataSchema: { target: { type: 'string' } } });
        expect(prompt(node(wf, 'skip'))).toBe('Approval required for step skip');
      },
    },
    {
      name: 'a conditional with no equals tests truthiness, and an empty branch goes straight on',
      steps: [
        { id: 'check', type: 'conditional', condition: { variable: 'dry-run' }, then: [{ id: 'a', type: 'agent_message', content: 'A' }] },
      ],
      check: (wf) => {
        expect(node(wf, 'check')).toMatchObject({
          conditions: [{ left: 'trigger.data["dry-run"]', dataType: 'boolean', operation: 'equals', right: true }],
        });
        expect(edges(wf)).toContain('check->stop:false');
      },
    },
    {
      name: 'a truthiness condition takes a value of any type, as V1 did',
      steps: [{ id: 'has-pr', type: 'conditional', condition: { variable: 'prUrl' }, then: [{ id: 'a', type: 'agent_message', content: 'Review it.' }] }],
      check: (wf) => {
        // A declared boolean input refused a run that passed a URL string.
        expect(node(wf, 'trigger')).not.toHaveProperty('dataSchema');
        const schema = triggerDataSchema(wf.definition);
        for (const prUrl of ['https://github.com/o/r/pull/1', true, 1]) {
          expect(resolveTriggerInput(schema, { prUrl }).errors).toEqual([]);
        }
        expect(wf.checklist).toEqual([expect.stringContaining('If node "has-pr" checks that "prUrl" has a value, as V1 did.')]);
      },
    },
    {
      name: 'a boolean equals compares strictly',
      steps: [{ id: 'flag', type: 'conditional', condition: { variable: 'urgent', equals: false } }],
      check: (wf) => {
        expect(node(wf, 'flag')).toMatchObject({ conditions: [{ dataType: 'boolean', operation: 'isFalse' }] });
        expect(node(wf, 'trigger')).toMatchObject({ dataSchema: { urgent: { type: 'boolean' } } });
      },
    },
    {
      name: 'a constant condition keeps only the branch V1 ran, and merges into the session around it',
      steps: [
        { id: 'a', type: 'agent_message', content: 'First.' },
        {
          id: 'c',
          type: 'conditional',
          condition: true,
          then: [{ id: 'b', type: 'agent_message', content: 'Second.' }],
          else: [{ id: 'x', type: 'agent_message', content: 'Never.' }],
        },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.type)).toEqual(['trigger', 'session', 'stop']);
        expect(prompt(node(wf, 'a'))).toContain('Second.');
        expect(prompt(node(wf, 'a'))).not.toContain('Never.');
        expect(wf.checklist).toEqual([expect.stringContaining('V1 always ran its "then" steps')]);
      },
    },
    {
      name: 'a condition on a step output names the node to read instead',
      steps: [
        { id: 'scan', type: 'agent_message', content: 'Scan.', outputVariable: 'scanResult' },
        { id: 'gate', type: 'conditional', condition: { variable: 'scanResult', equals: 'clean' } },
      ],
      check: (wf) => {
        expect(node(wf, 'trigger')).not.toHaveProperty('dataSchema');
        expect(wf.checklist).toEqual([
          expect.stringContaining('output of step "scan" (now node "scan"). V2 reads a node\'s output as nodes.<id>.result'),
        ]);
      },
    },
    {
      name: 'nested steps run in id order, as V1 ran them, and the checklist says so',
      steps: [
        {
          id: 'c',
          type: 'conditional',
          condition: { variable: 'go', equals: 'yes' },
          then: [
            { id: 'b-second', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy.', workspace: 'app' } },
            { id: 'a-first', type: 'approval', prompt: 'A' },
          ],
        },
      ],
      check: (wf) => {
        expect(edges(wf)).toContain('a-first->b-second');
        expect(reachableWithout(wf, 'a-first')).not.toContain('b-second');
        expect(wf.checklist).toEqual([expect.stringContaining('in id order ("a-first", "b-second"), not in the order listed. The import keeps the V1 order.')]);
      },
    },
    {
      name: 'a parallel step runs its steps one after another, as V1 did',
      steps: [
        { id: 'start', type: 'approval', prompt: 'Start?' },
        {
          id: 'both',
          type: 'parallel',
          steps: [
            { id: 'left', type: 'agent_message', content: 'Left.' },
            { id: 'right', type: 'tool', tool: 'spawn_session', arguments: { task: 'Right.', workspace: 'app' } },
          ],
        },
      ],
      check: (wf) => {
        expect(edges(wf)).toEqual(['trigger->start', 'start->left', 'left->right', 'right->stop']);
        expect(wf.checklist).toEqual([expect.stringContaining('V1 ran its 2 steps one after another, in id order ("left", "right"). The import does the same.')]);
      },
    },
    {
      name: 'a denied approval inside a parallel step still stops the deploy after it',
      steps: [
        {
          id: 'release',
          type: 'parallel',
          steps: [
            { id: 'z_notes', type: 'agent_message', content: 'Write release notes.' },
            { id: 'a_gate', type: 'approval', prompt: 'Ship it?' },
          ],
        },
        { id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy to prod.', workspace: 'app' } },
      ],
      check: (wf) => {
        // V1 sorted a_gate first and cancelled the run on a denial. A
        // failed approval activates no edge, so nothing after it may start.
        expect(edges(wf)).toEqual(['trigger->a_gate', 'a_gate->z_notes', 'z_notes->deploy', 'deploy->stop']);
        expect(reachableWithout(wf, 'a_gate')).toEqual(['trigger']);
      },
    },
    {
      name: 'spawn_session becomes a session node, and its repository and model go on the checklist',
      steps: [
        {
          id: 'child',
          type: 'tool',
          tool: 'spawn_session',
          arguments: { task: 'Bump deps.', workspace: 'api', title: 'Deps', repoUrl: 'https://github.com/acme/api', branch: 'main', model: 'anthropic/claude-sonnet-4' },
        },
      ],
      check: (wf) => {
        expect(node(wf, 'child')).toEqual({ id: 'child', type: 'session', mode: 'start', prompt: 'Bump deps.', title: 'Deps' });
        expect(wf.checklist).toEqual([
          expect.stringContaining('on https://github.com/acme/api at main'),
          expect.stringContaining('asked for the model "anthropic/claude-sonnet-4"'),
        ]);
      },
    },
    {
      name: 'tools that did nothing or point at V1 become checklist lines and no node',
      steps: [
        { id: 'msg', type: 'tool', tool: 'send_message', arguments: { targetSessionId: 's1', content: 'hi' } },
        { id: 'run', type: 'tool', tool: 'run_workflow', arguments: { workflowId: 'wf_9' } },
        { id: 'ls', type: 'tool', tool: 'list_workflows' },
        { id: 'gh', type: 'tool', tool: 'github_create_issue' },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'stop']);
        expect(wf.checklist).toEqual([
          expect.stringContaining('to V1 session s1'),
          expect.stringContaining('started V1 workflow wf_9'),
          expect.stringContaining('called list_workflows, which only read data'),
          expect.stringContaining('"github_create_issue", which did nothing in V1'),
        ]);
      },
    },
    {
      name: 'agent, loop, subworkflow and unknown steps are listed, not dropped',
      steps: [
        { id: 'think', type: 'agent', goal: 'Plan the week.' },
        { id: 'each', type: 'loop', steps: [{ type: 'agent_message', content: 'x' }] },
        { id: 'sub', type: 'subworkflow' },
        { id: 'odd', type: 'webhook_call' },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'stop']);
        expect(wf.checklist).toEqual([
          expect.stringContaining('unknown type "webhook_call", so V1 refused to run this workflow'),
          expect.stringContaining('("Plan the week.")'),
          expect.stringContaining('the 1 steps inside it'),
          expect.stringContaining('"subworkflow" step'),
        ]);
      },
    },
    {
      name: 'text in {{ }} stays literal text, and the checklist says how to make it a template',
      steps: [{ id: 'greet', type: 'agent_message', content: 'Say hi to {{user}} and {{{raw}}}.' }],
      check: (wf) => {
        expect(prompt(node(wf, 'greet'))).toBe('Say hi to {{user}} and {{{raw}}}.');
        expect(wf.checklist).toEqual([expect.stringContaining('Session node "greet" has text in {{ }}')]);
      },
    },
    {
      name: 'generated and duplicate V1 ids become valid, distinct node ids',
      steps: [
        { type: 'approval', prompt: 'One' },
        { id: 'stop', type: 'approval', prompt: 'Two' },
        { id: 'stop', type: 'approval', prompt: 'Three' },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'step-0', 'stop-2', 'stop-3', 'stop']);
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => c.check(one(c.steps)));
  }
});

describe('convertV1Workflows: workflows and triggers', () => {
  const nightly = {
    id: 'wf_1',
    slug: 'nightly',
    name: 'Nightly triage',
    enabled: true,
    data: { steps: [{ id: 'triage', type: 'agent_message', content: 'Triage.' }] },
  };

  it('attaches schedules and webhooks to their workflow, and keeps orchestrator prompts apart', () => {
    const out = convert({
      workflows: [nightly],
      triggers: [
        { name: 'Every night', enabled: true, workflowId: 'wf_1', config: { type: 'schedule', cron: '0 3 * * *', timezone: 'UTC' } },
        { name: 'Paused', enabled: false, workflowId: 'wf_1', config: { type: 'schedule', cron: '0 4 * * *' } },
        { name: 'Hook', enabled: true, workflowId: 'wf_1', config: { type: 'webhook', path: 'triage', method: 'GET' }, variableMapping: { repo: '$.repo' } },
        { name: 'Run it', enabled: true, workflowId: 'wf_1', config: { type: 'manual' } },
        { name: 'Standup', enabled: true, config: { type: 'schedule', cron: '0 9 * * 1-5', target: 'orchestrator', prompt: 'Post the standup.' } },
        { name: 'Orphan', enabled: true, workflowId: 'wf_gone', workflowName: 'Old sync', config: { type: 'schedule', cron: '* * * * *' } },
      ],
    });
    const wf = out.workflows[0]!;
    expect(wf.name).toBe('Nightly triage');
    expect(wf.schedules).toEqual([{ name: 'Every night', cron: '0 3 * * *', timezone: 'UTC' }]);
    expect(wf.checklist).toEqual([
      expect.stringContaining('"Paused" (0 4 * * *) was turned off'),
      expect.stringContaining('webhook trigger "Hook" (GET triage)'),
    ]);
    expect(wf.checklist[1]).toContain('change its method too');
    expect(wf.checklist[1]).toContain('repo from $.repo');
    expect(out.promptSchedules).toEqual([{ name: 'Standup', cron: '0 9 * * 1-5', prompt: 'Post the standup.' }]);
    expect(out.notes).toEqual([expect.stringContaining('belongs to workflow "Old sync"')]);
  });

  it('reads a raw database row, and does not arm the schedule of a workflow V1 had turned off', () => {
    const row = { id: 'wf_2', name: 'Off', enabled: 0, data: JSON.stringify({ steps: [] }) };
    const trigger = { name: 'Daily', enabled: 1, workflow_id: 'wf_2', config: JSON.stringify({ type: 'schedule', cron: '0 1 * * *' }) };
    const wf = convert([{ workflow: row }, { trigger }]).workflows[0]!;
    expect(wf.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'stop']);
    expect(wf.schedules).toEqual([]);
    expect(wf.checklist).toEqual([expect.stringContaining('The V1 workflow was turned off')]);
  });

  /** One enabled V1 workflow with a nightly schedule, converted. */
  function scheduled(steps: unknown[], cron = '0 2 * * *'): V1ConvertedWorkflow {
    const out = convert({
      workflows: [{ id: 'wf_3', name: 'Cleanup', enabled: true, data: { steps } }],
      triggers: [{ name: 'Nightly', enabled: true, workflowId: 'wf_3', config: { type: 'schedule', cron, timezone: 'UTC' } }],
    });
    return out.workflows[0]!;
  }

  const HELD = 'The import did not create V1 schedule "Nightly" (0 2 * * *, UTC). This workflow does not do exactly what it did in V1';
  const work = { id: 'clean', type: 'agent_message', content: 'Delete stale branches.' };

  it.each([
    ['an unknown step type', [work, { id: 'post', type: 'slack_post' }], 'Step "post" has the unknown type "slack_post", so V1 refused'],
    ['a bad step in a loop the import leaves out', [work, { id: 'each', type: 'loop', steps: [{ id: 'bad', type: 'bash' }] }], 'Step "bad" is a bash step with no command'],
    [
      'a bad step in a branch V1 never took',
      [work, { id: 'c', type: 'conditional', condition: true, then: [], else: [{ id: 'empty', type: 'agent_message' }] }],
      'Step "empty" is an agent message with no text',
    ],
    ['an interrupt that is not true or false', [{ ...work, interrupt: 'yes' }], 'has an "interrupt" that is not true or false'],
    ['a branch that is not a list', [work, { id: 'c', type: 'conditional', condition: { variable: 'a', equals: 'b' }, then: 'x' }], 'Step "c" has a "then" that is not a list'],
  ])('creates no schedule for a workflow V1 refused to run: %s', (_name, steps, refusal) => {
    const wf = scheduled(steps);
    expect(wf.schedules).toEqual([]);
    expect(wf.checklist).toContainEqual(expect.stringContaining(refusal));
    expect(wf.checklist.at(-1)).toContain(HELD);
  });

  it('creates no schedule when a failed command no longer stops the run', () => {
    const wf = scheduled([
      { id: 'test', type: 'bash', command: 'make test' },
      { id: 'ok', type: 'approval', prompt: 'Deploy?' },
      { id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy to prod.', workspace: 'app' } },
    ]);
    expect(wf.schedules).toEqual([]);
    expect(wf.checklist).toEqual([
      expect.stringContaining('Session node "test" runs the shell commands of steps "test". V1 stopped the run when a command failed.'),
      expect.stringContaining(HELD),
    ]);
  });

  it('keeps the schedule of a workflow that does what it did in V1', () => {
    expect(scheduled([work]).schedules).toEqual([{ name: 'Nightly', cron: '0 2 * * *', timezone: 'UTC' }]);
  });

  it('creates no schedule whose cron expression V2 reads differently, and says why', () => {
    const wf = scheduled([work], '0 9 1-7 * 1');
    expect(wf.schedules).toEqual([]);
    expect(wf.checklist).toEqual([
      expect.stringContaining('V1 schedule "Nightly" (0 9 1-7 * 1) does not run at the same times in V2. V1 ran it only on days that match both'),
    ]);
    const out = convert({
      workflows: [nightly],
      triggers: [{ name: 'Standup', enabled: true, config: { type: 'schedule', cron: '0 9 * * MON-FRI', target: 'orchestrator', prompt: 'Post the standup.' } }],
    });
    expect(out.promptSchedules).toEqual([]);
    expect(out.notes).toEqual([expect.stringContaining('V1 and V2 read "MON-FRI" in the day of the week field differently')]);
  });

  it.each([
    ['0 9 * * 1', undefined],
    ['*/15 * * * *', undefined],
    ['0 9 1,15 * *', undefined],
    ['0 9 * * 5-7', undefined],
    ['0-30/10 9 * 1-6/2 *', undefined],
    ['0 9 1-7 * 1', 'match both the day of the month and the day of the week'],
    ['0 9 * * MON', 'read "MON" in the day of the week field'],
    ['0 9 */2 * *', 'read "*/2" in the day of the month field'],
    ['5/15 * * * *', 'read "5/15" in the minute field'],
    ['0 9 * * 8', 'read "8" in the day of the week field'],
    ['0 0 9 * * *', 'V1 read only cron expressions with 5 fields'],
    ['0 9 31 2 *', 'names no date that exists'],
    ['0 9 30-31 2 *', 'names no date that exists'],
    ['0 9 31 2,4 *', 'names no date that exists'],
    ['0 9 30-31 2,4 *', undefined],
    ['0 9 29 2 *', undefined],
    ['0 9 31 1-2 *', undefined],
  ])('v1CronDifference(%j)', (cron, difference) => {
    const found = v1CronDifference(cron);
    if (difference === undefined) expect(found).toBeUndefined();
    else expect(found).toContain(difference);
  });

  it('refuses a value that is neither a workflow nor a trigger, naming the item', () => {
    const result = convertV1Workflows([nightly, { hello: 'world' }]);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('Item 2 of the pasted JSON is neither a V1 workflow nor a V1 trigger')] });
  });

  it('refuses triggers alone, because they name no workflow to create', () => {
    const result = convertV1Workflows({ triggers: [{ name: 'Hook', enabled: true, workflowId: 'wf_1', config: { type: 'webhook', path: 'x' } }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('holds no V1 workflow');
  });

  it('builds the editor message from the checklist', () => {
    const text = v1ChecklistPrompt({ name: 'X', definition: { version: 'dag/v1', nodes: [], edges: [] }, schedules: [], checklist: ['Do A.', 'Do B.'] });
    expect(text).toContain('imported this workflow from V1');
    expect(text.endsWith('- Do A.\n- Do B.')).toBe(true);
  });
});

describe('readV1Paste', () => {
  it('reads two JSON documents pasted one after the other', () => {
    expect(readV1Paste('{"workflows": []}\n\n{"triggers": [{"name": "a}"}]}')).toEqual({
      ok: true,
      value: [{ workflows: [] }, { triggers: [{ name: 'a}' }] }],
    });
  });

  it.each([
    ['', 'holds no JSON'],
    ['{"steps": [}', 'not valid JSON'],
    ['GET /api/workflows\n{"steps": []}', 'outside a JSON object'],
    ['{"steps": [', 'not valid JSON'],
  ])('refuses %j', (text, message) => {
    const result = readV1Paste(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("V1 export details", () => {
  it("reads a trigger type from the row when config has none", () => {
    const result = convertV1Workflows({
      workflows: [{ id: "wf1", name: "Weekly", data: { steps: [{ id: "s1", type: "agent_message", content: "Summarize" }] } }],
      triggers: [{ name: "Monday", workflowId: "wf1", type: "schedule", config: { cron: "0 9 * * 1", timezone: "UTC", target: "workflow" } }],
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    const [wf] = result.value.workflows;
    expect(wf?.schedules).toHaveLength(1);
    expect(wf?.checklist.join("\n")).not.toContain("unknown type");
  });

  it("lists one problem once when two V1 rows have it", () => {
    const value = convert({
      workflows: [{ id: "wf1", name: "Digest", enabled: true, data: { steps: [{ id: "s1", type: "agent_message", content: "Go." }] } }],
      triggers: [
        { name: "V1 trigger", workflowId: "wf1", enabled: true, config: { type: "github_event" } },
        { name: "V1 trigger", workflowId: "wf1", enabled: true, config: { type: "github_event" } },
      ],
    });
    expect(value.workflows[0]?.checklist).toEqual(['V1 trigger "V1 trigger" has the unknown type "github_event". The import did not create it.']);
  });

  it("names an empty send_message step as a V1 failure", () => {
    const result = convertV1Workflows({ steps: [{ id: "s1", type: "tool", tool: "send_message", arguments: {} }] });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.workflows[0]?.checklist.join("\n")).toContain("no target session or content, so it failed in V1");
  });
});

