import { describe, expect, it, vi } from 'vitest';
import { MAX_AGENT_INPUT_FILE_BYTES, MAX_AGENT_INPUT_FILES, renderAgentFiles, validateAgentFiles, validateRenderedAgentFiles } from './agent-files.js';
import { withMissRecorder } from './expression.js';
import { auditNodeTemplates, collectNodeTemplateSources } from './node-templates.js';
import type { WorkflowNode } from './nodes.js';
import type { WorkflowDefinition } from './shape.js';
import { validateWorkflowDefinition } from './validate.js';

function definition(node: WorkflowNode): WorkflowDefinition {
  return { version: 'dag/v1', nodes: [{ id: 't', type: 'trigger' }, node], edges: [{ from: 't', to: node.id }] };
}

const session: WorkflowNode = { id: 's', type: 'session', mode: 'start', prompt: 'Read inputs', files: { 'nested/jobs.json': '{{trigger.data.jobs}}' } };

describe('agent input files', () => {
  it('accepts session, orchestrator, and foreach inputs', () => {
    expect(validateWorkflowDefinition(definition(session))).toEqual({ ok: true });
    expect(validateWorkflowDefinition(definition({ id: 'o', type: 'orchestrator', prompt: 'Read', files: { '.data/a-1_v2.json': '{{trigger.data}}' } }))).toEqual({ ok: true });
    expect(validateWorkflowDefinition(definition({ id: 'f', type: 'foreach', items: '{{trigger.data.rows}}', body: { ...session, files: { 'data.json': '{{item}}', 'index.txt': '{{index}}' } } }))).toEqual({ ok: true });
  });

  it.each(['/a', '../a', 'a/../b', '.', '..', './a', 'a//b', 'a/', '', 'a\\b', 'a\0b', '{{trigger.data.name}}', 'a b', 'é.json', 'a\n', 'a\r', 'a\r\n'])('rejects path %j at save and runtime', (path) => {
    expect(validateWorkflowDefinition(definition({ ...session, files: { [path]: 'data' } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('files path')] });
    expect(() => renderAgentFiles({ [path]: 'data' }, {}, {})).toThrow('files path');
    expect(() => validateRenderedAgentFiles([{ path, content: 'data' }])).toThrow('files path');
  });

  it('rejects duplicate rendered paths', () => {
    expect(() => validateRenderedAgentFiles([{ path: 'a', content: '' }, { path: 'a', content: '' }])).toThrow('duplicated');
  });

  it('rejects excessive files and wrong map/value types', () => {
    const files = Object.fromEntries(Array.from({ length: MAX_AGENT_INPUT_FILES + 1 }, (_, i) => [`${i}.json`, '{}']));
    expect(validateWorkflowDefinition(definition({ ...session, files }))).toMatchObject({ ok: false, errors: [expect.stringContaining('101 entries')] });
    expect(validateAgentFiles([])[0]).toContain('must be an object');
    expect(validateAgentFiles({ 'data.json': {} })[0]).toContain('must be a template string');
  });

  it('rejects files on llm and other unsupported types with a clear correction', () => {
    const llm = { id: 'l', type: 'llm' as const, model: 'm', prompt: 'Hi', files: { 'a': 'b' } };
    expect(validateWorkflowDefinition(definition(llm))).toMatchObject({ ok: false, errors: [expect.stringContaining('only on session and orchestrator')] });
    const tool = { id: 'l', type: 'tool' as const, service: 'demo', action: 'ping', params: {}, files: { 'a': 'b' } };
    expect(validateWorkflowDefinition(definition(tool))).toMatchObject({ ok: false, errors: [expect.stringContaining('only on session and orchestrator')] });
  });

  it('lints template syntax and references and suggests the files field for a typo', () => {
    expect(validateWorkflowDefinition(definition({ ...session, files: { 'a': '{{nodes.missing.result}}' } }))).toMatchObject({ ok: false });
    expect(validateWorkflowDefinition(definition({ ...session, files: { 'a': '{{trigger.data' } }))).toMatchObject({ ok: false });
    const typo = { id: 's', type: 'session' as const, mode: 'start' as const, prompt: 'Read', fiels: {} };
    expect(validateWorkflowDefinition(definition(typo))).toMatchObject({ ok: false, errors: [expect.stringContaining('did you mean "files"')] });
    expect(collectNodeTemplateSources(session).map((s) => s.field)).toContain('files.nested/jobs.json');
    expect(auditNodeTemplates(session, { trigger: { data: {} } })).toMatchObject([{ field: 'files.nested/jobs.json', enforceable: true }]);
  });

  it('writes strings verbatim and typed values as pretty JSON, with aliases', () => {
    const ctx = { item: { jobs: [1, { name: 'héllo' }] }, index: 0, trigger: { data: { escape: '../../outside' } } };
    expect(renderAgentFiles({ 'data.json': '{{item}}', 'index.json': '{{index}}', 'raw.md': 'Notes\n{{item.jobs[1].name}}', 'escape.txt': '{{trigger.data.escape}}' }, ctx, {})).toEqual([
      { path: 'data.json', content: JSON.stringify(ctx.item, null, 2) },
      { path: 'index.json', content: '0' },
      { path: 'raw.md', content: 'Notes\nhéllo' },
      { path: 'escape.txt', content: '../../outside' },
    ]);
  });

  it('keeps existing empty/null behavior and fails strict misses before dispatch', () => {
    expect(renderAgentFiles({ 'a': '{{item.missing}}', 'b': 'x{{item.missing}}' }, { item: {} }, {})).toEqual([{ path: 'a', content: 'null' }, { path: 'b', content: 'x' }]);
    const record = vi.fn();
    const ctx = withMissRecorder({ item: {} }, { record });
    expect(() => renderAgentFiles({ 'a': '{{item.missing}}' }, ctx, { policy: { onUnresolvedPath: 'fail' } })).toThrow('unresolved template paths');
    expect(record).toHaveBeenCalledWith(['item', 'missing'], ctx);
    expect(renderAgentFiles({ 'a': '{{item.present}}' }, { item: { present: null } }, { policy: { onUnresolvedPath: 'fail' } })).toEqual([{ path: 'a', content: 'null' }]);
  });

  it('enforces UTF-8 per-file and aggregate byte caps', () => {
    expect(() => renderAgentFiles({ 'large.txt': 'é'.repeat(MAX_AGENT_INPUT_FILE_BYTES / 2 + 1) }, {}, {})).toThrow(`large.txt\" has ${MAX_AGENT_INPUT_FILE_BYTES + 2} bytes`);
    const tenMiB = 'a'.repeat(MAX_AGENT_INPUT_FILE_BYTES);
    expect(() => validateRenderedAgentFiles([{ path: 'a', content: tenMiB }, { path: 'b', content: tenMiB }, { path: 'c', content: tenMiB }])).toThrow('raises the node total to 31457280 bytes, over the 26214400 byte cap');
    expect(() => validateRenderedAgentFiles([{ path: 'a', content: tenMiB }])).not.toThrow();
  });
});
