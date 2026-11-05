import { describe, expect, it } from 'vitest';
import { STEP_FIELDS, oneOf, renderStepReference } from './step-reference.js';
import {
  ALLOWED_KEYS,
  DENY_POLICIES,
  FOREACH_DEFAULT_MAX_ITEMS,
  FOREACH_MAX_CONCURRENCY,
  IF_COMBINATORS,
  ITEM_ERROR_POLICIES,
  LLM_TEMPERATURE_RANGE,
  NODE_ERROR_POLICIES,
  SESSION_MODE,
  STOP_OUTCOMES,
  TOOL_CREDENTIAL_MODES,
  WAIT_MODE,
} from './validate.js';

/** The shape the reference shows for one field of one step type. */
function shapeOf(type: keyof typeof STEP_FIELDS, field: string): string {
  const entry = STEP_FIELDS[type][field];
  if (entry === undefined) throw new Error(`no ${type}.${field} in STEP_FIELDS`);
  return entry.shape;
}

/** Every value of `values`, quoted the way the reference quotes it. */
function quoted(values: Iterable<string>): string[] {
  return [...values].map((value) => `"${value}"`);
}

describe('step reference', () => {
  it('documents exactly the fields the validator accepts, for every step type', () => {
    expect(Object.keys(STEP_FIELDS).sort()).toEqual(Object.keys(ALLOWED_KEYS).sort());
    for (const [type, allowed] of Object.entries(ALLOWED_KEYS)) {
      const documented = Object.keys(STEP_FIELDS[type as keyof typeof STEP_FIELDS]);
      // `id` and `type` are common to every step; the reference states them once.
      expect([...documented].sort(), type).toEqual(allowed.filter((key) => key !== 'id' && key !== 'type').sort());
    }
  });

  // Each field below has a value table or a bound in the validator. The
  // reference must show every value the table holds, so a value added to a
  // table changes the rendered block, and the api skill test fails until the
  // shipped skill is rewritten.
  it.each([
    ['tool', 'credential', TOOL_CREDENTIAL_MODES],
    ['tool', 'onError', NODE_ERROR_POLICIES],
    ['llm', 'onError', NODE_ERROR_POLICIES],
    ['workflow', 'onError', NODE_ERROR_POLICIES],
    ['tool', 'onDeny', DENY_POLICIES],
    ['approval', 'onDeny', DENY_POLICIES],
    ['foreach', 'onItemError', ITEM_ERROR_POLICIES],
    ['if', 'combinator', IF_COMBINATORS],
    ['stop', 'outcome', STOP_OUTCOMES],
  ] as const)('shows every allowed value of %s.%s', (type, field, values) => {
    const shape = shapeOf(type, field);
    for (const value of quoted(values)) expect(shape, `${type}.${field}`).toContain(value);
  });

  it('shows the validator bounds and fixed modes', () => {
    expect(shapeOf('wait', 'mode')).toBe(`"${WAIT_MODE}"`);
    expect(shapeOf('session', 'mode')).toBe(`"${SESSION_MODE}", always`);
    expect(shapeOf('llm', 'temperature')).toBe(`a number from ${LLM_TEMPERATURE_RANGE.min} to ${LLM_TEMPERATURE_RANGE.max}`);
    expect(shapeOf('foreach', 'concurrency')).toBe(`an integer from 1 to ${FOREACH_MAX_CONCURRENCY}`);
    expect(shapeOf('foreach', 'maxItems')).toContain(`more than ${FOREACH_DEFAULT_MAX_ITEMS} entries`);
  });

  it('marks the default and refuses a default the table does not hold', () => {
    expect(oneOf(['fail', 'skip', 'collect'], 'fail')).toBe('"fail" (default), "skip", or "collect"');
    expect(oneOf(['and', 'or'], 'and')).toBe('"and" (default) or "or"');
    expect(() => oneOf(['fail', 'continue'], 'stop')).toThrow('default "stop" is not one of "fail", "continue"');
  });

  it('names the shapes the first drafts got wrong', () => {
    const text = renderStepReference();
    expect(text).toContain('`conditions` (required): array of at least one `{ left, dataType, operation, right? }`');
    expect(text).toContain('`mode` (required): "start", always');
    expect(text).toContain('ONE inline step object, never a list of node ids');
    expect(text).toContain('"success" (default) or "failure"');
    expect(text).toContain('- `string`: `exists`');
  });
});
