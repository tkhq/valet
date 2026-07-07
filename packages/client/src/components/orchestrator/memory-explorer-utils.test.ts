import { describe, expect, it } from 'vitest';
import {
  extractImportFiles,
  capTags,
  displayTags,
  sortFilesForDisplay,
  resourceHostname,
  resolveMemoryLinkTarget,
  isExpired,
} from './memory-explorer-utils';

describe('extractImportFiles', () => {
  it('extracts files from an export bundle', () => {
    const bundle = {
      version: 1,
      exportedAt: '2026-06-23T00:00:00.000Z',
      count: 2,
      files: [
        { path: 'projects/valet/overview.md', content: '# Valet', pinned: false },
        { path: 'preferences/style.md', content: '# Style', pinned: true },
      ],
    };
    expect(extractImportFiles(bundle)).toEqual([
      { path: 'projects/valet/overview.md', content: '# Valet' },
      { path: 'preferences/style.md', content: '# Style' },
    ]);
  });

  it('accepts a bare array of files', () => {
    const arr = [{ path: 'notes/a.md', content: 'a' }];
    expect(extractImportFiles(arr)).toEqual([{ path: 'notes/a.md', content: 'a' }]);
  });

  it('drops entries with a missing or non-string path', () => {
    const input = {
      files: [
        { path: 'ok.md', content: 'keep' },
        { content: 'no path' },
        { path: 42, content: 'numeric path' },
        { path: '   ', content: 'whitespace path' },
      ],
    };
    expect(extractImportFiles(input)).toEqual([{ path: 'ok.md', content: 'keep' }]);
  });

  it('drops entries whose content is not a string', () => {
    const input = { files: [{ path: 'a.md', content: 123 }, { path: 'b.md' }] };
    expect(extractImportFiles(input)).toEqual([]);
  });

  it('returns an empty array for malformed input', () => {
    expect(extractImportFiles(null)).toEqual([]);
    expect(extractImportFiles({})).toEqual([]);
    expect(extractImportFiles('nope')).toEqual([]);
    expect(extractImportFiles({ files: 'not-an-array' })).toEqual([]);
  });
});

describe('capTags', () => {
  it('returns all tags with no overflow when under the cap', () => {
    expect(capTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], overflow: 0 });
  });

  it('returns all tags with no overflow when exactly at the cap', () => {
    expect(capTags(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c', 'd'], overflow: 0 });
  });

  it('caps at 4 by default and reports the overflow count', () => {
    expect(capTags(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ shown: ['a', 'b', 'c', 'd'], overflow: 2 });
  });

  it('respects a custom max', () => {
    expect(capTags(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], overflow: 1 });
  });

  it('handles an empty tag list', () => {
    expect(capTags([])).toEqual({ shown: [], overflow: 0 });
  });
});

describe('displayTags', () => {
  it('drops tags that duplicate the type badge', () => {
    expect(displayTags(['journal-entry', 'daily'], 'journal-entry')).toEqual({
      shown: ['daily'],
      overflow: 0,
    });
  });

  it('matches type case-insensitively and ignores surrounding whitespace', () => {
    expect(displayTags([' Journal-Entry '], 'journal-entry')).toEqual({ shown: [], overflow: 0 });
  });

  it('keeps all tags when type is empty', () => {
    expect(displayTags(['a', 'b'], '')).toEqual({ shown: ['a', 'b'], overflow: 0 });
  });

  it('caps after deduping', () => {
    expect(displayTags(['note', 'a', 'b', 'c', 'd', 'e'], 'note', 4)).toEqual({
      shown: ['a', 'b', 'c', 'd'],
      overflow: 1,
    });
  });
});

