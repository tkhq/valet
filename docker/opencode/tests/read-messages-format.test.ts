import { describe, expect, it, vi } from 'vitest';

// The @toon-format/toon runtime dep is only installed inside the sandbox image, so
// stub it here to exercise the pure stripToolResults logic without the package.
vi.mock('@toon-format/toon', () => ({ encode: (data: unknown) => JSON.stringify(data) }));

import { stripToolResults } from '../tools/_format';

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
