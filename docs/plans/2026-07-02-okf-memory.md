# OKF-Native Orchestrator Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make orchestrator memory a conformant OKF v0.1 bundle: metadata columns + frontmatter-as-projection, a knowledge graph (links, backlinks, derived edges), resource identity, trust-boundaried import/export, and the determinism guarantees GitHub sync will need.

**Architecture:** DB columns are the source of truth; OKF frontmatter is rendered at boundaries by one serialization module (`okf.ts`) and never stored. All derived content (backlinks, notices) travels in sentinel-fenced blocks stripped on write. A `memory_links` table powers the graph; export is a JSON manifest of rendered documents + a `valetState` sidecar for volatile state.

**Tech Stack:** Cloudflare Workers (Hono), D1 + Drizzle + raw FTS5, `yaml` package (document API — required for as-written scalar preservation), Bun runner, OpenCode tools, React 19 client, Vitest.

**Spec:** `docs/specs/2026-07-02-okf-memory-design.md` — read it before starting any task. Where this plan and the spec disagree, the spec wins; update the spec if implementation forces a change (CLAUDE.md rule: spec updates in the same commit).

## Global Constraints

- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety rules). Fix type debt in files you touch.
- No Co-Authored-By trailers in commits. Commit messages: subject ≤72 chars, terse body.
- Three test-enforced laws (spec §Architecture): `parseConcept(renderConcept(x)) ≡ x`; `mem_write(path, mem_read(path).document)` is a no-op; tool responses = document + sentinel-fenced regions only.
- Every change under `docker/` or `packages/runner/` requires bumping `IMAGE_BUILD_VERSION` in `backend/images/base.py` (Task 13).
- **Deploy order for this release: migrations BEFORE worker** (`ENVIRONMENT=<env> make deploy-migrate` first). Old code works against the new FTS table; new code breaks against the old one.
- Client changes gate on `cd packages/client && pnpm build`, not just typecheck.
- Worker tests: `cd packages/worker && npx vitest run <file>`. Whole suite: `pnpm test` from root.
- Temporal storage format is D1's `YYYY-MM-DD HH:MM:SS` UTC everywhere; ISO 8601 `Z` only at render boundaries.

---

### Task 1: Migration 0026 + Drizzle schema + shared types

**Files:**
- Create: `packages/worker/migrations/0026_okf_memory.sql`
- Modify: `packages/worker/src/lib/schema/memory-files.ts`
- Modify: `packages/worker/src/lib/schema/index.ts` (re-export `memoryLinks`)
- Delete: `packages/worker/src/lib/schema/memories.ts` (and its re-export in `schema/index.ts`)
- Modify: `packages/shared/src/types/index.ts:826-895` (MemoryFile & friends)
- Test: `packages/worker/src/lib/db/memory-files-migration.test.ts`

**Interfaces (Produces):**
- `orchestratorMemoryFiles` Drizzle table gains: `type`, `description`, `tags`, `resource`, `extras`, `sensitivity`, `origin`, `sourceSessionId` (`source_session_id`), `expires` (nullable text).
- New Drizzle table `memoryLinks` (`memory_links`): `userId`, `fromPath`, `toPath`, `context`, `createdAt`.
- Shared `MemoryFile` gains: `type: string; description: string; tags: string[]; resource: string; extras: Record<string, string>; sensitivity: 'private' | 'shareable'; origin: '' | 'user-stated' | 'inferred' | 'imported'; sourceSessionId: string; expires: string | null;`
- New shared type: `export interface MemoryLink { fromPath: string; toPath: string; context: string; }`

- [ ] **Step 1: Verify preconditions**

Run: `grep -rn "orchestrator_identities" packages/worker/migrations/ | head -3`
Expected: the table exists (it holds one row per orchestrator-owning user). If it does NOT exist, put `links_indexed_at` on a new single-purpose table `memory_link_index_state (user_id TEXT PRIMARY KEY, links_indexed_at TEXT)` instead — adjust the SQL below accordingly and note it in the spec.

Run: `grep -c "agent_memories" packages/worker/src/ -r`
Expected: only schema definition + barrel export hits (the table is dead). If routes/services reference it, STOP and report.

- [ ] **Step 2: Write the migration**

`packages/worker/migrations/0026_okf_memory.sql`:

```sql
-- OKF-native memory: metadata columns, link graph, FTS rebuild.
-- DEPLOY ORDER: apply this migration BEFORE deploying the new worker.

ALTER TABLE orchestrator_memory_files ADD COLUMN type TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orchestrator_memory_files ADD COLUMN resource TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN extras TEXT NOT NULL DEFAULT '{}';
ALTER TABLE orchestrator_memory_files ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'private';
ALTER TABLE orchestrator_memory_files ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN source_session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN expires TEXT;

ALTER TABLE orchestrator_identities ADD COLUMN links_indexed_at TEXT;

CREATE TABLE memory_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, from_path, to_path)
);
CREATE INDEX idx_memory_links_to ON memory_links(user_id, to_path);

CREATE INDEX idx_memory_files_resource ON orchestrator_memory_files(user_id, resource);

-- Reserved-name amnesty. Plain rename where the target is free; id-suffixed
-- rename for collisions. Inbound body links to renamed paths are NOT rewritten
-- (link machinery doesn't exist yet) — they surface later as phantoms.
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('index.md')) || 'index-notes.md'
WHERE (path = 'index.md' OR path LIKE '%/index.md')
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id
      AND o2.path = substr(orchestrator_memory_files.path, 1, length(orchestrator_memory_files.path) - length('index.md')) || 'index-notes.md');
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('index.md')) || 'index-notes-' || substr(id, 1, 8) || '.md'
WHERE path = 'index.md' OR path LIKE '%/index.md';
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('log.md')) || 'log-notes.md'
WHERE (path = 'log.md' OR path LIKE '%/log.md')
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id
      AND o2.path = substr(orchestrator_memory_files.path, 1, length(orchestrator_memory_files.path) - length('log.md')) || 'log-notes.md');
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('log.md')) || 'log-notes-' || substr(id, 1, 8) || '.md'
WHERE path = 'log.md' OR path LIKE '%/log.md';
UPDATE orchestrator_memory_files SET path = 'imported-' || path
WHERE path LIKE 'lib/%'
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id AND o2.path = 'imported-' || orchestrator_memory_files.path);
UPDATE orchestrator_memory_files
SET path = 'imported-lib/' || substr(id, 1, 8) || '-' || substr(path, 5)
WHERE path LIKE 'lib/%';

-- Type backfill from directory defaults.
UPDATE orchestrator_memory_files SET type = CASE
  WHEN path LIKE 'preferences/%' THEN 'preference'
  WHEN path LIKE 'projects/%'    THEN 'project-note'
  WHEN path LIKE 'workflows/%'   THEN 'workflow'
  WHEN path LIKE 'journal/%'     THEN 'journal-entry'
  WHEN path LIKE 'people/%'      THEN 'person'
  ELSE 'note' END
WHERE type = '';

-- FTS rebuild with new columns. Repopulated from the base table (amnesty
-- renames above are therefore reflected). FTS description/tags derivation for
-- existing rows happens in the link-backfill pass (Task 9), which walks every
-- file anyway; here description indexes the (empty) authored column.
DROP TABLE orchestrator_memory_files_fts;
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path, title, description, tags, content,
  tokenize='porter unicode61'
);
INSERT INTO orchestrator_memory_files_fts(rowid, path, title, description, tags, content)
SELECT rowid, path, title, description,
       (SELECT COALESCE(group_concat(value, ' '), '') FROM json_each(tags)),
       content
FROM orchestrator_memory_files;

-- Legacy dead table. Pre-deploy runbook: verify empty in prod
-- (SELECT COUNT(*) FROM agent_memories) — export to R2 or rename if not.
DROP TABLE agent_memories;
```

