import { describe, expect, it } from 'vitest';
import { parseToolParams } from '../tools/_params';

describe('call_tool params coercion', () => {
  it('passes a structured object through untouched', () => {
    const result = parseToolParams({ channel: '#eng', text: 'hello' });
    expect(result).toEqual({ ok: true, params: { channel: '#eng', text: 'hello' } });
  });

  it('still accepts a legacy JSON string', () => {
    const result = parseToolParams('{"channel":"#eng","text":"hello"}');
    expect(result).toEqual({ ok: true, params: { channel: '#eng', text: 'hello' } });
  });

  it('carries newlines through the object path without an escaping round-trip', () => {
    const text = 'First paragraph.\n\nSecond line\nthird line';
    const result = parseToolParams({ text });
    expect(result).toEqual({ ok: true, params: { text } });
    if (!result.ok) throw new Error('expected params to parse');
    expect(result.params.text).not.toContain('\\n');
  });

  it('preserves the newlines a correctly escaped legacy string encodes', () => {
    const result = parseToolParams(JSON.stringify({ text: 'a\nb' }));
    if (!result.ok) throw new Error('expected params to parse');
    expect(result.params.text).toBe('a\nb');
  });

  it('accepts nested objects and arrays as values', () => {
    const params = { blocks: [{ type: 'section' }], meta: { retries: 2 } };
    expect(parseToolParams(params)).toEqual({ ok: true, params });
  });

  it('treats a missing or blank value as no parameters', () => {
    expect(parseToolParams(undefined)).toEqual({ ok: true, params: {} });
    expect(parseToolParams(null)).toEqual({ ok: true, params: {} });
    expect(parseToolParams('')).toEqual({ ok: true, params: {} });
    expect(parseToolParams('   ')).toEqual({ ok: true, params: {} });
  });

  it('rejects a string that is not valid JSON', () => {
    const result = parseToolParams('{not json');
    expect(result.ok).toBe(false);
  });

  it('rejects values that are not JSON objects', () => {
    expect(parseToolParams('[1,2]').ok).toBe(false);
    expect(parseToolParams('42').ok).toBe(false);
    expect(parseToolParams(['a']).ok).toBe(false);
    expect(parseToolParams(7).ok).toBe(false);
  });
});
