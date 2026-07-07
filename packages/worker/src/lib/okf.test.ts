import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderConcept, parseConcept, toIso, fromIso, type ConceptMeta, sanitizeBody, applyDisposition, renderBacklinksBlock, renderNoticeBlock, BACKLINKS_SENTINEL, NOTICE_SENTINEL } from './okf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const base: ConceptMeta = {
  type: 'note', title: 'Hello', description: 'A note.', resource: '',
  tags: ['a', 'b'], sensitivity: 'private', origin: 'inferred',
  expires: null, updatedAt: '2026-07-02 10:00:00', extras: {},
};

describe('renderConcept', () => {
  it('is deterministic: same input twice → identical bytes', () => {
    expect(renderConcept(base, 'body\n')).toEqual(renderConcept(base, 'body\n'));
  });
  it('quotes adversarial strings safely', () => {
    const doc = renderConcept({ ...base, title: 'Deploy: staging vs prod', description: 'has "quotes" and #hash' }, 'b\n');
    expect(parseConcept(doc).meta.title).toBe('Deploy: staging vs prod');
  });
  it('omits empty optionals (title, description, resource, empty tags)', () => {
    const doc = renderConcept({ ...base, title: '', description: '', tags: [] }, 'b\n');
    expect(doc).not.toMatch(/^title:/m);
    expect(doc).not.toMatch(/^description:/m);
    expect(doc).not.toMatch(/^tags:/m);
  });
  it('renders timestamp as ISO Z from D1 format', () => {
    expect(renderConcept(base, 'b\n')).toContain('timestamp: "2026-07-02T10:00:00Z"');
  });
  it('never emits duplicate keys even with hostile extras', () => {
    const doc = renderConcept({ ...base, extras: { custom: 'x' } }, 'b\n');
    expect(doc.match(/^type:/gm)?.length).toBe(1);
  });
});

describe('round-trip law (Law 1)', () => {
  it('parseConcept(renderConcept(x)) ≡ x', () => {
    const meta = { ...base, resource: 'https://github.com/tkhq/valet', extras: { foreignKey: 'NO' } };
    const parsed = parseConcept(renderConcept(meta, '# H\n\nBody.\n'));
    expect(parsed.body).toBe('# H\n\nBody.\n');
    expect(parsed.meta.type).toBe('note');
    expect(parsed.meta.title).toBe('Hello');
    expect(parsed.meta.description).toBe('A note.');
    expect(parsed.meta.resource).toBe('https://github.com/tkhq/valet');
    expect(parsed.meta.tags).toEqual(['a', 'b']);
    expect(parsed.meta.sensitivity).toBe('private');
    expect(parsed.meta.origin).toBe('inferred');
    expect(parsed.meta.extras).toEqual({ foreignKey: 'NO' });
  });
  it('round-trips a non-null expires', () => {
    const meta = { ...base, expires: '2026-07-14 00:00:00' };
    const parsed = parseConcept(renderConcept(meta, 'b\n'));
    expect(parsed.meta.expires).toBe('2026-07-14 00:00:00');
  });
  it('preserves YAML-1.1 footgun scalars as written', () => {
    for (const v of ['NO', '1.10', '022', '~', 'y']) {
      const parsed = parseConcept(`---\ntype: note\nweird: ${v}\n---\nb\n`);
      expect(parsed.meta.extras).toEqual({ weird: v });
    }
  });
});

describe('parseConcept tolerance', () => {
  it('no frontmatter → whole input is body, no meta', () => {
    const p = parseConcept('just text\n');
    expect(p.body).toBe('just text\n');
    expect(p.hadFrontmatter).toBe(false);
  });
  it('junk YAML → treated as no frontmatter, never throws', () => {
    expect(() => parseConcept('---\n:{ not yaml\n---\nb\n')).not.toThrow();
  });
  it('body beginning with --- thematic break survives', () => {
    const doc = renderConcept(base, '---\nnot frontmatter\n');
    expect(parseConcept(doc).body).toBe('---\nnot frontmatter\n');
  });
  it('separates embedded valet.* and flags unknown sub-keys', () => {
    const p = parseConcept('---\ntype: note\nvalet:\n  sensitivity: shareable\n  bogus: "1"\n---\nb\n');
    expect(p.rawValet.sensitivity).toBe('shareable');
    expect(p.unknownValetKeys).toEqual(['bogus']);
  });
});

