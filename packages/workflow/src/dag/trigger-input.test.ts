import { describe, it, expect } from 'vitest';

import { normalizeInputType, resolveTriggerInput, visibleTriggerFields } from './trigger-input.js';
import type { WorkflowInputDefinition } from './shape.js';

/** Deliberately-malformed input definition. `dataSchema` is unchecked stored
 * JSON — a definition authored outside the editor can carry a type string this
 * version doesn't know. Same unknown-then-single-cast seam as
 * validate.test.ts's `rawNode`. */
function rawDef(def: unknown): WorkflowInputDefinition {
  return def as WorkflowInputDefinition;
}

const schema: Record<string, WorkflowInputDefinition> = {
  name: { type: 'string', required: true },
  retries: { type: 'number', default: 3 },
  dryRun: { type: 'boolean', default: false },
  mode: { type: 'string', enum: ['fast', 'safe'], default: 'safe' },
};

describe('normalizeInputType', () => {
  it('collapses "integer" to "number" and keeps every canonical type', () => {
    expect(normalizeInputType('integer')).toBe('number');
    for (const type of ['string', 'number', 'boolean', 'object', 'array'] as const) {
      expect(normalizeInputType(type)).toBe(type);
    }
  });
});

describe('resolveTriggerInput', () => {
  it('merges defaults for omitted fields', () => {
    const result = resolveTriggerInput(schema, { name: 'deploy' });
    expect(result.errors).toEqual([]);
    expect(result.input).toEqual({ name: 'deploy', retries: 3, dryRun: false, mode: 'safe' });
  });

  it('keeps caller values over defaults', () => {
    const result = resolveTriggerInput(schema, { name: 'deploy', retries: 5, mode: 'fast' });
    expect(result.errors).toEqual([]);
    expect(result.input.retries).toBe(5);
    expect(result.input.mode).toBe('fast');
  });

  it('reports a missing required field with the field name and corrective action', () => {
    const result = resolveTriggerInput(schema, {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('name');
    expect(result.errors[0].message).toContain('name');
    expect(result.errors[0].message.toLowerCase()).toContain('provide');
  });

  it('a required field satisfied by its default is not an error', () => {
    const withDefault: Record<string, WorkflowInputDefinition> = {
      env: { type: 'string', required: true, default: 'staging' },
    };
    const result = resolveTriggerInput(withDefault, {});
    expect(result.errors).toEqual([]);
    expect(result.input.env).toBe('staging');
  });

  it('rejects a primitive type mismatch', () => {
    const result = resolveTriggerInput(schema, { name: 'x', retries: 'three' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('retries');
    expect(result.errors[0].message).toContain('number');
  });

  it('rejects a value outside the enum', () => {
    const result = resolveTriggerInput(schema, { name: 'x', mode: 'reckless' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('mode');
    expect(result.errors[0].message).toContain('fast');
  });

  it('checks object and array fields structurally', () => {
    const structural: Record<string, WorkflowInputDefinition> = {
      tags: { type: 'array' },
      config: { type: 'object' },
    };
    const ok = resolveTriggerInput(structural, { tags: ['a'], config: { k: 1 } });
    expect(ok.errors).toEqual([]);
    const bad = resolveTriggerInput(structural, { tags: 'a', config: [1] });
    expect(bad.errors.map((e) => e.field).sort()).toEqual(['config', 'tags']);
  });

  it('passes through fields the schema does not declare', () => {
    const result = resolveTriggerInput(schema, { name: 'x', extra: 'kept' });
    expect(result.errors).toEqual([]);
    expect(result.input.extra).toBe('kept');
  });

  it('an empty or absent schema returns the input unchanged', () => {
    expect(resolveTriggerInput(undefined, { a: 1 })).toEqual({ input: { a: 1 }, errors: [] });
    expect(resolveTriggerInput({}, { a: 1 })).toEqual({ input: { a: 1 }, errors: [] });
  });

  it('an unrecognized type string skips the type check instead of rejecting everything', () => {
    const result = resolveTriggerInput({ weird: rawDef({ type: 'uuid' }) }, { weird: 'x' });
    expect(result.errors).toEqual([]);
    expect(result.input.weird).toBe('x');
  });

  it('"integer" behaves identically to "number"', () => {
    const withInteger: Record<string, WorkflowInputDefinition> = {
      count: { type: 'integer', required: true },
    };
    const ok = resolveTriggerInput(withInteger, { count: 7 });
    expect(ok.errors).toEqual([]);
    // Identical to number on purpose: 7.5 passes, "seven" fails as a number.
    expect(resolveTriggerInput(withInteger, { count: 7.5 }).errors).toEqual([]);
    const bad = resolveTriggerInput(withInteger, { count: 'seven' });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].message).toContain('must be a number');
  });

  it('null is not a valid value for a typed field', () => {
    const result = resolveTriggerInput(schema, { name: null });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('name');
  });
});

describe('visibleTriggerFields', () => {
  it('drops fields marked hidden, and keeps everything else', () => {
    const mixed: Record<string, WorkflowInputDefinition> = {
      repositoryOwner: { type: 'string', required: true },
      payload: { type: 'object', hidden: true },
    };
    expect(visibleTriggerFields(mixed)).toEqual({
      repositoryOwner: { type: 'string', required: true },
    });
  });

  it('reduces an all-hidden schema to empty — the run dialog reads this as "nothing to ask"', () => {
    // github.pull-request-review and github.assign-reviewers, once
    // installed: the only field left on the trigger is the hidden webhook
    // payload. A caller that opens a run dialog on this schema shows one
    // field nobody should ever type into.
    const eventOnly: Record<string, WorkflowInputDefinition> = {
      payload: { type: 'object', hidden: true },
    };
    expect(visibleTriggerFields(eventOnly)).toEqual({});
  });

  it('returns empty for an undefined schema, same as a trigger with no dataSchema at all', () => {
    expect(visibleTriggerFields(undefined)).toEqual({});
  });

  it('keeps a field whose hidden flag is explicitly false, or simply absent', () => {
    const schema: Record<string, WorkflowInputDefinition> = {
      a: { type: 'string', hidden: false },
      b: { type: 'string' },
    };
    expect(visibleTriggerFields(schema)).toEqual(schema);
  });
});
