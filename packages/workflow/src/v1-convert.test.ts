/**
 * The V1 converter. Each case pastes what V1 returned and checks the graph
 * and the checklist. Every definition the converter returns must pass the
 * validator, so `convert` asserts that once for every case.
 */
import { describe, expect, it } from 'vitest';

import { renderTemplate } from './dag/expression.js';
import type { WorkflowNode } from './dag/nodes.js';
import { validateWorkflowDefinition } from './dag/validate.js';
import { convertV1Workflows, readV1Paste, v1ChecklistPrompt, type V1Conversion, type V1ConvertedWorkflow } from './v1-convert.js';

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
      name: 'nested steps listed out of id order are flagged',
      steps: [
        {
          id: 'c',
          type: 'conditional',
          condition: { variable: 'go' },
          then: [
            { id: 'b-second', type: 'approval', prompt: 'B' },
            { id: 'a-first', type: 'approval', prompt: 'A' },
          ],
        },
      ],
      check: (wf) => {
        expect(edges(wf)).toContain('b-second->a-first');
        expect(wf.checklist).toEqual([expect.stringContaining('in id order ("a-first", "b-second")')]);
      },
    },
    {
      name: 'a parallel step fans out and joins',
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
        expect(edges(wf)).toEqual(['trigger->start', 'start->left', 'start->right', 'left->stop', 'right->stop']);
        expect(wf.checklist).toEqual([expect.stringContaining('V2 runs each branch at the same time')]);
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
          expect.stringContaining('("Plan the week.")'),
          expect.stringContaining('the 1 steps inside it'),
          expect.stringContaining('"subworkflow" step'),
          expect.stringContaining('unknown type "webhook_call", so V1 refused to run this workflow'),
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

