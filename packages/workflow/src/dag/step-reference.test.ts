import { describe, expect, it } from 'vitest';
import { STEP_FIELDS, renderStepReference } from './step-reference.js';
import { ALLOWED_KEYS } from './validate.js';

describe('step reference', () => {
  it('documents exactly the fields the validator accepts, for every step type', () => {
    expect(Object.keys(STEP_FIELDS).sort()).toEqual(Object.keys(ALLOWED_KEYS).sort());
    for (const [type, allowed] of Object.entries(ALLOWED_KEYS)) {
      const documented = Object.keys(STEP_FIELDS[type as keyof typeof STEP_FIELDS]);
      // `id` and `type` are common to every step; the reference states them once.
      expect([...documented].sort(), type).toEqual(allowed.filter((key) => key !== 'id' && key !== 'type').sort());
    }
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
