/**
 * The pre-run audit: which fields hold templates, and what they resolve to
 * against the context the node is about to render with.
 */
import { describe, expect, it } from 'vitest';

import type { TemplateContext } from './expression.js';
import { auditNodeTemplates, collectNodeTemplateSources } from './node-templates.js';
import type { WorkflowNode } from './nodes.js';

const ctx: TemplateContext = {
  trigger: { type: 'manual', timestamp: 't', data: { email: 'a@b.com' }, metadata: {} },
  // An llm node's result — `text`, never `response` (`llm.ts` `LlmResult`).
  nodes: { draft: { result: { text: 'hello' } } },
};

describe('collectNodeTemplateSources', () => {
  it('names every string leaf of a JSON field by its path', () => {
    const node: WorkflowNode = {
      id: 'file',
      type: 'tool',
      service: 'github',
      action: 'create_issue',
      params: { title: '{{trigger.data.email}}', labels: ['bug', '{{nodes.draft.result.response}}'], count: 3 },
    };
    expect(collectNodeTemplateSources(node).map((s) => s.field)).toEqual([
      'params.title',
      'params.labels[1]',
    ]);
  });

  it('marks an if condition as an expression that strict mode does not enforce', () => {
    const node: WorkflowNode = {
      id: 'gate',
      type: 'if',
      conditions: [{ left: 'trigger.data.email', dataType: 'string', operation: 'isNotEmpty' }],
    };
    const [source] = collectNodeTemplateSources(node);
    expect(source?.field).toBe('conditions[0].left');
    expect(source?.syntax).toBe('expression');
    expect(source?.enforceable).toBe(false);
  });

  it('takes a foreach node items expression and leaves its body alone', () => {
    const node: WorkflowNode = {
      id: 'loop',
      type: 'foreach',
      items: '{{trigger.data.rows}}',
      body: { id: 'row', type: 'set', values: { name: '{{item.name}}' } },
    };
    expect(collectNodeTemplateSources(node).map((s) => s.field)).toEqual(['items']);
  });

  it('ignores a JSON field that holds no strings', () => {
    // The runtime input is author- or LLM-written JSON, so a templated
    // field can hold anything. A number carries no template.
    const node: WorkflowNode = { id: 'count', type: 'set', values: 7 };
    expect(collectNodeTemplateSources(node)).toEqual([]);
  });
});

describe('auditNodeTemplates', () => {
  it('finds nothing when every path resolves', () => {
    const node: WorkflowNode = {
      id: 'say',
      type: 'llm',
      model: 'm',
      prompt: 'Mail {{trigger.data.email}} about {{nodes.draft.result.text}}',
    };
    expect(auditNodeTemplates(node, ctx)).toEqual([]);
  });

  it('attributes a finding to the field that holds it and suggests the fix', () => {
    const node: WorkflowNode = {
      id: 'say',
      type: 'llm',
      model: 'm',
      prompt: 'Mail {{trigger.email}}',
      system: 'Summarize {{nodes.draft.result.response}}',
    };
    const found = auditNodeTemplates(node, ctx);
    expect(found.map((d) => [d.field, d.path, d.suggestion])).toEqual([
      ['prompt', 'trigger.email', 'trigger.data.email'],
      ['system', 'nodes.draft.result.response', 'nodes.draft.result.text'],
    ]);
    expect(found.every((d) => d.origin === 'field' && d.enforceable)).toBe(true);
  });

  it('reports one finding for a path written twice in the same field', () => {
    const node: WorkflowNode = {
      id: 'say',
      type: 'llm',
      model: 'm',
      prompt: '{{trigger.email}} and again {{trigger.email}}',
    };
    expect(auditNodeTemplates(node, ctx)).toHaveLength(1);
  });

  it('does not report an exists() probe', () => {
    const node: WorkflowNode = {
      id: 'gate',
      type: 'if',
      conditions: [{ left: 'exists(trigger.data.optional)', dataType: 'boolean', operation: 'isTrue' }],
    };
    expect(auditNodeTemplates(node, ctx)).toEqual([]);
  });

  it('reports an if condition, but not as something strict mode may fail', () => {
    const node: WorkflowNode = {
      id: 'gate',
      type: 'if',
      conditions: [{ left: 'trigger.data.missing', dataType: 'string', operation: 'isNotEmpty' }],
    };
    const found = auditNodeTemplates(node, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.enforceable).toBe(false);
  });

  it('does not report a template that does not parse', () => {
    // A parse error is the validator's finding. Reporting it here too
    // would give the author the same problem twice, in two vocabularies.
    const node: WorkflowNode = { id: 'say', type: 'llm', model: 'm', prompt: '{{trigger.' };
    expect(auditNodeTemplates(node, ctx)).toEqual([]);
  });
});
