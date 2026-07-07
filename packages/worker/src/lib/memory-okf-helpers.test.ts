import { describe, it, expect } from 'vitest';
import {
  normalizeResource,
  extractLinks,
  renderIndex,
  deriveFtsDescription,
  tagsToFtsText,
  TRACKED_PARAMS,
} from './memory-okf-helpers.js';

// ---------------------------------------------------------------------------
// normalizeResource
// ---------------------------------------------------------------------------

describe('normalizeResource', () => {
  it('lowercases scheme and host, upgrades http→https, strips .git and trailing slash', () => {
    expect(normalizeResource('HTTP://GitHub.com/tkhq/Valet.git/')).toBe('https://github.com/tkhq/Valet');
  });

  it('retains ?v= param (not in tracked list)', () => {
    expect(normalizeResource('https://youtube.com/watch?v=abc')).toBe('https://youtube.com/watch?v=abc');
  });

  it('strips utm_* and tracked params but keeps non-tracked', () => {
    expect(normalizeResource('https://example.com/p?utm_source=x&fbclid=y&v=1')).toBe('https://example.com/p?v=1');
  });

  it('strips all four explicitly tracked params', () => {
    expect(normalizeResource('https://example.com/?fbclid=a&gclid=b&ref=c&si=d')).toBe('https://example.com');
  });

  it('strips default port 443', () => {
    expect(normalizeResource('https://example.com:443/path')).toBe('https://example.com/path');
  });

  it('strips default port 80 on http (upgraded to https)', () => {
    // http:80 → https (no port)
    expect(normalizeResource('http://example.com:80/path')).toBe('https://example.com/path');
  });

  it('returns non-URL input trimmed as-is', () => {
    expect(normalizeResource('  not a url  ')).toBe('not a url');
    expect(normalizeResource('just-a-string')).toBe('just-a-string');
  });

  it('TRACKED_PARAMS contains exactly the four named params', () => {
    expect(TRACKED_PARAMS).toContain('fbclid');
    expect(TRACKED_PARAMS).toContain('gclid');
    expect(TRACKED_PARAMS).toContain('ref');
    expect(TRACKED_PARAMS).toContain('si');
    expect(TRACKED_PARAMS).toHaveLength(4);
  });

  it('utm_* prefix covers all utm_ variants', () => {
    const url = 'https://example.com/path?utm_source=x&utm_medium=y&utm_campaign=z&keep=1';
    expect(normalizeResource(url)).toBe('https://example.com/path?keep=1');
  });

  it('strips trailing slash from path (not just root)', () => {
    expect(normalizeResource('https://example.com/foo/bar/')).toBe('https://example.com/foo/bar');
  });
});

// ---------------------------------------------------------------------------
// extractLinks
// ---------------------------------------------------------------------------