describe('sanitizeBody (Law 2 & 3 support)', () => {
  const block = renderBacklinksBlock([{ fromPath: 'notes/a.md', title: 'A', context: 'see [x](/y.md)' }], 0, '', 0);
  it('write(read(x)) is a no-op: strips frontmatter and a trailing generated block', () => {
    const doc = renderConcept(base, 'Body.\n') + '\n' + block;
    const r = sanitizeBody(doc);
    expect(r.body).toBe('Body.\n');
  });
  it('preserves content appended AFTER a fenced block, with a warning', () => {
    const doc = renderConcept(base, 'Body.\n') + '\n' + block + '\n## New learning\nkept\n';
    const r = sanitizeBody(doc);
    expect(r.body).toContain('## New learning');
    expect(r.body).not.toContain(BACKLINKS_SENTINEL);
    expect(r.warnings.some((w) => w.includes('kept'))).toBe(true);
  });
  it('leaves a sentinel quoted mid-body alone', () => {
    const body = `about the sentinel: \`${BACKLINKS_SENTINEL}\` inline\nmore\n`;
    expect(sanitizeBody(body).body).toBe(body);
  });
  it('strips two consecutive fenced blocks (notice then backlinks) with no warnings', () => {
    const noticeBlock = renderNoticeBlock('expired 2026-06-14');
    const backlinksBlock = renderBacklinksBlock([{ fromPath: 'notes/a.md', title: 'A', context: 'ctx' }], 0, '', 0);
    const doc = renderConcept(base, 'Body.\n') + '\n' + noticeBlock + backlinksBlock;
    const r = sanitizeBody(doc);
    expect(r.body).toBe('Body.\n');
    expect(r.warnings).toEqual([]);
  });
  it('strips two consecutive fenced blocks (backlinks then notice) with no warnings', () => {
    const backlinksBlock = renderBacklinksBlock([{ fromPath: 'notes/a.md', title: 'A', context: 'ctx' }], 0, '', 0);
    const noticeBlock = renderNoticeBlock('expired 2026-06-14');
    const doc = renderConcept(base, 'Body.\n') + '\n' + backlinksBlock + noticeBlock;
    const r = sanitizeBody(doc);
    expect(r.body).toBe('Body.\n');
    expect(r.warnings).toEqual([]);
  });
  it('strips an empty backlinks block cleanly with no warnings', () => {
    const backlinksBlock = renderBacklinksBlock([], 0, '', 0);
    const doc = renderConcept(base, 'Body.\n') + '\n' + backlinksBlock;
    const r = sanitizeBody(doc);
    expect(r.body).toBe('Body.\n');
    expect(r.warnings).toEqual([]);
  });
  it('renderNoticeBlock prefixes text with ⚠ when missing', () => {
    const output = renderNoticeBlock('expired X');
    const r = sanitizeBody(renderConcept(base, 'Body.\n') + '\n' + output);
    expect(r.body).toBe('Body.\n');
    expect(r.warnings).toEqual([]);
  });
});

