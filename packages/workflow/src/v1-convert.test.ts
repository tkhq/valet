/**
 * The V1 converter. Each case pastes what V1 returned and checks the graph
 * and the checklist. Every definition the converter returns must pass the
 * validator, so `convert` asserts that once for every case. Where a case is
 * about what a run does, it runs the definition in the real interpreter.
 */
import { describe, expect, it } from 'vitest';

import { renderTemplate } from './dag/expression.js';
import type { WorkflowNode } from './dag/nodes.js';
import { resolveTriggerInput, triggerDataSchema } from './dag/trigger-input.js';
import { validateWorkflowDefinition } from './dag/validate.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { driveUntilPark } from './interpreter.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import {
  convertV1Workflows,
  readV1Paste,
  v1ChecklistPrompt,
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

/** Session nodes finish at once; other engine calls fail the test. */
const engine: WorkflowEngineDeps = {
  createSession: async (opts) => ({ id: opts.id }),
  prompt: async () => ({ threadId: 'thread', queueItemId: 'queue' }),
  awaitResult: async () => ({ queueItemId: 'queue', outcome: 'completed' as const, text: 'done' }),
  abort: async () => {},
  isSettled: async () => true,
  llmComplete: async () => {
    throw new Error('the V1 import makes no llm node');
  },
  promptOrchestrator: async () => {
    throw new Error('the V1 import makes no orchestrator node');
  },
  invokeAction: async () => {
    throw new Error('the V1 import makes no tool node');
  },
};

/**
 * Runs the workflow in the real interpreter. Each approval node gets its
 * answer from `answers`. `data` reaches the run as written, as a webhook
 * payload does: no trigger input schema checks it. Returns the run outcome
 * and the status of each node that has a checkpoint.
 */
async function runInV2(
  wf: V1ConvertedWorkflow,
  answers: Record<string, boolean>,
  data: Record<string, unknown> = {},
  deps: WorkflowEngineDeps = engine,
): Promise<{ outcome: string | undefined; status: Record<string, string> }> {
  const store = new InMemoryWorkflowStore();
  const input = { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data, metadata: {} };
  await store.createRun('run', { workflowId: 'wf', definitionVersionId: 'v1', input }, wf.definition, 'v1');
  for (let drive = 0; drive < 20; drive++) {
    const claim = await store.claimRun('run', `owner-${drive}`, 30_000);
    if (!claim) throw new Error('could not claim the run');
    const park = await driveUntilPark('run', claim.attempt, { store, engine: deps, clock: () => 1_000 });
    if (park.status === 'settled') {
      const checkpoints = await store.getCheckpoints('run');
      return { outcome: park.outcome, status: Object.fromEntries(checkpoints.map((cp) => [cp.nodeId, cp.status])) };
    }
    for (const wait of park.waitingOn) {
      if (wait.kind !== 'signal') continue;
      const approved = answers[wait.nodeId];
      if (approved === undefined) throw new Error(`no answer for approval node ${wait.nodeId}`);
      await store.insertSignal({
        runId: 'run',
        signalId: `${wait.signalType}:answer`,
        signalType: wait.signalType,
        payload: { approved, resolvedBy: 'tester' },
        createdAt: 1_000,
      });
    }
  }
  throw new Error('the run did not settle');
}

/** A parallel step with an approval, then a deploy after it. */
const RELEASE = [
  {
    id: 'release',
    type: 'parallel',
    steps: [
      { id: 'z_notes', type: 'agent_message', content: 'Write release notes.' },
      { id: 'a_gate', type: 'approval', prompt: 'Ship it?' },
    ],
  },
  { id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy to prod.', workspace: 'app' } },
];

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
      name: 'consecutive messages and commands that V1 waited for share one session node, in order',
      steps: [
        { id: 'pull', type: 'bash', command: 'git pull', cwd: '/workspace/app' },
        { id: 'fix', type: 'agent_message', message: 'Fix the failing test.', await_response: true },
        { id: 'push', type: 'tool', tool: 'bash', arguments: { command: 'git push' } },
      ],
      check: (wf) => {
        expect(wf.definition.nodes.map((n) => n.type)).toEqual(['trigger', 'session', 'stop']);
        expect(node(wf, 'pull')).toMatchObject({ wait: { mode: 'until_idle' } });
        const text = prompt(node(wf, 'pull'));
        expect(text.startsWith('Complete these steps in order.')).toBe(true);
        expect(text.indexOf('git pull')).toBeLessThan(text.indexOf('Fix the failing test.'));
        expect(text.indexOf('Fix the failing test.')).toBeLessThan(text.indexOf('git push'));
        expect(text).toContain('Run it in /workspace/app.');
      },
    },
    {
      name: 'a session node waits only where V1 waited, so a change in waiting starts a new node',
      steps: [
        { id: 'draft', type: 'agent_message', content: 'Draft the notes.' },
        { id: 'review', type: 'agent_message', content: 'Review the draft.', await_response: true },
        { id: 'post', type: 'agent_message', content: 'Post the notes.' },
        { id: 'check', type: 'bash', command: 'make check' },
      ],
      check: (wf) => {
        // V1 waited until the shared session was idle after "review", which covered "draft" too.
        expect(prompt(node(wf, 'draft'))).toContain('Review the draft.');
        expect(node(wf, 'draft')).toMatchObject({ wait: { mode: 'until_idle' } });
        // V1 went on at once after "post", and ran "check" beside the agent's work.
        expect(node(wf, 'post')).toMatchObject({ wait: { mode: 'none' } });
        expect(node(wf, 'check')).toMatchObject({ wait: { mode: 'until_idle' } });
        expect(edges(wf)).toEqual(['trigger->draft', 'draft->post', 'post->check', 'check->stop']);
        expect(wf.checklist).toEqual([
          expect.stringContaining('for the answer to step "review"'),
          expect.stringContaining('Session node "check" runs the shell commands of steps "check".'),
          expect.stringContaining('A session node that does not wait ("post") lets the session nodes after it start before its work is done.'),
        ]);
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
        expect(edges(wf)).toContain('a-first->b-second:true');
        expect(reachableWithout(wf, 'a-first')).not.toContain('b-second');
        expect(wf.checklist).toEqual([
          expect.stringContaining('in id order ("a-first", "b-second"), not in the order listed. The import keeps the V1 order.'),
          expect.stringContaining('Approval node "a-first" is inside step "c".'),
        ]);
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
      name: 'a denial inside a parallel step skips the rest of that step and goes on after it, as in V1',
      steps: RELEASE,
      check: (wf) => {
        // V1 sorted a_gate first. A denial skipped z_notes, and the run went on to deploy.
        expect(edges(wf)).toEqual(['trigger->a_gate', 'a_gate->z_notes:true', 'z_notes->deploy', 'a_gate->deploy:false', 'deploy->stop']);
        expect(node(wf, 'a_gate')).toMatchObject({ onDeny: 'skip' });
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
        expect(node(wf, 'child')).toEqual({
          id: 'child',
          type: 'session',
          mode: 'start',
          prompt: 'Bump deps.',
          title: 'Deps',
          wait: { mode: 'none' },
        });
        expect(wf.checklist).toEqual([
          expect.stringContaining('on https://github.com/acme/api at main'),
          expect.stringContaining('asked for the model "anthropic/claude-sonnet-4"'),
        ]);
      },
    },
    {
      name: 'spawn_session goes on when its session starts, as V1 did, with no checklist line',
      steps: [
        { id: 'a', type: 'tool', tool: 'spawn_session', arguments: { task: 'Fix A.', workspace: 'app' } },
        { id: 'b', type: 'tool', tool: 'spawn_session', arguments: { task: 'Fix B.', workspace: 'app' } },
        { id: 'ok', type: 'approval', prompt: 'Merge?' },
      ],
      check: (wf) => {
        // V1 started both sessions and asked for the approval at once.
        expect(edges(wf)).toEqual(['trigger->a', 'a->b', 'b->ok', 'ok->stop']);
        expect(node(wf, 'a')).toMatchObject({ wait: { mode: 'none' } });
        expect(node(wf, 'b')).toMatchObject({ wait: { mode: 'none' } });
        expect(wf.checklist).toEqual([]);
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

describe('convertV1Workflows: approvals and limits in a V2 run', () => {
  it('goes on after a parallel step when an approval inside it is denied, as V1 did', async () => {
    const wf = one(RELEASE);
    const denied = await runInV2(wf, { a_gate: false });
    expect(denied.outcome).toBe('completed');
    expect(denied.status).toMatchObject({ a_gate: 'completed', z_notes: 'skipped', deploy: 'completed', stop: 'completed' });

    const approved = await runInV2(wf, { a_gate: true });
    expect(approved.status).toMatchObject({ z_notes: 'completed', deploy: 'completed', stop: 'completed' });
  });

  it('goes on after a conditional step when the approval that ends a branch is denied', async () => {
    const wf = one([
      { id: 'c', type: 'conditional', condition: true, then: [{ id: 'gate', type: 'approval', prompt: 'Go?' }] },
      { id: 'after', type: 'agent_message', content: 'Report.' },
    ]);
    expect(edges(wf)).toEqual(['trigger->gate', 'gate->after', 'after->stop']);
    expect((await runInV2(wf, { gate: false })).status).toMatchObject({ gate: 'completed', after: 'completed' });
  });

  it('compares a number condition strictly, as V1 did, when a webhook sends a string', async () => {
    const wf = one([
      {
        id: 'zero',
        type: 'conditional',
        condition: { variable: 'count', equals: 0 },
        then: [{ id: 'none', type: 'agent_message', content: 'Nothing to do.' }],
        else: [{ id: 'some', type: 'agent_message', content: 'Work the queue.' }],
      },
    ]);
    // A number `equals` alone takes all of these as 0.
    for (const count of ['0', '', ' 0 ', '0x0']) {
      expect((await runInV2(wf, {}, { count })).status, JSON.stringify(count)).toMatchObject({ none: 'skipped', some: 'completed' });
    }
    expect((await runInV2(wf, {}, { count: 0 })).status).toMatchObject({ none: 'completed', some: 'skipped' });
    expect(node(wf, 'trigger')).toMatchObject({ dataSchema: { count: { type: 'number' } } });
  });

  it('leaves a variable that V1 compared to a number and to a string off the run form, so V2 takes both', async () => {
    const spawn = (id: string) => ({ id, type: 'tool', tool: 'spawn_session', arguments: { task: `Run ${id}.`, workspace: 'app' } });
    const wf = one([
      { id: 'zero', type: 'conditional', condition: { variable: 'limit', equals: 0 }, then: [spawn('none')] },
      { id: 'every', type: 'conditional', condition: { variable: 'limit', equals: 'all' }, then: [spawn('all')] },
    ]);
    // A number input refused "all" before the run started.
    expect(node(wf, 'trigger')).not.toHaveProperty('dataSchema');
    expect(resolveTriggerInput(triggerDataSchema(wf.definition), { limit: 'all' }).errors).toEqual([]);
    expect(node(wf, 'zero')).toMatchObject({ conditions: [{ operation: 'exists' }, { operation: 'equals', right: 0 }] });
    expect(wf.checklist).toEqual([
      'The if nodes "zero", "every" compare "limit" to values of more than one type (number, string). V1 took a value of any type, so the import does not add "limit" to the run form. To set it in a run you start by hand, add it as a trigger input. A trigger input has one type, so a run then cannot pass a value of another type.',
    ]);
    expect((await runInV2(wf, {}, { limit: 'all' })).status).toMatchObject({ none: 'skipped', all: 'completed' });
    expect((await runInV2(wf, {}, { limit: 0 })).status).toMatchObject({ none: 'completed', all: 'skipped' });
    expect((await runInV2(wf, {}, { limit: '0' })).status).toMatchObject({ none: 'skipped', all: 'skipped' });
  });

  it('goes on at once after an agent message, as V1 did, so its failure does not stop the run', async () => {
    const wf = one([
      { id: 'migrate', type: 'agent_message', content: 'Start the long data migration.' },
      { id: 'ok', type: 'approval', prompt: 'Approve cutover?' },
      { id: 'cutover', type: 'tool', tool: 'spawn_session', arguments: { task: 'Cut over.', workspace: 'app' } },
    ]);
    // V1 sent the message with prompt_async and asked for the approval at once.
    expect(node(wf, 'migrate')).toMatchObject({ type: 'session', wait: { mode: 'none' } });
    expect(edges(wf)).toEqual(['trigger->migrate', 'migrate->ok', 'ok->cutover', 'cutover->stop']);
    expect(wf.checklist).toEqual([]);

    const failing: WorkflowEngineDeps = {
      ...engine,
      awaitResult: async () => ({ queueItemId: 'queue', outcome: 'failed' as const, error: 'The migration failed.' }),
    };
    const run = await runInV2(wf, { ok: true }, {}, failing);
    expect(run.outcome).toBe('completed');
    expect(run.status).toMatchObject({ migrate: 'completed', ok: 'completed', cutover: 'completed', stop: 'completed' });
  });

  it('stops the run when a top-level approval is denied, as V1 cancelled it', async () => {
    const wf = one([
      { id: 'gate', type: 'approval', prompt: 'Deploy?' },
      { id: 'deploy', type: 'agent_message', content: 'Deploy to prod.' },
    ]);
    const denied = await runInV2(wf, { gate: false });
    expect(denied.outcome).toBe('failed');
    expect(denied.status.gate).toBe('failed');
    expect(denied.status.deploy).not.toBe('completed');
  });

  it('gives every approval the 24 hours V1 waited before it cancelled the run', () => {
    const wf = one([{ id: 'top', type: 'approval' }, ...RELEASE]);
    expect(node(wf, 'top')).toEqual({ id: 'top', type: 'approval', prompt: 'Approval required for step top', timeout: '24h' });
    expect(node(wf, 'a_gate')).toMatchObject({ timeout: '24h', onDeny: 'skip' });
    // V1 cancelled the whole run on that timeout, and V2 goes on after the parallel step.
    expect(wf.checklist).toContainEqual(
      expect.stringContaining('Approval node "a_gate" is inside step "release". If the run still waited for it 24 hours after the run started, V1 cancelled the run.'),
    );
  });

  it('says each approval gets its own 24 hours, where V1 cancelled the whole run 24 hours after it started', () => {
    const wf = one([
      { id: 'first', type: 'approval', prompt: 'Stage it?' },
      { id: 'second', type: 'approval', prompt: 'Ship it?' },
      { id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy to prod.', workspace: 'app' } },
    ]);
    expect(wf.checklist).toEqual([
      'V1 cancelled a run that still waited for an approval 24 hours after the run started. This import made 2 approval nodes ("first", "second"), and V2 gives each one its own 24-hour timeout from the time the run reaches it. A run that passes more than one approval can therefore wait longer than V1 allowed. Decide the timeout of each approval node.',
    ]);
    // With one approval, the two timeouts start within the run's first steps.
    expect(one([{ id: 'only', type: 'approval' }]).checklist).toEqual([]);
  });

  const message = (i: number) => ({ id: `s${String(i).padStart(2, '0')}`, type: 'agent_message', content: `Step ${i}.` });
  const messages = (n: number) => Array.from({ length: n }, (_, i) => message(i));
  const branch = (n: number) => ({ id: 'c', type: 'conditional', condition: { variable: 'go' }, then: messages(n).map((m) => ({ ...m, id: `c_${m.id}` })) });

  it.each([
    ['50 steps', messages(50), undefined],
    ['51 steps', messages(51), 51],
    ['48 steps and a conditional step that runs 1', [...messages(48), branch(1)], undefined],
    ['48 steps and a conditional step that runs 2', [...messages(48), branch(2)], 51],
    ['a parallel step with 50 steps in it', [{ id: 'p', type: 'parallel', steps: messages(50) }], 51],
    ['a loop step with 60 steps in it, which V1 never ran', [{ id: 'l', type: 'loop', steps: messages(60) }], undefined],
  ])('counts the steps of %s as V1 did', (_name, steps, reached) => {
    const line = one(steps).checklist.find((l) => l.includes('max_steps_exceeded:50'));
    if (reached === undefined) expect(line).toBeUndefined();
    else expect(line).toContain(`A V1 run of this workflow can reach ${reached} steps.`);
  });
});

describe('convertV1Workflows: workflows and triggers', () => {
  const nightly = {
    id: 'wf_1',
    slug: 'nightly',
    name: 'Nightly triage',
    enabled: true,
    data: { steps: [{ id: 'triage', type: 'agent_message', content: 'Triage.' }] },
  };

  it('creates no schedule, and lists each V1 schedule after the other items', () => {
    const out = convert({
      workflows: [nightly],
      triggers: [
        { name: 'Every night', enabled: true, workflowId: 'wf_1', config: { type: 'schedule', cron: '0 3 * * *', timezone: 'Europe/Berlin' } },
        { name: 'Paused', enabled: false, workflowId: 'wf_1', config: { type: 'schedule', cron: '0 4 * * *' } },
        { name: 'Hook', enabled: true, workflowId: 'wf_1', config: { type: 'webhook', path: 'triage', method: 'GET' }, variableMapping: { repo: '$.repo' } },
        { name: 'Run it', enabled: true, workflowId: 'wf_1', config: { type: 'manual' } },
        { name: 'Weekend', enabled: true, config: { type: 'schedule', cron: '0 9 * * 6-7/7', timezone: 'UTC', target: 'orchestrator', prompt: 'Post the digest.' } },
        { name: 'Orphan', enabled: true, workflowId: 'wf_gone', workflowName: 'Old sync', config: { type: 'schedule', cron: '* * * * *' } },
      ],
    });
    expect(out.workflows).toHaveLength(1);
    const wf = out.workflows[0]!;
    expect(wf.name).toBe('Nightly triage');
    expect(wf).not.toHaveProperty('schedules');
    expect(out).not.toHaveProperty('promptSchedules');
    expect(wf.checklist).toEqual([
      expect.stringContaining('webhook trigger "Hook" (GET triage)'),
      'The import creates no schedules, so it did not create V1 schedule "Every night" (0 3 * * *, Europe/Berlin). Add it in Triggers after you finish the other items in this list. Set its time zone to Europe/Berlin.',
      'V1 schedule "Paused" (0 4 * * *, UTC) was turned off. If you still need it, add it in Triggers after you finish the other items in this list. Set its time zone to UTC. V1 used UTC because the schedule named no time zone.',
    ]);
    expect(wf.checklist[0]).toContain('change its method too');
    expect(wf.checklist[0]).toContain('repo from $.repo');
    expect(out.notes).toEqual([
      'The import creates no schedules, so it did not create V1 schedule "Weekend" (0 9 * * 6-7/7, UTC), which sent the prompt "Post the digest." to the assistant. Add it in Triggers with the same prompt after you finish the checklists of the imported workflows. Set its time zone to UTC.',
      expect.stringContaining('belongs to workflow "Old sync"'),
    ]);
  });

  it('says the conditions no longer read the request fields a V1 manual trigger copied into variables', async () => {
    const out = convert({
      workflows: [
        {
          id: 'wf_4',
          name: 'Deploy',
          enabled: true,
          data: {
            steps: [
              {
                id: 'env',
                type: 'conditional',
                condition: { variable: 'environment', equals: 'prod' },
                then: [{ id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy.', workspace: 'app' } }],
              },
            ],
          },
        },
      ],
      triggers: [{ name: 'Prod only', enabled: true, workflowId: 'wf_4', config: { type: 'manual' }, variableMapping: { environment: '$.target' } }],
    });
    const wf = out.workflows[0]!;
    expect(wf.checklist).toEqual([
      'V1 manual trigger "Prod only" copied request fields into variables (environment from $.target). V2 does not copy them: each condition reads the variable name from the run input, such as trigger.data.environment. Change the callers to send the variable names, or change the conditions to read the request fields.',
    ]);
    // V1 deployed for this request. V2 reads trigger.data.environment and skips the deploy.
    expect((await runInV2(wf, {}, { target: 'prod' })).status).toMatchObject({ deploy: 'skipped' });
  });

  it('says a V1 webhook with no mapping left the condition variables unset, where V2 reads the request body', async () => {
    const spawn = (id: string) => ({ id, type: 'tool', tool: 'spawn_session', arguments: { task: `Run ${id}.`, workspace: 'app' } });
    const out = convert({
      workflows: [
        {
          id: 'wf_5',
          name: 'Issue closed',
          enabled: true,
          data: { steps: [{ id: 'closed', type: 'conditional', condition: { variable: 'action', equals: 'closed' }, then: [spawn('cleanup')], else: [spawn('noop')] }] },
        },
      ],
      triggers: [{ name: 'Issues', enabled: true, workflowId: 'wf_5', config: { type: 'webhook', path: 'issues' } }],
    });
    const wf = out.workflows[0]!;
    expect(wf.checklist).toEqual([
      expect.stringContaining('webhook trigger "Issues" (POST issues)'),
      'V1 webhook trigger "Issues" set only mapped variables from the request, and it has no mapping. V1 left "action" unset, so each condition on it took its false branch. A V2 webhook passes the JSON body as trigger.data, so these conditions read trigger.data.action from the request. Decide whether the conditions must read the request, then change the conditions or the caller.',
    ]);
    // V1 ran "noop" for this request. V2 reads the posted field and runs "cleanup".
    expect((await runInV2(wf, {}, { action: 'closed' })).status).toMatchObject({ cleanup: 'completed', noop: 'skipped' });
  });

  it('requires a decision for a V1 webhook mapping from a field with another name, which V2 does not apply', async () => {
    const out = convert({
      workflows: [
        {
          id: 'wf_6',
          name: 'Deploy hook',
          enabled: true,
          data: {
            steps: [
              {
                id: 'env',
                type: 'conditional',
                condition: { variable: 'environment', equals: 'prod' },
                then: [{ id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy.', workspace: 'app' } }],
              },
            ],
          },
        },
      ],
      triggers: [
        { name: 'Deploys', enabled: true, workflowId: 'wf_6', config: { type: 'webhook', path: 'deploy' }, variableMapping: { environment: '$.target', repo: '$.repo' } },
        { name: 'Nightly', enabled: true, workflowId: 'wf_6', config: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' } },
      ],
    });
    const wf = out.workflows[0]!;
    expect(wf.checklist).toEqual([
      'V1 started this workflow from webhook trigger "Deploys" (POST deploy). Create a webhook for this workflow in Triggers, then change the caller to the new URL. V2 webhooks take POST with a JSON body. V1 copied request fields into variables of the same name (repo from $.repo). V2 reads them from trigger.data the same way.',
      'V1 webhook trigger "Deploys" copied request fields into variables with other names (environment from $.target). A V2 webhook does not copy them: each condition reads the variable name from the JSON body, such as trigger.data.environment. Change the caller to send the variable names, or change the conditions to read the request fields.',
      // A required decision holds the schedule.
      expect.stringContaining('This workflow does not do exactly what it did in V1, so it must not run on a schedule yet.'),
    ]);
    // V1 deployed for this request. V2 reads trigger.data.environment and skips the deploy.
    expect((await runInV2(wf, {}, { target: 'prod' })).status).toMatchObject({ deploy: 'skipped' });
  });

  it('refuses orchestrator schedules alone, and lists them to add by hand', () => {
    const result = convertV1Workflows({
      triggers: [{ name: 'Standup', enabled: true, config: { type: 'schedule', cron: '0 9 * * 1-5', target: 'orchestrator', prompt: 'Post the standup.' } }],
    });
    expect(result).toEqual({
      ok: false,
      errors: [expect.stringContaining('holds no V1 workflow'), expect.stringContaining('did not create V1 schedule "Standup" (0 9 * * 1-5, UTC)')],
    });
  });

  it('reads a raw database row, and says the schedule of a workflow V1 had turned off did not run', () => {
    const row = { id: 'wf_2', name: 'Off', enabled: 0, data: JSON.stringify({ steps: [] }) };
    const trigger = { name: 'Daily', enabled: 1, workflow_id: 'wf_2', config: JSON.stringify({ type: 'schedule', cron: '0 1 * * *' }) };
    const wf = convert([{ workflow: row }, { trigger }]).workflows[0]!;
    expect(wf.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'stop']);
    expect(wf.checklist).toEqual([
      'The V1 workflow was turned off, so V1 schedule "Daily" (0 1 * * *, UTC) did not run. If you still need it, add it in Triggers. Set its time zone to UTC. V1 used UTC because the schedule named no time zone.',
    ]);
  });

  /** One enabled V1 workflow with a nightly schedule, converted. */
  function scheduled(steps: unknown[]): V1ConvertedWorkflow {
    const out = convert({
      workflows: [{ id: 'wf_3', name: 'Cleanup', enabled: true, data: { steps } }],
      triggers: [{ name: 'Nightly', enabled: true, workflowId: 'wf_3', config: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' } }],
    });
    return out.workflows[0]!;
  }

  const HELD =
    'The import creates no schedules, so it did not create V1 schedule "Nightly" (0 2 * * *, UTC). This workflow does not do exactly what it did in V1, so it must not run on a schedule yet.';
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
  ])('says the schedule must wait for a workflow V1 refused to run: %s', (_name, steps, refusal) => {
    const wf = scheduled(steps);
    expect(wf.checklist).toContainEqual(expect.stringContaining(refusal));
    expect(wf.checklist.at(-1)).toContain(HELD);
  });

  it('says the schedule must wait when a failed command no longer stops the run', () => {
    const wf = scheduled([
      { id: 'test', type: 'bash', command: 'make test' },
      { id: 'ok', type: 'approval', prompt: 'Deploy?' },
      { id: 'deploy', type: 'tool', tool: 'spawn_session', arguments: { task: 'Deploy to prod.', workspace: 'app' } },
    ]);
    expect(wf.checklist).toEqual([
      expect.stringContaining('Session node "test" runs the shell commands of steps "test". V1 stopped the run when a command failed.'),
      `${HELD} Add it in Triggers after you finish the other items in this list. Set its time zone to UTC.`,
    ]);
  });

  it.each([
    ['its await_timeout_ms', { await_response: true, await_timeout_ms: 300_000 }, '5 minutes'],
    ['2 minutes when the step set no limit', { awaitResponse: true }, '2 minutes'],
    ['15 minutes, the most V1 allowed', { await_response: true, await_timeout_ms: 3_600_000 }, '15 minutes'],
  ])('says the schedule must wait when V1 waited for an answer only up to %s', (_name, fields, limit) => {
    const wf = scheduled([{ ...work, ...fields }]);
    // dag/v1 has no session wait.timeout, so the limit becomes a decision.
    expect(node(wf, 'clean')).toMatchObject({ wait: { mode: 'until_idle' } });
    expect(wf.checklist).toEqual([
      `V1 waited up to ${limit} for the answer to step "clean", and failed the run when the agent took longer. Session node "clean" waits with no time limit, because V2 has no time limit for a session node. Decide whether the run can wait longer than it did in V1.`,
      `${HELD} Add it in Triggers after you finish the other items in this list. Set its time zone to UTC.`,
    ]);
  });

  it('lists the schedule of a workflow that does what it did in V1', () => {
    expect(scheduled([work]).checklist).toEqual([
      'The import creates no schedules, so it did not create V1 schedule "Nightly" (0 2 * * *, UTC). Add it in Triggers. Set its time zone to UTC.',
    ]);
  });

  it('names UTC for a V1 schedule with no time zone, because V1 ran it in UTC', () => {
    const out = convert({
      workflows: [nightly],
      triggers: [
        { name: 'Early', enabled: true, workflowId: 'wf_1', config: { type: 'schedule', cron: '0 6 * * *' } },
        { name: 'Digest', enabled: true, config: { type: 'schedule', cron: '0 7 * * *', target: 'orchestrator', prompt: 'Post the digest.' } },
      ],
    });
    const utc = 'Set its time zone to UTC. V1 used UTC because the schedule named no time zone.';
    expect(out.workflows[0]!.checklist).toEqual([
      `The import creates no schedules, so it did not create V1 schedule "Early" (0 6 * * *, UTC). Add it in Triggers. ${utc}`,
    ]);
    expect(out.notes).toEqual([expect.stringMatching(/V1 schedule "Digest" \(0 7 \* \* \*, UTC\).*Set its time zone to UTC\. V1 used UTC/)]);
  });

  it('says not to copy a cron expression that V2 reads differently, and what V1 did with it', () => {
    const schedule = (name: string, cron: string) => ({ name, enabled: true, workflowId: 'wf_1', config: { type: 'schedule', cron, timezone: 'UTC' } });
    const out = convert({
      workflows: [nightly],
      triggers: [
        // V1: the first Monday of the month. cron-parser: days 1 to 7 and every Monday.
        schedule('First Monday', '0 9 1-7 * 1'),
        schedule('Mondays', '0 9 * * MON'),
        schedule('Odd', '0 9 5/15 * *'),
        { name: 'Every other day', enabled: true, config: { type: 'schedule', cron: '0 9 */2 * *', target: 'orchestrator', prompt: 'Check.' } },
      ],
    });
    const [firstMonday, mondays, odd] = out.workflows[0]!.checklist;
    const decide = 'Do not add the expression as written. Decide when the schedule must run, and write an expression for those times.';
    expect(firstMonday).toBe(
      `The import creates no schedules, so it did not create V1 schedule "First Monday" (0 9 1-7 * 1, UTC). V2 reads its cron expression differently from V1. V1 ran it only on a day that matched both the day of the month and the day of the week. V2 runs it on a day that matches either one. ${decide} Add it in Triggers. Set its time zone to UTC.`,
    );
    expect(mondays).toContain('V1 read only numbers, so it never matched "MON". V1 never ran this schedule.');
    expect(mondays).toContain(decide);
    expect(odd).toContain('V1 and V2 read "5/15" differently.');
    expect(out.notes[0]).toContain('In the day of the month, V1 read "*/2" as each value that divides by 2. V2 counts from 1.');
    expect(out.notes[0]).toContain(decide);
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
    const text = v1ChecklistPrompt({ name: 'X', definition: { version: 'dag/v1', nodes: [], edges: [] }, checklist: ['Do A.', 'Do B.'] });
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
    expect(wf?.checklist).toEqual([expect.stringContaining('V1 schedule "Monday" (0 9 * * 1, UTC). Add it in Triggers.')]);
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