- [ ] **Step 3: Update Drizzle schema**

In `packages/worker/src/lib/schema/memory-files.ts`, add to `orchestratorMemoryFiles` after `title`:

```typescript
  type: text().notNull().default(''),
  description: text().notNull().default(''),
  tags: text().notNull().default('[]'),
  resource: text().notNull().default(''),
  extras: text().notNull().default('{}'),
  sensitivity: text().notNull().default('private'),
  origin: text().notNull().default(''),
  sourceSessionId: text('source_session_id').notNull().default(''),
  expires: text(),
```

and add the resource index to the table's index list:

```typescript
  index('idx_memory_files_resource').on(table.userId, table.resource),
```

Append in the same file:

```typescript
export const memoryLinks = sqliteTable('memory_links', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fromPath: text('from_path').notNull(),
  toPath: text('to_path').notNull(),
  context: text().notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.fromPath, table.toPath] }),
  index('idx_memory_links_to').on(table.userId, table.toPath),
]);
```

(import `primaryKey` from `drizzle-orm/sqlite-core`). Add `linksIndexedAt: text('links_indexed_at')` to the `orchestratorIdentities` schema file (find it: `grep -rl "orchestrator_identities" packages/worker/src/lib/schema/`). Delete `schema/memories.ts` and its barrel export.

- [ ] **Step 4: Update shared types**

In `packages/shared/src/types/index.ts`, extend `MemoryFile` (line ~826) with the fields from the Interfaces block above; extend `MemoryFileListing` with `type: string; description: string; tags: string[];`; add `MemoryLink`. Do not change `MemoryFileSearchResult` yet (Task 7 owns it).

- [ ] **Step 5: Write a migration smoke test**

`packages/worker/src/lib/db/memory-files-migration.test.ts` — follow the setup pattern of the existing `memory-files-search.test.ts` (it builds an in-memory DB from migration files). Assert: a row seeded pre-0026 under `projects/x.md` comes out `type = 'project-note'`; a seeded `notes/index.md` row is renamed `notes/index-notes.md`; a seeded `lib/a.md` row is renamed `imported-lib/a.md`; FTS `MATCH` still finds seeded content; `agent_memories` no longer exists (querying it throws).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/worker && npx vitest run src/lib/db/memory-files-migration.test.ts && pnpm typecheck`
Expected: PASS (typecheck may flag consumers of deleted `memories.ts` — remove those imports; they are dead code).

- [ ] **Step 7: Commit** — `feat(memory): add OKF metadata columns, memory_links, FTS rebuild (migration 0026)`

---

### Task 2: `okf.ts` — canonical YAML + render/parse + round-trip law

**Files:**
- Create: `packages/worker/src/lib/okf.ts`
- Create: `packages/worker/src/lib/okf.test.ts`
- Modify: `packages/worker/package.json` (add `"yaml": "^2"`)

**Interfaces (Produces):**

```typescript
export interface ConceptMeta {
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  sensitivity: 'private' | 'shareable';
  origin: string;
  expires: string | null;      // D1 format in, rendered as ISO
  updatedAt: string;           // D1 format in, rendered as ISO `timestamp`
  extras: Record<string, string>; // as-written scalar strings
}
export interface ParsedConcept {
  body: string;
  meta: Partial<ConceptMeta>;            // only keys present in frontmatter
  rawValet: Record<string, string>;      // embedded valet.* sub-keys, as-written
  unknownValetKeys: string[];            // valet.* keys not in the vocabulary
  hadFrontmatter: boolean;
}
export function renderConcept(meta: ConceptMeta, body: string): string;
export function parseConcept(doc: string): ParsedConcept;
export function toIso(d1: string): string;      // 'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SSZ'
export function fromIso(iso: string): string;   // tolerant inverse (date-only, offsets)
export const OKF_VERSION = '0.1';
```

- [ ] **Step 1: Add the `yaml` dependency** — `cd packages/worker && pnpm add yaml` (the document/CST API is required; `js-yaml` cannot preserve as-written scalars).

- [ ] **Step 2: Write failing round-trip + emission tests**

`okf.test.ts` — the load-bearing suite. Include at minimum:

```typescript
import { describe, it, expect } from 'vitest';
import { renderConcept, parseConcept, toIso, fromIso, type ConceptMeta } from './okf.js';

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
    expect(parsed.meta.tags).toEqual(['a', 'b']);
    expect(parsed.meta.extras).toEqual({ foreignKey: 'NO' });
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

