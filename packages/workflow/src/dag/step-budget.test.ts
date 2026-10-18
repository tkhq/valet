import { describe, expect, it } from 'vitest';

import type { WorkflowNode } from './nodes.js';
import { DEFAULT_STEP_MODEL_CALLS, stepModelCallLimit, unboundedWorkWarning } from './step-budget.js';
import { validateWorkflowDefinition } from './validate.js';

const session = (prompt: string, extra: Record<string, unknown> = {}): WorkflowNode =>
  ({ id: 'research', type: 'session', mode: 'start', prompt, ...extra }) as WorkflowNode;

describe('step budget', () => {
  it('warns when one agent step handles every item in a list', () => {
    expect(unboundedWorkWarning(session('Deep-read every merged mono and gitops PR from the last 7 days.'))).toContain('foreach');
    expect(unboundedWorkWarning(session('For each open issue, add a label.'))).toContain('stops after 150 model calls');
    expect(unboundedWorkWarning({ id: 'o', type: 'orchestrator', prompt: 'Review all unread messages in #ops.' })).toBeDefined();
  });

  it('does not warn for bounded work or for steps that are not agent steps', () => {
    expect(unboundedWorkWarning(session('Summarize the meeting notes in three bullets.'))).toBeUndefined();
    expect(unboundedWorkWarning({ id: 'l', type: 'llm', model: 'm', prompt: 'Classify every PR.' })).toBeUndefined();
  });

  it('defaults the limit and accepts a step limit up to the maximum', () => {
    expect(stepModelCallLimit({})).toBe(DEFAULT_STEP_MODEL_CALLS);
    expect(stepModelCallLimit({ maxModelCalls: 40 })).toBe(40);
    // A stored value that skipped validation never turns the limit off.
    for (const bad of [0, -1, 2.5, 501]) expect(stepModelCallLimit({ maxModelCalls: bad })).toBe(DEFAULT_STEP_MODEL_CALLS);
    const definition = (maxModelCalls: unknown) => ({
      version: 'dag/v1' as const,
      nodes: [{ id: 'start', type: 'trigger' as const }, session('Do one thing.', { maxModelCalls }), { id: 'stop', type: 'stop' as const }],
      edges: [{ from: 'start', to: 'research' }, { from: 'research', to: 'stop' }],
    });
    expect(validateWorkflowDefinition(definition(200)).ok).toBe(true);
    for (const bad of [0, 501, 2.5, '100']) {
      const result = validateWorkflowDefinition(definition(bad));
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors.join(' ')).toContain('session.maxModelCalls must be an integer from 1 to 500');
    }
  });
});