describe('extractLinks', () => {
  it('finds bundle-relative links starting with /', () => {
    const result = extractLinks('notes/a.md', 'See [Foo](/projects/foo.md) for details.');
    expect(result).toEqual([{ toPath: 'projects/foo.md', context: 'See [Foo](/projects/foo.md) for details.' }]);
  });

  it('resolves relative links against fromPath directory', () => {
    const result = extractLinks('notes/a.md', 'See [Bar](../projects/bar.md).');
    expect(result).toEqual([{ toPath: 'projects/bar.md', context: 'See [Bar](../projects/bar.md).' }]);
  });

  it('ignores links inside fenced code blocks', () => {
    const body = 'Before\n```\n[link](/should-ignore.md)\n```\nAfter';
    const result = extractLinks('notes/a.md', body);
    expect(result).toHaveLength(0);
  });

  it('ignores links inside tilde fenced code blocks', () => {
    const body = '~~~\n[link](/should-ignore.md)\n~~~';
    const result = extractLinks('notes/a.md', body);
    expect(result).toHaveLength(0);
  });

  it('ignores links inside inline code', () => {
    const body = 'Use `[link](/inline-code.md)` here.';
    const result = extractLinks('notes/a.md', body);
    expect(result).toHaveLength(0);
  });

  it('never returns external https:// links', () => {
    const body = 'See [GitHub](https://github.com/tkhq/valet).';
    const result = extractLinks('notes/a.md', body);
    expect(result).toHaveLength(0);
  });

  it('never returns external http:// links', () => {
    const body = 'See [Example](http://example.com/page).';
    const result = extractLinks('notes/a.md', body);
    expect(result).toHaveLength(0);
  });

  it('context is the containing line trimmed to ≤200 chars', () => {
    const longLine = 'x'.repeat(180) + ' [Foo](/foo.md) ' + 'y'.repeat(100);
    const result = extractLinks('a.md', longLine);
    expect(result).toHaveLength(1);
    expect(result[0].context.length).toBeLessThanOrEqual(200);
  });

  it('first occurrence wins for duplicate targets', () => {
    const body = 'First [Foo](/foo.md) mention.\nSecond [Foo](/foo.md) mention.';
    const result = extractLinks('a.md', body);
    expect(result).toHaveLength(1);
    expect(result[0].context).toBe('First [Foo](/foo.md) mention.');
  });

  it('percent-decodes link URLs before path normalization', () => {
    const body = '[My Note](/notes/my%20note.md)';
    const result = extractLinks('a.md', body);
    // After decode: /notes/my note.md → normalizePath → notes/my-note.md
    expect(result).toHaveLength(1);
    expect(result[0].toPath).toBe('notes/my-note.md');
  });

  it('returns multiple distinct links from the same body', () => {
    const body = '[A](/a.md) and [B](/b.md).';
    const result = extractLinks('a.md', body);
    expect(result).toHaveLength(2);
    const paths = result.map(r => r.toPath).sort();
    expect(paths).toEqual(['a.md', 'b.md']);
  });

  it('relative link from nested fromPath resolves correctly', () => {
    // fromPath = 'projects/valet/notes.md', target = '../overview.md'
    // dir = 'projects/valet/', resolved = 'projects/overview.md'
    const result = extractLinks('projects/valet/notes.md', '[Overview](../overview.md)');
    expect(result).toEqual([{ toPath: 'projects/overview.md', context: '[Overview](../overview.md)' }]);
  });

  it('strips fragment from link with path', () => {
    const result = extractLinks('notes/a.md', '[see](/notes/target.md#design)');
    expect(result).toHaveLength(1);
    expect(result[0].toPath).toBe('notes/target.md');
  });

  it('anchor-only links are excluded (no cross-file link)', () => {
    const result = extractLinks('notes/a.md', '[see](#design)');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderIndex
// ---------------------------------------------------------------------------

describe('renderIndex', () => {
  it('root index has okf_version frontmatter', () => {
    const out = renderIndex('', [], [], true);
    expect(out).toContain('---\nokf_version: "0.1"\n---');
  });

  it('non-root index has no frontmatter', () => {
    const out = renderIndex('projects', [], [], false);
    expect(out).not.toContain('okf_version');
    expect(out).not.toContain('---');
  });

  it('renders subdirs as * [name](/name/) entries', () => {
    const out = renderIndex('', ['projects'], [], true);
    expect(out).toContain('* [projects](/projects/)');
  });

  it('nested subdirs display basename but link the full path', () => {
    const out = renderIndex('projects', ['projects/valet'], [], false);
    expect(out).toContain('* [valet](/projects/valet/)');
  });

  it('renders files with description', () => {
    const out = renderIndex('', [], [{ path: 'notes/hello.md', title: 'Hello', description: 'A greeting' }], true);
    expect(out).toContain('* [Hello](/notes/hello.md) - A greeting');
  });

  it('omits description suffix when description is empty', () => {
    const out = renderIndex('', [], [{ path: 'notes/hello.md', title: 'Hello', description: '' }], true);
    expect(out).toContain('* [Hello](/notes/hello.md)');
    expect(out).not.toContain(' - ');
  });

  it('orders entries path-lexicographically', () => {
    const out = renderIndex(
      '',
      ['zebra', 'apple'],
      [
        { path: 'z.md', title: 'Z', description: '' },
        { path: 'a.md', title: 'A', description: '' },
      ],
      true,
    );
    const appleIdx = out.indexOf('[apple]');
    const zebraIdx = out.indexOf('[zebra]');
    const aIdx = out.indexOf('[A]');
    const zIdx = out.indexOf('[Z]');
    expect(appleIdx).toBeLessThan(zebraIdx);
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('empty index (no subdirs or files) with root frontmatter only', () => {
    const out = renderIndex('', [], [], true);
    expect(out).toBe('---\nokf_version: "0.1"\n---\n');
  });
});

// ---------------------------------------------------------------------------
// deriveFtsDescription
// ---------------------------------------------------------------------------

describe('deriveFtsDescription', () => {
  it('returns authored description when non-empty', () => {
    expect(deriveFtsDescription('My description', '# H\n\nFirst para.\n\nSecond.')).toBe('My description');
  });

  it('returns first body paragraph when authored is empty', () => {
    expect(deriveFtsDescription('', '# H\n\nFirst para.\n\nSecond.')).toBe('First para.');
  });

  it('skips H1 heading to find first paragraph', () => {
    expect(deriveFtsDescription('', '# Title\n\nThe paragraph.\n')).toBe('The paragraph.');
  });

  it('returns empty when body has no non-heading paragraphs', () => {
    expect(deriveFtsDescription('', '# Heading only\n')).toBe('');
  });

  it('truncates first paragraph to ≤200 chars', () => {
    const long = 'x'.repeat(300);
    const result = deriveFtsDescription('', long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string for empty authored and empty body', () => {
    expect(deriveFtsDescription('', '')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// tagsToFtsText
// ---------------------------------------------------------------------------

describe('tagsToFtsText', () => {
  it('converts JSON tag array to space-joined string', () => {
    expect(tagsToFtsText('["ci-cd","x"]')).toBe('ci-cd x');
  });

  it('handles empty array', () => {
    expect(tagsToFtsText('[]')).toBe('');
  });

  it('handles invalid JSON gracefully', () => {
    expect(tagsToFtsText('not-json')).toBe('');
  });

  it('handles single tag', () => {
    expect(tagsToFtsText('["solo"]')).toBe('solo');
  });
});