describe('sortFilesForDisplay', () => {
  const file = (path: string, updatedAt: string, pinned = false) => ({ path, updatedAt, pinned });

  it('sorts newest first', () => {
    const files = [
      file('a.md', '2026-01-01T00:00:00.000Z'),
      file('b.md', '2026-03-01T00:00:00.000Z'),
      file('c.md', '2026-02-01T00:00:00.000Z'),
    ];
    expect(sortFilesForDisplay(files).map((f) => f.path)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('puts pinned files first regardless of recency', () => {
    const files = [
      file('new.md', '2026-06-01T00:00:00.000Z'),
      file('pinned-old.md', '2026-01-01T00:00:00.000Z', true),
    ];
    expect(sortFilesForDisplay(files).map((f) => f.path)).toEqual(['pinned-old.md', 'new.md']);
  });

  it('breaks ties by path and treats unparseable dates as oldest', () => {
    const files = [
      file('z.md', 'not-a-date'),
      file('b.md', '2026-01-01T00:00:00.000Z'),
      file('a.md', '2026-01-01T00:00:00.000Z'),
    ];
    expect(sortFilesForDisplay(files).map((f) => f.path)).toEqual(['a.md', 'b.md', 'z.md']);
  });

  it('does not mutate the input array', () => {
    const files = [file('b.md', '2026-01-01T00:00:00.000Z'), file('a.md', '2026-02-01T00:00:00.000Z')];
    const copy = [...files];
    sortFilesForDisplay(files);
    expect(files).toEqual(copy);
  });
});

describe('resourceHostname', () => {
  it('extracts the hostname from an absolute URL', () => {
    expect(resourceHostname('https://docs.example.com/path?query=1')).toBe('docs.example.com');
  });

  it('returns null for an empty string', () => {
    expect(resourceHostname('')).toBeNull();
    expect(resourceHostname('   ')).toBeNull();
  });

  it('returns null for a non-URL string', () => {
    expect(resourceHostname('not a url')).toBeNull();
  });

  it('returns null for a bare relative path', () => {
    expect(resourceHostname('projects/valet/overview.md')).toBeNull();
  });
});

describe('resolveMemoryLinkTarget', () => {
  const from = 'journal/2026-07-03.md';

  it('resolves a root-relative link', () => {
    expect(resolveMemoryLinkTarget(from, '/workflows/dag-v1-schema-gotchas.md')).toBe(
      'workflows/dag-v1-schema-gotchas.md',
    );
  });

  it('resolves a relative link against the source directory', () => {
    expect(resolveMemoryLinkTarget(from, '2026-07-02.md')).toBe('journal/2026-07-02.md');
  });

  it('resolves ../ traversal', () => {
    expect(resolveMemoryLinkTarget(from, '../people/conner.md')).toBe('people/conner.md');
  });

  it('returns null for external and scheme links', () => {
    expect(resolveMemoryLinkTarget(from, 'https://example.com/a.md')).toBeNull();
    expect(resolveMemoryLinkTarget(from, 'mailto:me@example.com')).toBeNull();
  });

  it('returns null for anchor-only links', () => {
    expect(resolveMemoryLinkTarget(from, '#section')).toBeNull();
  });

  it('strips fragments from memory links', () => {
    expect(resolveMemoryLinkTarget(from, '/people/conner.md#projects')).toBe('people/conner.md');
  });

  it('normalizes case, spaces, and invalid characters', () => {
    expect(resolveMemoryLinkTarget(from, '/Projects/My File.md')).toBe('projects/my-file.md');
  });

  it('percent-decodes before resolving', () => {
    expect(resolveMemoryLinkTarget(from, '/projects/a%20b.md')).toBe('projects/a-b.md');
  });
});

describe('isExpired', () => {
  const now = new Date('2026-07-03T00:00:00.000Z');

  it('returns false for null', () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isExpired('', now)).toBe(false);
  });

  it('returns false for an unparseable string', () => {
    expect(isExpired('not-a-date', now)).toBe(false);
  });

  it('returns true for a timestamp in the past', () => {
    expect(isExpired('2026-01-01T00:00:00.000Z', now)).toBe(true);
  });

  it('returns false for a timestamp in the future', () => {
    expect(isExpired('2027-01-01T00:00:00.000Z', now)).toBe(false);
  });
});
