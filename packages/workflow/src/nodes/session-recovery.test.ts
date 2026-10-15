import { expect, it } from 'vitest';
import { Type } from 'typebox';
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from '@valet/engine';
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@valet/engine/test-helpers';
import type { WorkflowEngineDeps, WorkflowInvokeActionRequest } from '../engine-deps.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';

it.each([true, false])('unfinished research uses one repair and posts only validated output (recovery=%s)', async recover => {
  const provider = registerFauxProvider({ provider: `workflow-recovery-${recover}` });
  provider.setResponses([
    fauxAssistantMessage('The report is not yet complete. Source qualification remains unfinished.'),
    ...(recover ? [
      fauxAssistantMessage([fauxToolCall('research_read', {}, { id: 'read-source' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('```json\n{"report":"Verified source report"}\n```'),
    ] : [fauxAssistantMessage('I cannot complete the report because source access is unavailable.')]),
  ]);
  const engineStore = new InMemorySessionStore();
  const runtime = new Engine({ providers: { store: engineStore, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const store = new InMemoryWorkflowStore();
  const prompts: string[] = [];
  const posts: WorkflowInvokeActionRequest[] = [];
  let reads = 0;
  let sessionId: string | undefined;
  const session = (id: string) => {
    const result = runtime.getSession(id);
    if (!result) throw new Error('Test session not created');
    return result;
  };
  const engine: WorkflowEngineDeps = {
    createSession: async opts => {
      const created = await runtime.createSession({ ...opts, userId: 'u', orgId: 'o', workspace: '/', sandbox: {}, model: provider.getModel(),
        tools: [{ name: 'research_read', description: 'Read a source document', parameters: Type.Object({}), execute: async () => {
          reads++;
          return { text: 'Verified source evidence' };
        } }],
      });
      sessionId = created.id;
      return { id: created.id };
    },
    prompt: async (id, text, opts) => {
      prompts.push(text);
      return session(id).thread('research').submitPrompt(text, opts);
    },
    awaitResult: async (id, threadId, queueItemId, opts) => {
      const thread = session(id).threadById(threadId);
      if (!thread) throw new Error('Test thread not created');
      return thread.awaitResult(queueItemId, { ...opts, timeoutMs: 3000 });
    },
    isSettled: async (id, queueItemId) => (await engineStore.getQueueItem(id, queueItemId))?.status === 'settled',
    abort: async (id, threadId, queueItemId) => {
      if (queueItemId) await session(id).threadById(threadId)?.abortSubmission(queueItemId);
      else await session(id).abort({ threadId });
    },
    invokeAction: async request => { posts.push(request); return { ok: true, result: { receipt: 'post-1' } }; },
    llmComplete: async () => { throw new Error('Unexpected llm node'); },
    promptOrchestrator: async () => { throw new Error('Unexpected orchestrator node'); },
  };
  const definition: WorkflowDefinition = {
    version: 'dag/v1',
    nodes: [
      { id: 'start', type: 'trigger' },
      { id: 'research', type: 'session', mode: 'start', prompt: 'Research the source and return the completed report.', outputSchema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] } },
      { id: 'post', type: 'tool', service: 'slack', action: 'post_message', params: { text: '{{nodes.research.result.output.report}}' } },
      { id: 'done', type: 'stop' },
    ],
    edges: [{ from: 'start', to: 'research' }, { from: 'research', to: 'post' }, { from: 'post', to: 'done' }],
  };
  const runId = `recovery-${recover}`;
  const drive = async () => {
    const claim = await store.claimRun(runId, 'test-owner', 30000);
    if (!claim) throw new Error('Cannot claim test run');
    return driveUntilPark(runId, claim.attempt, { store, engine, clock: Date.now });
  };
  const awaitSubmission = async () => {
    const checkpoint = (await store.getCheckpoints(runId)).find(cp => cp.nodeId === 'research');
    const receipt = checkpoint?.effects?.receipt;
    if (!sessionId || !receipt || typeof receipt !== 'object' || !('threadId' in receipt) || typeof receipt.threadId !== 'string' || !('queueItemId' in receipt) || typeof receipt.queueItemId !== 'string') throw new Error('Missing submission receipt');
    await engine.awaitResult(sessionId, receipt.threadId, receipt.queueItemId);
  };
  try {
    await store.createRun(runId, { workflowId: 'wf', definitionVersionId: 'v1' }, definition, 'v1');
    expect(await drive()).toMatchObject({ status: 'parked' });
    await awaitSubmission();
    expect(posts).toHaveLength(0);
    expect(await drive()).toMatchObject({ status: 'parked' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('If work remains incomplete but actionable');
    expect(prompts[1]).toContain('JSON-only applies to your final reply');
    expect(prompts[1]).toContain('Do not repeat actions with side effects');
    await awaitSubmission();
    expect(posts).toHaveLength(0);
    expect(await drive()).toMatchObject({ status: 'settled', outcome: recover ? 'completed' : 'failed' });
    expect(prompts).toHaveLength(2);
    expect(reads).toBe(recover ? 1 : 0);
    expect(posts).toHaveLength(recover ? 1 : 0);
    if (recover) {
      expect(posts[0]?.params).toEqual({ text: 'Verified source report' });
      expect((await store.getCheckpoints(runId)).find(cp => cp.nodeId === 'research')?.result).toMatchObject({ output: { report: 'Verified source report' } });
    }
  } finally {
    if (sessionId) session(sessionId).suspendTimers();
    provider.unregister();
  }
});