describe('applyDisposition', () => {
  const existing: ConceptMeta = { ...base, sensitivity: 'private', origin: 'user-stated' };
  it('agent: embedded valet.sensitivity differing from stored → ignored + warning', () => {
    const parsed = parseConcept('---\ntype: note\nvalet:\n  sensitivity: shareable\n---\nb\n');
    const r = applyDisposition({ channel: 'agent', parsed, explicit: {}, existing });
    expect(r.meta.sensitivity).toBeUndefined();
    expect(r.warnings[0]).toMatch(/sensitivity.*param/);
  });
  it('agent: equal-value echo stays silent (round-trip no-op)', () => {
    const parsed = parseConcept(renderConcept(existing, 'b\n'));
    const r = applyDisposition({ channel: 'agent', parsed, explicit: {}, existing });
    expect(r.warnings).toEqual([]);
  });
  it('agent: stale echo (timestamp mismatch) → ALL embedded metadata ignored + warning', () => {
    const parsed = parseConcept(renderConcept({ ...existing, description: 'stale', updatedAt: '2026-01-01 00:00:00' }, 'b\n'));
    const r = applyDisposition({ channel: 'agent', parsed, explicit: {}, existing });
    expect(r.meta.description).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('changed since'))).toBe(true);
  });
  it('agent: explicit params always win', () => {
    const parsed = parseConcept(renderConcept(existing, 'b\n'));
    const r = applyDisposition({ channel: 'agent', parsed, explicit: { sensitivity: 'shareable' }, existing });
    expect(r.meta.sensitivity).toBe('shareable');
  });
  it('agent: fresh echo merges content keys on matching timestamp', () => {
    const parsed = parseConcept(renderConcept({ ...existing, description: 'edited in doc' }, 'b\n'));
    const r = applyDisposition({ channel: 'agent', parsed, explicit: {}, existing });
    expect(r.meta.description).toBe('edited in doc');
  });
  it('foreign import: sensitivity reset, origin forced, unknown valet dropped+reported', () => {
    const parsed = parseConcept('---\ntype: note\nvalet:\n  sensitivity: shareable\n  libraryOrigin: x\n---\nb\n');
    const r = applyDisposition({ channel: 'foreign-import', parsed, explicit: {}, existing: null });
    expect(r.meta.sensitivity).toBe('private');
    expect(r.meta.origin).toBe('imported');
    expect(r.droppedValetKeys).toEqual(['libraryOrigin']);
  });
  it('trusted import: honors valet keys and timestamp', () => {
    const parsed = parseConcept('---\ntype: note\ntimestamp: "2026-05-01T00:00:00Z"\nvalet:\n  sensitivity: shareable\n---\nb\n');
    const r = applyDisposition({ channel: 'trusted-import', parsed, explicit: {}, existing: null });
    expect(r.meta.sensitivity).toBe('shareable');
    expect(r.meta.updatedAt).toBe('2026-05-01 00:00:00');
  });
  it('title: ignored on agent channel, honored on imports', () => {
    const parsed = parseConcept('---\ntype: note\ntitle: "Injected"\n---\nb\n');
    expect(applyDisposition({ channel: 'agent', parsed, explicit: {}, existing }).meta.title).toBeUndefined();
    expect(applyDisposition({ channel: 'foreign-import', parsed, explicit: {}, existing: null }).meta.title).toBe('Injected');
  });
  it('source_session_id never accepted from any channel', () => {
    const parsed = parseConcept('---\ntype: note\nvalet:\n  source_session_id: forged\n---\nb\n');
    for (const channel of ['agent', 'trusted-import', 'foreign-import'] as const) {
      const r = applyDisposition({ channel, parsed, explicit: {}, existing: null });
      expect(JSON.stringify(r.meta)).not.toContain('forged');
    }
  });
});

describe('temporal conversion', () => {
  it('toIso/fromIso invert', () => {
    expect(fromIso(toIso('2026-07-02 10:00:00'))).toBe('2026-07-02 10:00:00');
  });
  it('fromIso tolerates date-only and offsets', () => {
    expect(fromIso('2026-07-02')).toBe('2026-07-02 00:00:00');
    expect(fromIso('2026-07-02T12:00:00+02:00')).toBe('2026-07-02 10:00:00');
  });
});

describe('wire-contract drift guard', () => {
  it('sentinel strings and heading are duplicated byte-identically in docker/opencode/tools/mem_read.ts', () => {
    const memReadPath = path.resolve(__dirname, '../../../../docker/opencode/tools/mem_read.ts');
    const memReadSource = fs.readFileSync(memReadPath, 'utf-8');

    expect(memReadSource).toContain(BACKLINKS_SENTINEL);
    expect(memReadSource).toContain(NOTICE_SENTINEL);
    expect(memReadSource).toContain('# Linked from');
  });
});

describe('golden file (emitter lock)', () => {
  it('matches the frozen rendering exactly', () => {
    const doc = renderConcept({ ...base, resource: 'https://x.test/a', extras: { zz: '1', aa: 'two words' } }, 'Body.\n');
    expect(doc).toBe(
      '---\n' +
      'type: "note"\n' +
      'title: "Hello"\n' +
      'description: "A note."\n' +
      'resource: "https://x.test/a"\n' +
      'tags: ["a", "b"]\n' +
      'timestamp: "2026-07-02T10:00:00Z"\n' +
      'valet:\n' +
      '  sensitivity: "private"\n' +
      '  origin: "inferred"\n' +
      'aa: two words\n' +
      'zz: 1\n' +
      '---\n' +
      'Body.\n'
    );
  });
});
