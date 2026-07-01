import { describe, it, expect } from 'vitest';
import { validateDefinition } from '../lib/workflow-dag/validator.js';
import { listWorkflowTemplates, getWorkflowTemplate } from './workflow-templates.js';

// llm_maxoutput_warning is a non-blocking advisory; the publish gate filters it too.
function blockingErrors(errs: ReturnType<typeof validateDefinition>) {
  return errs.filter((e) => e.code !== 'llm_maxoutput_warning');
}

describe('workflow templates', () => {
  it('every template has a structurally valid dag/v1 definition', () => {
    for (const t of listWorkflowTemplates()) {
      const errs = blockingErrors(validateDefinition(t.definition));
      expect(errs, `template "${t.id}" invalid: ${errs.map((e) => e.code).join(', ')}`).toEqual([]);
    }
  });

  it('exposes a stable catalog with client-safe input metadata', () => {
    const templates = listWorkflowTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name).toBeTruthy();
      // Each card renders an app-logo chain + human-readable steps.
      expect(t.apps.length).toBeGreaterThan(0);
      expect(t.steps.length).toBeGreaterThan(0);
      for (const input of t.inputs) {
        expect(['string', 'number']).toContain(input.type);
      }
    }
  });

  it('code-review card shows the github → claude → github app chain', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t?.apps).toEqual(['github', 'claude', 'github']);
    expect(t?.steps).toHaveLength(3);
  });

  it('code-review template wires the expected PR-review pipeline', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t).toBeDefined();
    const def = t!.definition;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries(def.nodes.map((n) => [n.id, n as any]));

    expect(byId.trigger.type).toBe('trigger');
    expect(byId.trigger.dataSchema.pullNumber.type).toBe('number');

    // Fetch the PR *with* its diff — the whole point of a code review.
    expect(byId.fetch_pr.action).toBe('github.inspect_pull_request');
    expect(byId.fetch_pr.params.includePatch).toBe(true);

    // The reviewer is an LLM node with an explicit model (publish requires one).
    expect(byId.review.type).toBe('llm');
    expect(typeof byId.review.model).toBe('string');
    expect(byId.review.model.length).toBeGreaterThan(0);
    // References upstream output as `.data` (not the stale `.output`).
    expect(byId.review.prompt).toContain('{{ nodes.fetch_pr.data }}');

    // Post via create_comment, which takes issueNumber (not pullNumber).
    expect(byId.post.action).toBe('github.create_comment');
    expect(byId.post.params.issueNumber).toBe('{{ trigger.data.pullNumber }}');
    // Schema-less LLM output is wrapped as { response }, so the body reads `.response`.
    expect(byId.post.params.body).toBe('{{ nodes.review.data.response }}');

    expect(def.edges).toEqual([
      { from: 'trigger', to: 'fetch_pr' },
      { from: 'fetch_pr', to: 'review' },
      { from: 'review', to: 'post' },
    ]);
  });

  it('code-review webhook maps a native GitHub pull_request payload', () => {
    const t = getWorkflowTemplate('code-review');
    expect(t?.trigger?.variableMapping).toEqual({
      owner: '$.repository.owner.login',
      repo: '$.repository.name',
      pullNumber: '$.pull_request.number',
    });
  });
});
