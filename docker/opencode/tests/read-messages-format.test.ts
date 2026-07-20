import { describe, expect, it, vi } from 'vitest';

// The @toon-format/toon runtime dep is only installed inside the sandbox image, so
// stub it here to exercise the pure stripToolResults logic without the package.
vi.mock('@toon-format/toon', () => ({ encode: (data: unknown) => JSON.stringify(data) }));

import { paginationHint, stripToolResults } from '../tools/_format';

describe('paginationHint', () => {
  it('points backwards for a default read, where the hidden messages are earlier', () => {
    const hint = paginationHint(50, 'recent');
    expect(hint).toContain('most recent');
    expect(hint).toContain('earlier messages exist');
    expect(hint).toContain("higher 'limit'");
    expect(hint).not.toContain('newer messages exist');
  });

  it('points forwards for a cursor read, where the hidden messages are newer', () => {
    const hint = paginationHint(50, 'after');
    expect(hint).toContain('newer messages exist');
    expect(hint).toContain('paging forward');
    expect(hint).not.toContain('older messages exist');
    expect(hint).not.toContain('earlier messages exist');
  });

  it('tells a size-capped read to move the window rather than raise the limit', () => {
    const hint = paginationHint(12, 'size');
    expect(hint).toContain('size limit');
    expect(hint).toContain("use 'after'");
    // Raising the limit refetches the same page and drops the same messages again.
    expect(hint).not.toContain("higher 'limit' if");
  });
});

describe('stripToolResults', () => {
  it('removes the result payload from tool-call parts but keeps name/args/status', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'done',
        parts: [
          { type: 'text', text: 'the child final answer' },
          {
            type: 'tool-call',
            toolName: 'calendar',
            status: 'complete',
            args: { range: 'week' },
            result: 'a very large calendar dump'.repeat(1000),
          },
        ],
      },
    ];

    const [shaped] = stripToolResults(messages);
    const parts = shaped.parts as Array<Record<string, unknown>>;

    expect(parts[0]).toEqual({ type: 'text', text: 'the child final answer' });
    expect(parts[1]).toEqual({
      type: 'tool-call',
      toolName: 'calendar',
      status: 'complete',
      args: { range: 'week' },
    });
    expect('result' in parts[1]).toBe(false);
  });

  it('passes through messages without parts unchanged', () => {
    const messages = [{ role: 'assistant', content: 'hi', createdAt: 't' }];
    const result = stripToolResults(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result).toEqual(messages);
  });

  it('leaves messages whose parts have no tool results untouched', () => {
    const messages = [
      { role: 'assistant', content: 'hi', parts: [{ type: 'text', text: 'hi' }] },
    ];
    const [shaped] = stripToolResults(messages);
    expect(shaped).toBe(messages[0]);
  });
});