describe('temporal conversion', () => {
  it('toIso/fromIso invert', () => {
    expect(fromIso(toIso('2026-07-02 10:00:00'))).toBe('2026-07-02 10:00:00');
  });
  it('fromIso tolerates date-only and offsets', () => {
    expect(fromIso('2026-07-02')).toBe('2026-07-02 00:00:00');
    expect(fromIso('2026-07-02T12:00:00+02:00')).toBe('2026-07-02 10:00:00');
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
```

Run: `npx vitest run src/lib/okf.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `okf.ts`**

Implementation notes (write real code, not a library wrapper):
- **Emit by hand.** The fixed key order, always-double-quoted strings, flow-style tags, and as-written extras make a small hand-rolled emitter *more* reliable than configuring a library: `q(s)` = `JSON.stringify(s)` (double-quoted, escapes newlines/quotes — valid YAML 1.2 double-quoted scalar). Emit order: `type, title, description, resource, tags, timestamp`, then a `valet:` block containing (in order) `sensitivity`, `origin`, `expires` (each only when non-default: sensitivity always, origin when ≠ `''`, expires when non-null), then extras keys sorted, each emitted as `key: <as-written>` verbatim (they were captured as source text — re-emit raw; if a raw value contains a newline, quote it with `q()`).
- **Parse with the `yaml` package document API**: `parseDocument(fmText, { schema: 'core', keepSourceTokens: true })`. Walk the document's contents: for each top-level pair, known keys map to `meta` (coerce via `String(...)` for scalars; tags accepts sequence of scalars); the `valet` map's pairs go to `rawValet` (known sub-keys) / `unknownValetKeys`; everything else lands in `extras` **using the scalar's source text** (`node.srcToken`-derived range or `String(node.value)` fallback when source isn't available — but the footgun test must pass, so source text is mandatory for plain scalars).
- Frontmatter detection: input starts with `---\n`, closing `\n---\n` exists; on parse error or missing close, `hadFrontmatter: false` and whole input is body.
- `toIso`/`fromIso` as specced (UTC both ways; `fromIso` via `new Date(iso)` then format).

Run: `npx vitest run src/lib/okf.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit** — `feat(memory): OKF serialization module with canonical emit + round-trip law`

---

### Task 3: `okf.ts` — sanitizeBody, fenced blocks, disposition + stale-echo

**Files:**
- Modify: `packages/worker/src/lib/okf.ts`
- Modify: `packages/worker/src/lib/okf.test.ts`

**Interfaces (Produces):**

```typescript
export const BACKLINKS_SENTINEL = '<!-- valet:backlinks — auto-generated; anything in this block is not part of the file and is stripped on write -->';
export const NOTICE_SENTINEL = '<!-- valet:notice — auto-generated; not part of the file -->';
export function renderBacklinksBlock(links: Array<{ fromPath: string; title: string; context: string }>, journalCount: number, journalLatest: string, totalMore: number): string;
export function renderNoticeBlock(text: string): string;

export interface SanitizeResult {
  body: string;
  embedded: ParsedConcept | null;   // parsed embedded frontmatter, if any
  warnings: string[];               // '⚠ …' strings for the tool response
}
export function sanitizeBody(input: string): SanitizeResult;

export interface DispositionInput {
  channel: 'agent' | 'trusted-import' | 'foreign-import';
  parsed: ParsedConcept;
  explicit: Partial<ConceptMeta>;        // tool params (agent) or nothing (import)
  existing: ConceptMeta | null;          // current row, null on create
}
export interface DispositionResult {
  meta: Partial<ConceptMeta>;            // fields to write (omissions = unchanged)
  warnings: string[];
  droppedValetKeys: string[];
}
export function applyDisposition(input: DispositionInput): DispositionResult;
```

- [ ] **Step 1: Write failing tests** — add to `okf.test.ts`:

```typescript
import { sanitizeBody, applyDisposition, renderBacklinksBlock, BACKLINKS_SENTINEL } from './okf.js';

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
```

Run: `npx vitest run src/lib/okf.test.ts` — Expected: new tests FAIL.

- [ ] **Step 2: Implement**

- `renderBacklinksBlock`: sentinel line, `# Linked from` heading, `- [Title](/from/path.md) — context` lines (≤10), optional `- Referenced in N journal entries, latest YYYY-MM-DD` line, optional `- …and N more (use mem_links)` line.
- `sanitizeBody`: (1) if input starts with `---\n` and has a closing fence, `parseConcept` it → `embedded`; body = remainder. (2) Scan for sentinel lines at line starts; for each, check the following lines structurally match the generated shape (heading `# Linked from` or a `⚠` notice line, then `- ` list lines); remove exactly the matching region. Content after a removed region is preserved (prepend `⚠ content found after the auto-generated block was kept — it is now part of the file` to warnings when non-whitespace content followed). A sentinel not at a line start, or inside backticks, is untouched (check: line must equal the sentinel exactly).
- `applyDisposition`: implement the spec's table verbatim (spec §Sanitization & Trust Boundaries). Stale-echo: on agent channel with `existing`, compare `parsed.meta.updatedAt` (converted) to `existing.updatedAt`; mismatch ⇒ drop all embedded meta, add warning `⚠ file changed since it was read — embedded metadata ignored; pass metadata as params`. Then layer `explicit` on top unconditionally. Differing embedded system keys (`sensitivity`/`origin`/`expires`/`timestamp` on agent channel) each produce a targeted `⚠ embedded valet.<k> ignored — pass <k> as a param` when their value differs from `existing`.

Run: `npx vitest run src/lib/okf.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit** — `feat(memory): sanitizeBody, fenced blocks, key disposition with stale-echo guard`

---

### Task 4: Pure helpers — normalizeResource, extractLinks, index rendering

**Files:**
- Create: `packages/worker/src/lib/memory-okf-helpers.ts`
- Create: `packages/worker/src/lib/memory-okf-helpers.test.ts`

**Interfaces (Produces):**

```typescript
export function normalizeResource(uri: string): string;
export function extractLinks(fromPath: string, body: string): Array<{ toPath: string; context: string }>;
export function renderIndex(dirPath: string, subdirs: string[], files: Array<{ path: string; title: string; description: string }>, isRoot: boolean): string;
export function deriveFtsDescription(authored: string, body: string): string; // authored, or first body paragraph (≤200 chars)
export function tagsToFtsText(tagsJson: string): string;                      // '["a-b","c"]' -> 'a-b c'
export const TRACKED_PARAMS = ['fbclid', 'gclid', 'ref', 'si'];               // plus utm_* prefix
```

- [ ] **Step 1: Write failing tests** covering, at minimum:
  - `normalizeResource`: `HTTP://GitHub.com/tkhq/Valet.git/` → `https://github.com/tkhq/Valet`; strips `?utm_source=x&fbclid=y` but **retains** `?v=abc` (`youtube.com/watch?v=abc` unchanged); strips `:443`; non-URL input returned trimmed as-is.
  - `extractLinks`: finds `[t](/a/b.md)` (bundle-relative) and `[t](../a/b.md)` (resolved against `fromPath`); ignores links inside fenced code blocks and inline code; external `https://` links never returned; context = the containing line trimmed to ≤200 chars; duplicate targets → first context wins; `%20` in link URLs percent-decoded before normalization.
  - `renderIndex`: subdirs section (`* [projects](/projects/)`), files section with ` - description` omitted when empty; entries path-lexicographic; root gets `---\nokf_version: "0.1"\n---\n` frontmatter, non-root gets none.
  - `deriveFtsDescription('', '# H\n\nFirst para.\n\nSecond.')` → `'First para.'`; authored wins when non-empty.
  - `tagsToFtsText('["ci-cd","x"]')` → `'ci-cd x'`.

Run: `npx vitest run src/lib/memory-okf-helpers.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement.** `normalizeResource` via `new URL()` in try/catch (host+scheme lowercase, https upgrade, strip trailing `/` and `.git` from pathname, delete `utm_*`-prefixed + `TRACKED_PARAMS` params, drop default ports). `extractLinks` via a line scanner tracking fenced-code state, regex `/\[([^\]]*)\]\(([^)\s]+)\)/g` per non-code line, relative resolution with `new URL(target, 'file:///' + fromPath)`-style path math (no URL — plain segment resolution), percent-decode, then reuse the same normalization rules as `normalizePath` (import it once it's exported in Task 5).

Run: `npx vitest run src/lib/memory-okf-helpers.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit** — `feat(memory): resource normalization, link extraction, virtual index rendering`

---

### Task 5: memory-files.ts core rewrite — scope, sync helper, metadata writes

This is the largest task: it converts the write/patch/delete paths to the new model.

**Files:**
- Modify: `packages/worker/src/lib/db/memory-files.ts` (whole-file rework)
- Modify: `packages/worker/src/lib/db/memory-search-helpers.ts` (no change to `extractTitle`; verify export)
- Test: `packages/worker/src/lib/db/memory-files-okf.test.ts` (new), update `memory-files-search.test.ts` fixtures for new columns

**Interfaces (Produces — later tasks depend on these exact signatures):**

```typescript
export interface MemoryScope { userId: string }   // the chokepoint — every helper takes this, not a bare string

export interface MemoryWriteMeta {
  type?: string; description?: string; tags?: string[]; resource?: string;
  sensitivity?: 'private' | 'shareable'; origin?: string; expires?: string; // '' clears where applicable
}
export interface MemoryWriteResult { file: MemoryFile; warnings: string[] }

export function writeMemoryFile(
  rawDb: D1Database, scope: MemoryScope, path: string,
  content: string | undefined,             // undefined ⇒ metadata-only update
  meta: MemoryWriteMeta,
  sourceSessionId: string,                  // '' when unknown; NEVER from caller-supplied documents
  enforceCap?: boolean,
): Promise<MemoryWriteResult>;

export function patchMemoryFile(rawDb: D1Database, scope: MemoryScope, path: string, operations: PatchOperation[], sourceSessionId: string): Promise<PatchResult>; // PatchResult gains warnings: string[]

export function deleteMemoryFile(rawDb: D1Database, scope: MemoryScope, path: string): Promise<{ deleted: number; inboundWarning: string | null }>;
export function deleteMemoryFilesUnderPath(rawDb: D1Database, scope: MemoryScope, pathPrefix: string): Promise<number>;

export function moveMemoryFile(rawDb: D1Database, scope: MemoryScope, from: string, to: string): Promise<MemoryMoveResult>; // Task 6

export function normalizePath(raw: string): string;   // now exported
export function validatePath(path: string): string | null; // depth 5, reserved names, lib/ — with spec's exact messages
export const MAX_MEMORY_PATH_DEPTH = 5;
export const MAX_MEMORY_FILE_SIZE = 262144; // one limit, every channel

// internal but central:
function syncDerivedStores(rawDb, scope, rows: Array<{ rowid; path; title; description; tags; content }>): D1PreparedStatement[];
// returns FTS delete+insert (with deriveFtsDescription/tagsToFtsText applied) and
// memory_links delete+insert statements for the given rows — the ONE owner of
// derived-store maintenance, used by write/patch/delete/import/move/prune paths.
```

- [ ] **Step 1: Write failing tests** (`memory-files-okf.test.ts`) — the behavioral contract:

```typescript
// Using the existing in-memory D1 test harness from memory-files-search.test.ts.
describe('writeMemoryFile v2', () => {
  it('create applies defaults: type from directory, sensitivity private, origin inferred', async () => {
    const { file } = await writeMemoryFile(db, scope, 'projects/valet/notes.md', '# N\n\nBody.', {}, 'thread-1');
    expect(file.type).toBe('project-note');
    expect(file.sensitivity).toBe('private');
    expect(file.origin).toBe('inferred');
    expect(file.sourceSessionId).toBe('thread-1');
  });
  it('stickiness: body-only update leaves metadata unchanged', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'v1', { sensitivity: 'shareable', origin: 'user-stated' }, 't1');
    const { file } = await writeMemoryFile(db, scope, 'notes/a.md', 'v2', {}, 't2');
    expect(file.sensitivity).toBe('shareable');
    expect(file.origin).toBe('user-stated');
  });
  it('metadata-only update: content undefined leaves body, bumps version', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'the body', {}, 't1');
    const { file } = await writeMemoryFile(db, scope, 'notes/a.md', undefined, { tags: ['x'] }, 't1');
    expect(file.content).toBe('the body');
    expect(file.version).toBe(2);
  });
  it('content "" rejected with remediation; create-without-content rejected', async () => {
    await expect(writeMemoryFile(db, scope, 'notes/a.md', '', {}, 't')).rejects.toThrow(/mem_rm/);
    await expect(writeMemoryFile(db, scope, 'notes/new.md', undefined, {}, 't')).rejects.toThrow(/does not exist/);
  });
  it('embedded frontmatter is stripped and disposition applies (agent channel)', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'plain', {}, 't1');
    const doc = '---\ntype: note\nvalet:\n  sensitivity: shareable\n---\nnew body\n';
    const { file, warnings } = await writeMemoryFile(db, scope, 'notes/a.md', doc, {}, 't1');
    expect(file.content).toBe('new body\n');
    expect(file.sensitivity).toBe('private');
    expect(warnings.some((w) => w.includes('sensitivity'))).toBe(true);
  });
  it('reserved names rejected with the spec messages, post-normalization', async () => {
    await expect(writeMemoryFile(db, scope, 'notes/Index.MD', 'x', {}, 't')).rejects.toThrow(/auto-generated/);
    await expect(writeMemoryFile(db, scope, 'lib/x.md', 'x', {}, 't')).rejects.toThrow(/reserved for mounted libraries/);
    await expect(writeMemoryFile(db, scope, 'a/b/c/d/e/f.md', 'x', {}, 't')).rejects.toThrow(/5 levels/);
  });
  it('resource is normalized on write and collision warns', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'x', { resource: 'https://github.com/tkhq/valet.git' }, 't');
    const { warnings } = await writeMemoryFile(db, scope, 'notes/b.md', 'y', { resource: 'https://github.com/tkhq/valet/' }, 't');
    expect(warnings.some((w) => w.includes('notes/a.md'))).toBe(true);
  });
  it('links are extracted into memory_links with line context', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'See [B](/notes/b.md) for detail.\n', {}, 't');
    const links = await rawQuery(`SELECT * FROM memory_links WHERE from_path = 'notes/a.md'`);
    expect(links[0].to_path).toBe('notes/b.md');
    expect(links[0].context).toContain('See [B]');
  });
});

describe('deletion semantics', () => {
  it('mem_rm deletes inbound AND outgoing link rows, returns inbound warning', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'link [b](/notes/b.md)\n', {}, 't');
    await writeMemoryFile(db, scope, 'notes/b.md', 'link [a](/notes/a.md)\n', {}, 't');
    const r = await deleteMemoryFile(db, scope, 'notes/b.md');
    expect(r.inboundWarning).toContain('notes/a.md');
    const remaining = await rawQuery(`SELECT * FROM memory_links WHERE from_path = 'notes/b.md' OR to_path = 'notes/b.md'`);
    expect(remaining.length).toBe(0);
  });
});

describe('Law 2: agent round-trip through the DB layer', () => {
  it('write(renderConcept(read(x)) + backlinks block) changes nothing', async () => {
    await writeMemoryFile(db, scope, 'notes/a.md', 'Body.\n', { description: 'd', tags: ['t'] }, 't1');
    const before = await readMemoryFile(db, scope, 'notes/a.md');
    const doc = renderConcept(fileToConceptMeta(before!), before!.content) + '\n' + renderBacklinksBlock([], 0, '', 0);
    const { file: after } = await writeMemoryFile(db, scope, 'notes/a.md', doc, {}, 't1');
    expect(after.content).toBe(before!.content);
    expect(after.description).toBe('d');
    expect(after.tags).toEqual(['t']);
  });
});
```

(Adapt harness names to the existing test setup. `fileToConceptMeta` is a small exported mapper you add in this task.)

Run: `npx vitest run src/lib/db/memory-files-okf.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement the rework.** Key points against the current code (paths refer to pre-change line numbers):

- `normalizePath` unchanged; **export it**. `validatePath` (line 32): depth ≤ `MAX_MEMORY_PATH_DEPTH` (5); add basename checks (`index.md`, `log.md`) and `lib/` prefix with the spec's exact remediation strings; add `MAX_MEMORY_FILE_SIZE` check where content is present.
- All exported helpers change `userId: string` → `scope: MemoryScope`; internally use `scope.userId`. Update the ~6 existing callers (routes, services) mechanically in this task so typecheck passes — `grep -rn "writeMemoryFile\|readMemoryFile\|listMemoryFiles\|patchMemoryFile\|deleteMemoryFile\|searchMemoryFiles\|exportMemoryFiles\|importMemoryFiles\|boostMemoryFileRelevance\|ensureTodayJournal\|pruneEmptyJournals" packages/worker/src --include="*.ts" -l`.
- `writeMemoryFile` (line 100): signature per Interfaces. Flow: normalize/validate → `sanitizeBody(content)` when content present → `applyDisposition({ channel: 'agent', parsed, explicit: meta, existing })` → resolve final column values (stickiness: undefined = keep existing; create defaults: type from directory table, sensitivity `private`, origin `inferred`) → resource through `normalizeResource` + collision `SELECT path FROM orchestrator_memory_files WHERE user_id=? AND resource=? AND path != ?` → single `rawDb.batch([...])`: upsert row, then `syncDerivedStores` statements. Title: `extractTitle(body, path)` (body-derived, unchanged behavior).
- `syncDerivedStores`: FTS delete-by-rowid-subquery + insert (columns `path,title,description,tags,content`, with `deriveFtsDescription` and `tagsToFtsText` applied JS-side), `DELETE FROM memory_links WHERE user_id=? AND from_path IN (...)`, then chunked `INSERT OR REPLACE INTO memory_links` from `extractLinks` output (≤24 rows/statement).
- `patchMemoryFile` (line 197): ops apply to the **body** (unchanged core). After ops: if the resulting content starts with a parseable frontmatter block, run `sanitizeBody` and merge via disposition (impostor-block prevention). New skip diagnostics: when `replace`/`insert_after` misses, test the needle against `renderConcept(existing)`'s frontmatter region and `BACKLINKS_SENTINEL` block shape; on match, skip with the spec's targeted messages. Patch-created files go through `writeMemoryFile` (line 343 already does) — reserved rules + FTS derivation apply automatically.
- `deleteMemoryFile`/`deleteMemoryFilesUnderPath`/`enforceMemoryCap`/`pruneEmptyJournals`: convert to batches that include `memory_links` cleanup for both directions (`from_path` and `to_path`); `deleteMemoryFile` first queries inbound links for the warning. `pruneEmptyJournals` gains the missing `user_id` scoping (it currently sweeps all users — line 643): take `scope` and filter.
- `enforceMemoryCap`: eviction order becomes `ORDER BY (expires IS NOT NULL AND expires <= datetime('now')) DESC, relevance ASC, last_accessed_at ASC` and keep-signal: exclude files with ≥3 inbound links from the first eviction pass (`AND path NOT IN (SELECT to_path FROM memory_links WHERE user_id = ? GROUP BY to_path HAVING COUNT(*) >= 3)`), falling back to plain order if still over cap.
- `rowToMemoryFile` (line 42): map all new columns (`tags: JSON.parse(row.tags)`, `extras: JSON.parse(row.extras)`).

Run: `npx vitest run src/lib/db/ && pnpm typecheck` — Expected: PASS (search test updates may be needed for new fixture columns — update them).

- [ ] **Step 3: Commit** — `feat(memory): metadata-aware write path, unified derived-store sync, scoped helpers`

---

### Task 6: `moveMemoryFile`

**Files:**
- Modify: `packages/worker/src/lib/db/memory-files.ts`
- Modify: `packages/shared/src/types/index.ts` (add `MemoryMoveResult`)
- Test: extend `memory-files-okf.test.ts`

**Interfaces (Produces):**

```typescript
export interface MemoryMoveResult {
  from: string; to: string;
  pinnedBefore: boolean; pinnedAfter: boolean;
  type: string; typeDefaultForDest: string;   // tool renders the "reclassify" hint when they differ
  referencersUpdated: number; referencersSkipped: string[]; // version-guard losers
}
export function moveMemoryFile(rawDb: D1Database, scope: MemoryScope, from: string, to: string): Promise<MemoryMoveResult>;
```

- [ ] **Step 1: Write failing tests**: move carries all metadata columns + `source_session_id`; destination validated (reserved names rejected); collision at `to` rejected (`already exists`); referencing bodies' links rewritten (`[x](/notes/old.md)` → `[x](/notes/new.md)`) and their `memory_links` rows updated; **churn semantics** — moved file `updated_at` preserved, `version` bumped; referencer `updated_at` NOT bumped, `version` bumped; pin transition reported (`preferences/a.md` → `notes/a.md` yields `pinnedBefore: true, pinnedAfter: false`).

- [ ] **Step 2: Implement.** Read the source row + all referencers (`SELECT m.* FROM orchestrator_memory_files m JOIN memory_links l ON l.from_path = m.path AND l.user_id = m.user_id WHERE l.user_id = ? AND l.to_path = ?`). Compute each referencer's rewritten body (string-replace of the exact link target `(/from)` → `(/to)`, both with and without leading slash forms produced by `extractLinks` normalization). Batch: update moved row (`path`, `pinned` recomputed, `version+1`, `updated_at` untouched — omit from SET), per-referencer `UPDATE ... SET content = ?, version = version + 1 WHERE id = ? AND version = ?` (guard), `memory_links` rewrites (`UPDATE memory_links SET to_path = ? WHERE user_id = ? AND to_path = ?`, and `from_path` likewise for the moved file's outgoing rows), then `syncDerivedStores` for moved + successfully-updated referencers. After the batch, check `meta.changes` per guarded update to fill `referencersSkipped`.

- [ ] **Step 3: Run + commit** — `npx vitest run src/lib/db/memory-files-okf.test.ts` PASS → `feat(memory): mem_move with link rewriting and churn-safe semantics`

---

### Task 7: Search v2

**Files:**
- Modify: `packages/worker/src/lib/db/memory-files.ts` (`searchMemoryFiles`, line ~399)
- Modify: `packages/shared/src/types/index.ts:863` (`MemoryFileSearchResult`)
- Test: update `packages/worker/src/lib/db/memory-files-search.test.ts`

**Interfaces (Produces):**

```typescript
export interface MemoryFileSearchResult {
  path: string; snippet: string; relevance: number;
  title: string; type: string; description: string; tags: string[];
  resource: string; inboundLinks: number; expired: boolean;
}
export interface MemorySearchOptions { pathPrefix?: string; resource?: string; includeExpired?: boolean; limit?: number }
export function searchMemoryFiles(rawDb: D1Database, scope: MemoryScope, query: string, opts?: MemorySearchOptions): Promise<{ results: MemoryFileSearchResult[]; suppressedExpired: number }>;
```

- [ ] **Step 1: Write failing tests**: bm25 call is `bm25(orchestrator_memory_files_fts, 5, 10, 8, 6, 1)`; description matches rank above content matches; `resource` filter exact + segment-aware prefix (`…/valet` matches `…/valet` and `…/valet/issues` but not `…/valet-infra`); expired files excluded by default with `suppressedExpired` count; `includeExpired: true` returns them flagged `expired: true`; result rows carry the new fields; `inboundLinks` counts `memory_links` rows.

- [ ] **Step 2: Implement.** Extend the SELECT (line 416) with `m.title, m.type, m.description, m.tags, m.resource, m.expires`, a lateral inbound count `(SELECT COUNT(*) FROM memory_links l WHERE l.user_id = m.user_id AND l.to_path = m.path) AS inbound`, the 5-weight bm25, `AND (m.expires IS NULL OR m.expires > datetime('now'))` unless `includeExpired`, and when `opts.resource` is set: `AND (m.resource = ? OR m.resource LIKE ? || '/%')` with the normalized value. `suppressedExpired`: when the default filter is active and results < limit, run one COUNT with the filter inverted. Keep the AND→OR fallback (line 438). Expired results (when included) get `relevance` multiplied by 0.1 after scoring so they rank last.

- [ ] **Step 3: Run + commit** — update existing search-test fixtures for the new insert shape; `npx vitest run src/lib/db/memory-files-search.test.ts` PASS → `feat(memory): metadata-aware search with resource filter and expiry exclusion`

---

### Task 8: Export / import v2

**Files:**
- Modify: `packages/worker/src/lib/db/memory-files.ts` (`exportMemoryFiles`, `importMemoryFiles`, `buildImportChunk`)
- Modify: `packages/shared/src/types/index.ts:870-895` (manifest types)
- Test: rewrite `packages/worker/src/lib/db/memory-files-export.test.ts`

**Interfaces (Produces):**

```typescript
export interface MemoryExportEntry { content: string; hash: string; valetState?: { pinned: boolean; relevance: number; version: number; sourceSessionId: string } }
export interface MemoryExportManifest { okfVersion: '0.1'; include: 'all' | 'shareable'; files: Record<string, MemoryExportEntry>; leakFlags: string[] }
export function exportMemoryFiles(db: AppDb, scope: MemoryScope, include: 'all' | 'shareable'): Promise<MemoryExportManifest>;

export interface MemoryImportResult { imported: number; skipped: { path: string; reason: string }[]; pruned: number; renamed: Record<string, string>; droppedValetKeys: string[]; okfVersion: string | null }
export function importMemoryFiles(rawDb: D1Database, scope: MemoryScope, files: Record<string, string> | { path: string; content: string }[], trusted: boolean): Promise<MemoryImportResult>;
```

- [ ] **Step 1: Write failing tests** — the determinism/trust core:
  - `export → import (trusted) → export` on a second in-memory DB yields an **identical manifest** (hashes included; the no-op-skip and timestamp-preservation test).
  - Re-import of the same manifest reports `imported: 0` (all no-ops skipped).
  - Shareable export: private files absent; generated `index.md` entries enumerate **only** shareable files; empty dirs pruned; documents contain **no `valet:` block**; `valetState` absent; a shareable file linking to a private path lands in `leakFlags`.
  - Foreign import (`trusted: false`): `sensitivity` reset, `origin: 'imported'`, `source_session_id: ''`.
  - Path map: importing `{'Projects/My%20Notes.md': doc, 'notes/ref.md': 'see [x](/Projects/My%20Notes.md)'}` stores `projects/my-notes.md` and rewrites the link in `notes/ref.md` to `/projects/my-notes.md`.
  - Collisions after normalization → `skipped`, not last-wins. `lib/a.md` → `imported-lib/a.md` recorded in `renamed`. Foreign `dir/log.md` imports as `dir/log-imported.md` with `type: 'log'`. Root `index.md` frontmatter `okf_version` recorded then skipped; non-root index files skipped silently.
  - Legacy array-form input (old JSON export) imports only when `trusted: true`.

- [ ] **Step 2: Implement.**
- Export: select all columns ordered by path; render each via `renderConcept` (shareable mode passes a meta with `valet:` suppressed — add a `renderConcept(meta, body, { omitValet?: boolean })` option in `okf.ts`); hash via `crypto.subtle.digest('SHA-256', …)` hex; generate `index.md` per directory level from the (filtered) set with `renderIndex`; `leakFlags` from `memory_links` rows whose `to_path` is a private file in the shareable set.
- Import: normalize keys (percent-decode → `normalizePath`), build original→normalized map incl. `lib/` → `imported-lib/` and reserved-log renames; two passes — pass 1 builds the map, pass 2 parses each doc (`parseConcept` + `applyDisposition({ channel: trusted ? 'trusted-import' : 'foreign-import', … })`), rewrites body links through the map, computes the would-be rendering and **skips when identical** to the existing row's rendering; chunked batches via `buildImportChunk` extended to bind all new columns and to use `syncDerivedStores`; the batch-failure per-file replay (current line 583) goes through the new `writeMemoryFile` so derived stores stay consistent.

- [ ] **Step 3: Run + commit** — `npx vitest run src/lib/db/memory-files-export.test.ts` PASS → `feat(memory): OKF bundle export/import with trust modes and no-op skip`

---

### Task 9: Link backfill, expiry sweep, snapshot

**Files:**
- Create: `packages/worker/src/lib/db/memory-link-backfill.ts`
- Modify: `packages/worker/src/lib/memory-snapshot.ts`
- Modify: the cron handler (find it: `grep -rn "scheduled" packages/worker/src/index.ts`) — add expiry sweep
- Modify: `packages/worker/src/services/` orchestrator session-start path (where `loadMemorySnapshot`/`ensureTodayJournal` are called) — add eager backfill
- Test: `packages/worker/src/lib/db/memory-link-backfill.test.ts`

**Interfaces (Produces):**

```typescript
export function ensureLinksIndexed(rawDb: D1Database, scope: MemoryScope): Promise<boolean>; // true if backfill ran
export function sweepExpiredMemories(rawDb: D1Database): Promise<number>;                    // cron; per-user batches
```

- [ ] **Step 1: Failing tests**: `ensureLinksIndexed` walks all files, populates `memory_links`, resyncs FTS (derived descriptions/tags now indexed for legacy rows), sets `orchestrator_identities.links_indexed_at`, and is a no-op on second call; `sweepExpiredMemories` deletes expired rows + their link rows in both directions and never touches unexpired ones.

- [ ] **Step 2: Implement + wire triggers.** `ensureLinksIndexed` checked from: orchestrator session start (eager), graph route, `mem_links` handler, directory read, prune (`enforceMemoryCap` entry), snapshot build, `deleteMemoryFile`. It reads the flag first (one indexed row) — cheap on every call. Snapshot changes in `memory-snapshot.ts`: exclude `expires <= datetime('now')` rows; add pinned files' 1-hop neighbors (via `memory_links` from pinned paths) as a third tier capped at 1600 tokens (20% of 8000), **titles + descriptions only** (`- [type] path — description`), and mark the section `## Related (neighbor files)`.

- [ ] **Step 3: Run + commit** — `feat(memory): lazy link backfill, expiry sweep, neighbor-aware snapshot`

---

### Task 10: Graph query module

**Files:**
- Create: `packages/worker/src/lib/db/memory-graph.ts`
- Test: `packages/worker/src/lib/db/memory-graph.test.ts`

**Interfaces (Produces):**

```typescript
export interface GraphNode { id: string; kind: 'concept' | 'resource' | 'phantom' | 'session' | 'tag'; path?: string; title?: string; type?: string; topDir?: string; label?: string }
export interface GraphEdge { from: string; to: string; kind: 'link' | 'session' | 'resource' | 'containment'; context?: string }
export interface MemoryGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export function buildMemoryGraph(rawDb: D1Database, scope: MemoryScope, opts: { tags?: boolean; containment?: boolean }): Promise<MemoryGraph>;

export interface LinkNeighbor { path: string; title: string; type: string; description: string; context?: string; phantom: boolean; relation: 'out' | 'in' | 'session' }
export function queryLinks(rawDb: D1Database, scope: MemoryScope, path: string, direction: 'out' | 'in' | 'both', depth: 1 | 2 | 3, includeJournal: boolean): Promise<{ neighbors: LinkNeighbor[][]; truncated: boolean }>; // neighbors[d] = depth d+1 ring
```

- [ ] **Step 1: Failing tests**: two-query implementation (files + links, traverse in JS — assert no per-neighbor queries by counting prepares with a spy if the harness allows, otherwise assert correctness only); session hub star for files sharing a thread ID — a `session` node with k edges, **never** k·(k−1)/2 pairwise edges; `''` thread IDs produce no session nodes/edges; phantom nodes for dangling `to_path`; resource nodes cluster same-resource concepts; tag/containment absent unless opted in; `queryLinks` depth-2 excludes journal-entry nodes unless `includeJournal`; response truncates at 100 nodes with `truncated: true`.

- [ ] **Step 2: Implement** per the spec's Graph Surface. Hard caps: `MAX_GRAPH_NODES = 500` (graph route), `MAX_LINK_NODES = 100` (`queryLinks`).

- [ ] **Step 3: Run + commit** — `feat(memory): graph builder with derived session/resource/phantom nodes`

---

### Task 11: Worker HTTP routes

**Files:**
- Modify: `packages/worker/src/routes/orchestrator.ts` (memory section, lines ~34-320)
- Test: extend the existing route tests if present (`grep -l "api/me/memory" packages/worker/src --include="*.test.ts" -r`), else route-level assertions go through the DB-layer tests already written

**Interfaces (Produces — the JSON envelope the client and gateway consume):**

```typescript
// GET /api/me/memory?path=<file>
{ file: MemoryFile, document: string, backlinks: LinkNeighbor[], notices: string[] }
// GET /api/me/memory?path=<dir or ''>
{ listing: MemoryFileListing[], index: string }               // index = virtual index.md text
// PUT /api/me/memory  body: { path, content?, type?, description?, tags?, resource?, sensitivity?, origin?, expires?, sourceSessionId? /* ignored — see below */ }
{ file: MemoryFile, warnings: string[] }
// POST /api/me/memory/move  body: { from, to } → MemoryMoveResult
// GET /api/me/memory/links?path=&direction=&depth=&includeJournal=
// GET /api/me/memory/graph?tags=&containment= → MemoryGraph
// GET /api/me/memory/export?include=all|shareable → MemoryExportManifest
// POST /api/me/memory/import  body: { files, trusted?: boolean } → MemoryImportResult
```

- [ ] **Step 1: Implement route changes.** Zod: `content` optional, `max(MAX_MEMORY_FILE_SIZE)` (replaces the 50000 cap — one constant, imported from the db module); metadata fields optional with enums for `sensitivity`/`origin`. `source_session_id` for HTTP writes is **hard-coded `''`** — never read from the body. GET file responses call `renderConcept` + backlinks via `queryLinks(depth 1, direction 'in')` + expiry notice; **the document string contains no fenced blocks** (they're separate JSON fields; only the sandbox tool inlines fences). The old `POST /api/me/memory/reindex-links` idea is NOT implemented (lazy backfill replaced it). Export/import/move/graph/links routes wire straight to Tasks 6-10 functions. Keep `GET /memory` boosting relevance fire-and-forget as today (line ~216 behavior).

- [ ] **Step 2: Typecheck + run all worker tests** — `cd packages/worker && pnpm typecheck && npx vitest run`
- [ ] **Step 3: Commit** — `feat(memory): OKF memory HTTP surface (graph, links, move, manifest export/import)`

---

### Task 12: WS protocol + DO + runner + gateway plumbing

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:3663-3712` (mem-* handlers)
- Modify: `packages/runner/src/agent-client.ts:481-507` (mem-* requests)
- Modify: `packages/runner/src/bin.ts:222-237` (gateway callbacks)
- Modify: `packages/runner/src/gateway.ts:833-918` (memory endpoints)
- Test: `cd packages/runner && pnpm typecheck` + worker typecheck (protocol is exercised end-to-end in Task 13's manual verify)

**Interfaces (Produces — WS message shapes):**

```typescript
// runner → DO (all mem-* messages gain optional fields; old runners omit them — worker must accept both)
{ type: 'mem-write', requestId, path, content?: string, meta?: MemoryWriteMeta, threadId?: string }
{ type: 'mem-move',  requestId, from, to, threadId?: string }
{ type: 'mem-links', requestId, path, direction, depth, includeJournal?: boolean }
{ type: 'mem-read' | 'mem-patch' | 'mem-rm' | 'mem-search', ... } // existing, plus threadId on patch
// DO → runner responses mirror the HTTP envelopes from Task 11
```

- [ ] **Step 1: Gateway** (`gateway.ts:849-864`): loosen `PUT /api/memory` to require only `path` (**pass-through** — content/metadata validation happens at the worker so remediation messages are consistent); forward the whole JSON body plus `threadId` (the gateway learns it from a new optional `x-valet-thread-id` request header the tools send — absent ⇒ omitted). Add `POST /api/memory/move` and `GET /api/memory/links` endpoints delegating to new callbacks `onMemMove`, `onMemLinks`.
- [ ] **Step 2: Runner** (`bin.ts`, `agent-client.ts`): thread the new fields through `requestMemWrite(path, content, meta, threadId)` etc.; add `requestMemMove`/`requestMemLinks`. The runner supplies `threadId` from its active-thread tracking (same source as `getActiveMessageId` at `bin.ts:193-199` — use the session/thread id, not the message id).
- [ ] **Step 3: DO** (`session-agent.ts`): mem-write handler passes `msg.meta ?? {}`, `msg.content` (may be undefined), and `sourceSessionId = msg.threadId ?? ''` into the new `writeMemoryFile` signature; add `mem-move`/`mem-links` handlers; mem-read handler returns `{ document, backlinks, notices, listing?, index? }`. Remove the non-null assertions (`msg.content!` at line 3677) — the new signature makes them type errors anyway.
- [ ] **Step 4: Typecheck both packages, run worker suite, commit** — `feat(memory): plumb metadata + thread id through gateway/runner/DO protocol`

---

### Task 13: Sandbox tools

**Files:**
- Modify: `docker/opencode/tools/mem_write.ts`, `mem_read.ts`, `mem_patch.ts`, `mem_rm.ts`, `mem_search.ts`
- Create: `docker/opencode/tools/mem_move.ts`, `docker/opencode/tools/mem_links.ts`
- Modify: `backend/images/base.py` (bump `IMAGE_BUILD_VERSION`)

**Interfaces (Consumes):** the gateway endpoints from Task 12. Tools send `x-valet-thread-id` from the OpenCode plugin context (the `tool` execute context exposes the session — check `@opencode-ai/plugin` types; if unavailable, omit the header and let it default to `''`, noting it in the spec).

- [ ] **Step 1: `mem_write`** — args gain `content` optional plus `type, description, tags (array of strings), resource, sensitivity (enum), origin (enum), expires` all optional, each with a `.describe()` that carries the spec's *when-to-set* guidance verbatim (spec §Tool Surface: this is where field-setting guidance lives, not the persona). Description text also lists reserved names (`index.md`, `log.md`, `lib/`) with remediations. Response renders `file` summary + each `⚠`/`ℹ` warning from the JSON on its own line.
- [ ] **Step 2: `mem_read`** — file responses render: `document`, then a blank line, then the fenced backlinks block via the worker-provided `backlinks` field (client-side rendering of `renderBacklinksBlock`'s exact shape — copy the format; the strings must match what `sanitizeBody` strips), then fenced `⚠ expired …` notice when present. Directory responses render the `index` text plus a fenced stats trailer built from `listing` (`- path · 1.2 KB · 3d ago · pinned`).
- [ ] **Step 3: `mem_search`** — compact metadata line per result: `[{type}] {path} · tags: a,b,+2 · resource: {host/path} · ←{inboundLinks}` (omit empty parts); description line omitted when empty or snippet-duplicated; append the suppressed-expired note when the response carries `suppressedExpired > 0`; **after LLM rerank, re-sort expired results to the bottom** (the rerank score must not resurrect them); rerank doc list becomes `[i] {path} — {title}\n{description}\n{snippet}`.
- [ ] **Step 4: `mem_move` + `mem_links`** — new tools per the spec's Tool Surface rows: `mem_move(from, to)` rendering pin-transition/type-retention/referencer lines from `MemoryMoveResult`; `mem_links(path, direction?, depth?, include_journal?)` rendering neighbor rings with context at depth 1.
- [ ] **Step 5: `mem_patch`, `mem_rm`** — surface the new `warnings`/`inboundWarning` response fields; patch tool description states "patches apply to the body — edit metadata via mem_write params".
- [ ] **Step 6: Bump `IMAGE_BUILD_VERSION`** in `backend/images/base.py` (increment the date-vN string). Commit — `feat(memory): OKF-aware sandbox tools (mem_move, mem_links, metadata params)`

---

### Task 14: Persona, compaction template, prune wiring

**Files:**
- Modify: `packages/worker/src/lib/orchestrator-persona.ts` (Memory section, lines ~295-395 + journal format ~458)
- Modify: `packages/plugin-memory-compaction/tools/memory-compaction.ts`
- Test: worker typecheck + existing persona snapshot tests if any

- [ ] **Step 1: Persona.** Replace the memory-writing guidance with exactly the six rules from spec §Persona & Snapshot (resource-lookup-before-create; `origin: user-stated`; `mem_move` not write+rm; journal entries link touched files; `people/<name>.md` hubs; `# Citations` + `mem_links` orientation). Delete any "enrich descriptions" style guidance. Keep the file-organization table, adding `people/` and noting it doubles as the type-default table.
- [ ] **Step 2: Compaction template.** In the journal-entry template the plugin mandates, add touched-file links to the format (`**What:** … Updated [notes](/projects/x/notes.md)`), matching the persona's journal-spine rule. Check for the duplicate copy under `.worktrees/phase6-lifecycle/` — leave it alone (stale worktree).
- [ ] **Step 3: Commit** — `feat(memory): OKF persona rules + journal-spine compaction template`

---

### Task 15: Client — metadata UI + API hooks

**Files:**
- Modify: `packages/client/src/api/orchestrator.ts` (hooks) and `packages/client/src/api/types.ts`
- Modify: `packages/client/src/components/orchestrator/memory-explorer.tsx` + `memory-explorer-utils.ts`
- Test: `packages/client/src/components/orchestrator/memory-explorer-utils.test.ts`

- [ ] **Step 1:** Extend API types to the Task 11 envelopes; hooks for move/links/graph/export(`include`)/import(`trusted`).
- [ ] **Step 2:** File rows: type badge (reuse the existing directory color themes; add `people/`), tags (≤4 + `+n`), description subtitle, resource link chip (`<a target="_blank">` with hostname text), sensitivity badge (`private`/`shareable`), expiry indicator. Detail view: "learned in session…" link when `sourceSessionId` non-empty (route to the session page), broken-link indicator per backlinks/phantom data.
- [ ] **Step 3:** Export button downloads the manifest JSON; import dialog gains a "trusted (same-instance) import" checkbox mapping to `trusted: true`.
- [ ] **Step 4:** `cd packages/client && pnpm build` — Expected: clean. Commit — `feat(client): OKF metadata in memory explorer`

---

### Task 16: Client — graph view tab

**Files:**
- Create: `packages/client/src/components/orchestrator/memory-graph.tsx`
- Modify: `packages/client/src/components/orchestrator/memory-explorer.tsx` (tab)

- [ ] **Step 1:** Fetch `GET /api/me/memory/graph`; render with a dependency-light custom SVG force layout (~100 lines: nodes as circles colored by `topDir` via the existing theme map, phantom nodes dashed, session/resource nodes distinct shapes; simple iterative force simulation in a `useEffect`, positions in state). If iteration proves painful, `d3-force` (only — not all of d3) is the approved fallback; note the dependency in the PR.
- [ ] **Step 2:** Click a concept node → open the file in the explorer pane. Toggles for `tags`/`containment` (opt-in query params).
- [ ] **Step 3:** `pnpm build` clean. Commit — `feat(client): memory knowledge-graph view`

---

### Task 17: Conformance smoke test + spec debt + docs

**Files:**
- Create: `packages/worker/src/lib/okf-conformance.test.ts`
- Modify: `docs/specs/orchestrator.md` (memory sections — lines ~47-78, 374-456, 527-533)
- Modify: `docs/specs/2026-07-02-okf-memory-design.md` (status → Implemented; correct any implementation-forced deviations)

- [ ] **Step 1: Conformance test.** Seed a bundle (files across all directories, one with extras, one expired, cross-links), export `include=all`, then assert OKF v0.1's rules programmatically: every non-reserved `.md` entry parses (`parseConcept.hadFrontmatter === true`) with non-empty `type`; every `index.md` entry has no frontmatter except root (which has exactly `okf_version: "0.1"`); index entries match `^\* \[[^\]]*\]\(/[^)]+\)( - .+)?$`.
- [ ] **Step 2: Rewrite `docs/specs/orchestrator.md`'s memory sections** to describe the shipped system (the old text documents an `orchestrator_memories` table that never existed). Point to the design spec for detail.
- [ ] **Step 3: Full verification.** `pnpm typecheck && pnpm test` from root; `cd packages/client && pnpm build`. Commit — `test(memory): OKF conformance smoke test; docs: correct orchestrator memory spec`

---

## Deploy runbook (release engineer notes, not a task)

1. Pre-deploy: `SELECT COUNT(*) FROM agent_memories` on prod D1 (CLAUDE.md Cloudflare MCP pattern). Non-zero ⇒ export to R2 before migrating. Also `SELECT COUNT(*) FROM orchestrator_memory_files` — if > 50k, move the FTS repopulate to a chunked job before shipping the migration.
2. `ENVIRONMENT=prod make deploy-migrate` **first**, then `ENVIRONMENT=prod make deploy-worker`, then `make deploy-modal` (image bump), then client.
3. Old sandboxes keep working via the compat contract (old-shape writes take create-defaults; `source_session_id`/metadata quality ramps as sandboxes recycle).

## Self-review notes

- Spec coverage: every spec section maps to a task (§Data model→1; §Serialization→2-4; §Sanitization→3,5; §Determinism→5,6,8; §Graph→9,10,12,13,16; §Resource→4,5,7; §Tool surface→5-7,12,13; §HTTP API→8,11; §Persona/snapshot→9,14; §Client→15,16; §Testing→throughout+17; §Risks→runbook+Task 1).
- Deliberately not implemented (spec-sanctioned): `reindex-links` endpoint (replaced by lazy backfill); log.md generation; org scoping.
- Type-consistency: `MemoryScope`, `MemoryWriteMeta`, `syncDerivedStores`, envelope shapes are defined once in their producing task's Interfaces block and referenced by exact name everywhere else.
