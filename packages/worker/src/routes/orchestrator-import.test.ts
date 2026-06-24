import { describe, it, expect } from 'vitest';
import { importMemorySchema } from './orchestrator.js';

// Regression: a real export bundle can contain memory files larger than 50k
// (the agent grows them via uncapped append/PATCH writes). The import route
// must not reject the whole bundle on per-file size — that surfaced as a 400
// "Import failed" toast in the UI.
describe('importMemorySchema', () => {
  it('accepts a file whose content exceeds the old 50k cap', () => {
    const big = '#' + 'a'.repeat(60_000);
    const result = importMemorySchema.safeParse({ files: [{ path: 'notes/big.md', content: big }] });
    expect(result.success).toBe(true);
  });

  it('accepts a long path (per-file validation happens in importMemoryFiles, not here)', () => {
    const longPath = 'notes/' + 'x'.repeat(300) + '.md';
    expect(importMemorySchema.safeParse({ files: [{ path: longPath, content: '# x' }] }).success).toBe(true);
  });

  it('accepts a large bundle of files', () => {
    const files = Array.from({ length: 600 }, (_, i) => ({ path: `notes/n-${i}.md`, content: '# x' }));
    expect(importMemorySchema.safeParse({ files }).success).toBe(true);
  });

  it('still rejects an empty bundle', () => {
    expect(importMemorySchema.safeParse({ files: [] }).success).toBe(false);
  });

  it('rejects a non-array files field', () => {
    expect(importMemorySchema.safeParse({ files: 'nope' }).success).toBe(false);
  });

  it('rejects items missing a path or with non-string content', () => {
    expect(importMemorySchema.safeParse({ files: [{ content: 'x' }] }).success).toBe(false);
    expect(importMemorySchema.safeParse({ files: [{ path: '', content: 'x' }] }).success).toBe(false);
    expect(importMemorySchema.safeParse({ files: [{ path: 'a.md', content: 123 }] }).success).toBe(false);
  });
});
