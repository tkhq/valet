# OKF-Native Orchestrator Memory — Design Spec

**Date:** 2026-07-02
**Status:** Implemented (2026-07-03) — a few implementation-forced deviations are called out inline below (search "**Deviation**")
**Target:** OKF v0.1 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

## Goal

Make the orchestrator memory system a conformant Open Knowledge Format (OKF) bundle, natively. When this ships:

1. **Richer internal memory** — types, descriptions, tags, and cross-links improve search ranking, snapshot selection, and prune decisions.
2. **Portable knowledge** — export produces a bundle any OKF consumer can read; import accepts bundles produced elsewhere (e.g., knowledge-catalog enrichment agents).
3. **Serveable to other agents** — the memory tree reads as an OKF bundle (typed concepts, per-directory indexes, cross-links) at every boundary.
4. **Sync-ready** — serialization is deterministic and round-trip lossless, so a follow-up GitHub sync spec can build on it without rework.

**Out of scope** (separate follow-up specs): GitHub bidirectional sync; shared memory libraries (see Forward Compatibility); `log.md` generation (optional in OKF, our version history is too thin to render honestly); org-scoped memory; embeddings/semantic search.

## Architecture: metadata in columns, frontmatter as projection

The DB remains the source of truth. OKF frontmatter is **never stored** — it is a deterministic projection rendered whenever a file crosses a boundary (mem_read, HTTP API, UI, export). The stored `content` column holds the plain markdown body only.

Consequences:

- Conformance cannot drift: every rendered document is generated from columns by one code path.
- The agent cannot corrupt frontmatter: anything document-shaped the agent writes is sanitized through a single key-disposition policy (see Sanitization & Trust Boundaries).
- FTS indexes metadata fields directly.
- Rendered concept documents contain **only knowledge-stable data**. Volatile or instance-local state (relevance, version, pinned, source_session_id) lives in DB columns and travels via the export manifest **sidecar**, never in frontmatter (see Determinism & Churn Semantics).

Three laws govern the whole design, all test-enforced:

1. **Serialization round-trip**: `parseConcept(renderConcept(x)) ≡ x` (row-level).
2. **Agent round-trip**: `mem_write(path, mem_read(path).document)` is a **no-op** — the write path strips everything the read path synthesizes. Test fixtures must include expired files and files with backlinks (the decorated cases are where this law historically breaks).
3. **Composite-response rule**: a tool response is *document + sentinel-fenced non-document regions, nothing else*. No warning, backlink, or annotation ever appears in the document itself, and `sanitizeBody` strips exactly the fenced regions. Every future response decoration must use the fence.

## Data model

### Schema changes (one new migration)

Add to `orchestrator_memory_files`:

| Column | Type | Default | Maps to |
|---|---|---|---|
| `type` | TEXT NOT NULL | `''` | OKF required `type` |
| `description` | TEXT NOT NULL | `''` | OKF `description` — **authored values only**; never auto-populated (see Tool Surface) |
| `tags` | TEXT NOT NULL | `'[]'` | OKF `tags` (JSON string array) |
| `resource` | TEXT NOT NULL | `''` | OKF `resource` URI (stored **normalized** — see Resource Linking) |
| `extras` | TEXT NOT NULL | `'{}'` | Unknown frontmatter keys, preserved per OKF's round-trip rule. Values stored as **as-written scalar strings** (see Canonical YAML) |
| `sensitivity` | TEXT NOT NULL | `'private'` | `private \| shareable` — whether this memory may ever leave the user's bundle |
| `origin` | TEXT NOT NULL | `''` | `user-stated \| inferred \| imported`; `''` = unknown (legacy rows) |
| `source_session_id` | TEXT NOT NULL | `''` | **OpenCode thread ID** of the conversation that wrote the memory — system-captured, never accepted from any document or param (see Provenance Capture) |
| `expires` | TEXT | NULL | Optional expiry for ephemeral context (stored in D1 datetime format — see Temporal Columns) |

`title` → OKF `title`; the column becomes allowed-empty: foreign concepts imported without a `title` keep it empty, render omits the key, the UI derives a display title from the filename. For agent writes, `title` remains **body-derived** via the existing `extractTitle` (first H1, fallback filename); embedded frontmatter `title` is ignored on agent writes (stale-echo class) and there is no `title` param. Imports may set it.

Also add `links_indexed_at TEXT` to `orchestrator_identities` — the per-user link-backfill sentinel (see Link Backfill).

New table:

```sql
CREATE TABLE memory_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',   -- the containing LINE, trimmed, ≤200 chars; first occurrence wins when a file links the same target repeatedly
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, from_path, to_path)
);
CREATE INDEX idx_memory_links_to ON memory_links(user_id, to_path);
```

Rows for a file's outgoing links are rebuilt on every write/patch/import. **Any deletion of a file (mem_rm, prune, expiry sweep, directory delete) deletes both its outgoing rows and its inbound rows** — phantoms (see Graph) represent only never-created targets. Caveat: if a linking file's body still references a deleted path, its next rewrite re-extracts the link and the phantom legitimately reappears; the `mem_rm` inbound-link warning exists to prompt cleanup at delete time.

Also in this migration:

- **Resource index**: `CREATE INDEX idx_memory_files_resource ON orchestrator_memory_files(user_id, resource)`.
- **FTS rebuild**: drop and recreate `orchestrator_memory_files_fts` with `(path, title, description, tags, content)`; repopulate from the base table (must not assume empty). The FTS `tags` field is a space-joined normalized tag string (JSON column stays source of truth); the FTS `description` field is the authored description **or, when empty, the first body paragraph derived at index time** — search always has description-weight signal without ever storing derived text (no staleness, no `""`-clear paradox, no double-weighting of first-paragraph terms in `content`). Tag/description derivation happens in one place: the FTS-sync helper. BM25 weights: `path 5, title 10, description 8, tags 6, content 1`.
- **Backfill**: existing rows get `type` from the directory-default table below; `description`/`tags`/`resource` stay empty.
- **Reserved-name amnesty**: existing rows whose basename is `index.md`/`log.md` are renamed in place (`index.md` → `index-notes.md`, `log.md` → `log-notes.md`), rows under `lib/` move to `imported-lib/`. **Deviation**: collisions get an **id-derived suffix** (`index-notes-<first 8 chars of the row's id>.md`), not a numeric counter — implemented this way because the migration is pure SQL (no sequence state to thread through the `UPDATE`), and the id is already unique and available per row. Every rename resyncs FTS in the same migration. Inbound body links to renamed paths are **not** rewritten at migration time (the link machinery doesn't exist yet) — they surface later as phantoms; documented, accepted.
- **Cleanup**: drop the legacy `agent_memories` table and delete `packages/worker/src/lib/schema/memories.ts` — **after verifying it is empty in prod** (one D1 COUNT pre-deploy; if rows exist, export to R2 or rename instead of drop).
- **Scale guard**: if total memory rows exceed ~50k, the FTS repopulate moves to a chunked post-deploy job; below that it runs inline.

### Temporal columns

All temporal columns (`created_at`, `updated_at`, `last_accessed_at`, `expires`) store D1's native `YYYY-MM-DD HH:MM:SS` UTC form so lexicographic SQL comparisons are always valid; conversion to ISO 8601 `Z` happens **only at the render boundary** (`renderConcept`, JSON envelopes). Inbound ISO values (`expires` param, imported `timestamp`) are normalized to the storage form on write. One test covers a same-day expiry boundary.

### Type vocabulary

`type` is a free-form short string (OKF has no fixed taxonomy), stored and rendered **verbatim** — imported types like `BigQuery Table` are never kebab-coerced. Directory defaults when the agent doesn't supply one:

| Directory | Default type |
|---|---|
| `preferences/` | `preference` |
| `projects/` | `project-note` |
| `workflows/` | `workflow` |
| `journal/` | `journal-entry` |
| `people/` | `person` |
| `notes/` and everything else | `note` |

### The `valet:` extension and the manifest sidecar

Non-OKF metadata splits by stability:

**Rendered in frontmatter under `valet:`** — knowledge-stable, agent-meaningful, changes only on explicit writes: `sensitivity`, `origin`, `expires` (semantics as in the column table; consumption in Tool Surface / HTTP API).

**Never rendered in documents — manifest sidecar only** (`valetState` per export entry): `pinned` (path-derived, recomputed on import — informational), `relevance` (mutates on read access; in-document it would churn every hash), `version` (instance-local), `source_session_id` (instance-local; the UI reads it from the JSON envelope).

`valet:` in rendered output is written by the system from columns only. `valet:` in inbound documents goes through the key-disposition table — never merged wholesale. **Unknown `valet.*` sub-keys are dropped and reported** (in the import result / write response) — the namespace is ours, and preserving unvetted keys inside it would bypass the disposition policy; they may not hide in `extras` either (denylist). Future features (library provenance: `valet: { libraryOrigin, libraryVersion }`) extend the rendered set explicitly.

`org_id` stays on `orchestrator_memory_files`: it is the owner key for future org-published shared libraries. Do not remove it as dead code.

### Provenance capture (`source_session_id`)

The meaningful provenance unit is the **OpenCode thread ID** — the DO session ID is useless for the dominant writer (the orchestrator's DO session is the well-known constant `orchestrator:{userId}`, which would collapse all session-sibling edges into one eternal hub). Capture requires plumbing the active thread ID through the whole path: `mem_*` tool → gateway request → runner callback → WS `mem-*` message schema → DO handler (the runner already tracks the active thread). This touches `docker/opencode/tools/` (⇒ `IMAGE_BUILD_VERSION` bump; **old sandboxes write `''` until recycled** — accepted decay, documented). Writers:

- Orchestrator and child sessions (all sessions get `mem_*` tools): their current thread ID.
- Web-UI / HTTP writes: `''` (no thread in context).
- Import: `''`.

Empty values never produce session-sibling edges or provenance links.

## Serialization: `packages/worker/src/lib/okf.ts`

One module owns the format in both directions. Every boundary uses it.

- `renderConcept(file): string` — frontmatter + stored body, **nothing else** (no derived content, ever — export and read share this function). Key order fixed: `type, title, description, resource, tags, timestamp`, then `valet:` (fixed sub-key order), then `extras` keys recursively sorted. Empty optionals omitted.
- `parseConcept(string)` — splits frontmatter from body; maps known keys per the disposition table; unknown non-`valet` keys → `extras`. Tolerant per OKF: missing frontmatter or missing `type` never fails.
- `sanitizeBody(string)` — strips a leading frontmatter block (keys routed through disposition) and strips **only structurally-matching system-generated fenced blocks**: the sentinel line plus contiguous lines matching the generated block shape. Content after a fenced block that does *not* match the generated shape is **preserved**, and the write response says so (`"content found after the auto-generated block was kept — it is now part of the file"`). A sentinel string appearing mid-body with non-matching surroundings is left alone. Tests: append-after-block, sentinel-quoted-in-body, plain round-trip.

### Canonical YAML emission policy

- YAML 1.2 core schema. All string scalars **always double-quoted** with escaped newlines; `tags` in flow style `["a", "b"]`; block style otherwise; LF; no trailing whitespace; fixed int/float rendering.
- `extras` values are preserved **as-written**: unknown scalars are captured as their source text (`NO` stays `"NO"`, `1.10` stays `"1.10"`) and re-emitted verbatim. This requires a CST/document-level YAML API — the `yaml` package's document API (`keepSourceTokens`), not `js-yaml`'s plain `parse()`, which coerces and discards source text. The library choice is pinned here because this sentence is unimplementable without it.
- Comments/anchors/original formatting of foreign documents are not preserved — document-level round-trip is **canonicalizing** by design. Sync contract: compare canonical renderings (`hash(render(parse(doc)))`); a foreign file is rewritten once and stable thereafter.
- A golden-file test locks emitter output so a library upgrade that changes bytes fails CI.

### Virtual `index.md`

Generated from the DB on demand, never stored. One section for subdirectories (bare entries, trailing slash: `* [projects](/projects/)`), one for files (`* [Title](/path.md) - description`; the ` - description` suffix omitted when description is empty). Entry order is **path-lexicographic** (pinned — export determinism depends on it). Links bundle-relative. Root index carries `okf_version: "0.1"` frontmatter — the one place OKF allows it.

### Reserved names & path rules

Gate **agent and API writes only — never imports** (imports remap; see HTTP API). Validation runs after `normalizePath`, applies to `mem_patch`-created files and `mem_move` destinations. Rejections carry remediation, verbatim:

- basename `index.md`/`log.md` → `"index.md is auto-generated for directories — use overview.md instead"`
- `lib/` prefix → `"lib/ is reserved for mounted libraries — write under notes/ or projects/"`
- depth > 5 → `"path exceeds 5 levels — flatten under projects/<name>/"`

Max depth 4 → 5 as `MAX_MEMORY_PATH_DEPTH`. Reserved names + hints also appear in the `mem_write` tool description.

## Sanitization & trust boundaries

Frontmatter arrives from three channels. One **key-disposition table** in `okf.ts` governs all:

| Key | Agent write (embedded in content) | Trusted import | Foreign import |
|---|---|---|---|
| `type, description, resource, tags` | merged when the echo is **fresh** (below); explicit params always win | honored | honored |
| `title` | **ignored** — body-derived via `extractTitle` | honored | honored |
| `timestamp` | **used as a concurrency guard, then discarded** (below) | honored → `updated_at` | honored → `updated_at`; absent ⇒ import-time now |
| `valet.sensitivity` | ignored — param only (**warn if it differs from stored**) | honored | **reset to `private`** |
| `valet.origin` | ignored — param only (warn if differs) | honored | **forced to `imported`** |
| `valet.expires` | ignored — param only (warn if differs) | honored | honored |
| `valet.source_session_id` | never accepted from any document | sidecar only | **reset to `''`** |
| `valet.pinned / relevance / version` | never accepted | sidecar only (pinned recomputed) | defaults |
| unknown `valet.*` | **dropped + reported** | dropped + reported | dropped + reported |
| anything else | → `extras` | → `extras` | → `extras` |

Hard denylist for `extras`: `type, title, description, resource, tags, timestamp, valet` — render can never emit a duplicate YAML key.

**Stale-echo guard**: embedded frontmatter on an agent write is an echo of a past `mem_read`. Its `timestamp` is compared against current `updated_at`: on match (fresh echo) the OKF content keys merge; on mismatch (the file changed since the read) **all embedded metadata is ignored, the body is still written, and the response warns** — otherwise a stale echo silently reverts concurrent metadata edits. Embedded keys merge unconditionally on **create** (no stored state to revert).

**Loud, not silent**: whenever an embedded system-managed key's value *differs* from the stored column, the response warns with the remediation (`"⚠ embedded valet.sensitivity ignored — pass sensitivity: 'shareable' as a param"`). Equal-value echoes stay silent, preserving the round-trip no-op. Without this, an agent that edits `sensitivity` in the visible frontmatter gets a success response and a file that never becomes shareable — a correctness-affecting silent drop.

**Import modes**: `trusted: true` on the import request, available only to the authenticated owner — **user-asserted, not cryptographically verified** (no instance identity exists; dev→prod is an operator-driven move and the operator vouches for the bundle). Absent flag ⇒ foreign. The legacy-JSON-format compat path gets trusted semantics **only behind the same explicit flag**.

### Metadata update semantics (stickiness)

- Defaults apply **at create only**. On update, omitted params mean **unchanged** — a body-only write can never downgrade `origin: user-stated` or flip `sensitivity`.
- Clearing is explicit: empty-string param (`description: ""`, `resource: ""`, `expires: ""`) clears; omission never does. (Clears are real because descriptions are never auto-stored — derivation is FTS-only.)
- `content: ""` rejected: `"to clear a file use mem_rm; to update metadata only, omit content"`.
- Create without content rejected: `"<path> does not exist — provide content to create it"`.

## Determinism & churn semantics

The hash (SHA-256 of `renderConcept` output) is the sync change-detection primitive. Every operation's effect:

| Operation | `updated_at` | `version` | hash |
|---|---|---|---|
| body write / patch | bump | bump | changes |
| metadata write | bump | bump | changes |
| relevance boost / `last_accessed_at` / pin recompute | — | — | unchanged |
| **reads and searches** | — | — | **never mutate anything** (expiry never evicts at read time — see Tool Surface) |
| import, identical content+metadata | **no-op: skipped entirely** | — | unchanged |
| import, differing | preserves incoming `timestamp` → `updated_at` | bump | changes to incoming |
| `mem_move` — moved file | **preserved** (a move is not a knowledge change) | bump | **unchanged** (rendered bytes are path-independent; only the manifest key moves) |
| `mem_move` — referencing files (link rewrite) | **not bumped** (mechanical rewrite; OKF timestamp reflects knowledge changes; sync keys off hash) | bump | changes |

The no-op skip and timestamp preservation fix the current importer (`buildImportChunk` stamps `datetime('now')` unconditionally) and make export→import→export produce an identical manifest — the round-trip test that matters for sync.

## Cross-links & knowledge graph

OKF cross-links assert relationships between concepts; meaning lives in surrounding prose. Full graph story:

1. **Convention** — persona teaches bundle-relative cross-links; `okf.ts` normalizes relative links at write time.
2. **Link index** — outgoing links extracted on every write/patch/import (code blocks ignored; `context` = containing line, ≤200 chars, first occurrence). Unlocks backlinks, graph-aware retrieval (snapshot neighbor promotion, prune keep-signal, `mem_rm` warnings), and broken-link hygiene.
3. **Derived edges & nodes** — computed, no extra storage:
   - **Session siblings**: memories sharing a non-empty `source_session_id` (an OpenCode thread — see Provenance Capture) render as a **star through a derived `kind: session` hub node** (O(k), matching "what else came from that conversation?"), never a pairwise clique. **Empty IDs produce nothing** (test-enforced).
   - **Phantom nodes**: link rows whose target was never created render as `kind: phantom` TODO-stubs. Deletions remove inbound rows, so phantoms never represent evictions (migration-rename phantoms excepted, documented).
   - **Tag & directory clustering** (opt-in): `kind: tag` nodes and containment edges behind graph API params. Off by default.
4. **Conventions that grow the graph** — journal entries link touched files (compaction plugin's journal template updated to match); people get `people/<name>.md` hub files (`type: person`, `resource:` email/handle), deduped by resource.

### Backlinks & response decorations (the composite-response rule)

`mem_read` returns the document plus decorations, each in a sentinel-fenced block **after** the document — never inside it:

```
<!-- valet:backlinks — auto-generated; anything in this block is not part of the file and is stripped on write -->
# Linked from
…
```

- Expiry warnings use the same mechanism: an expired file's read response carries `<!-- valet:notice --> ⚠ expired 2026-06-14` as a fenced block — **never a leading line in the document** (a leading line would break the agent round-trip law *and* demote the frontmatter to body text on write-back).
- `sanitizeBody` strips fenced blocks per the structural-match rule in Serialization; agent content appended after a block survives.
- Backlinks capped: top 10, then `…and N more (use mem_links)`. Journal backlinks collapse to one line (`Referenced in 14 journal entries, latest 2026-07-02`). **Deviation**: the cap is applied in **`queryLinks`' API order**, not sorted by linking file's `updated_at` — `queryLinks` (`memory-graph.ts`) resolves neighbors from the `memory_links` table, which carries no `updated_at` (that lives on `orchestrator_memory_files`, a join the neighbor query doesn't do). Known deviation; revisit if "most recently touched backlink first" becomes a real product need.
- The HTTP JSON envelope carries backlinks/notices as structured fields; only the sandbox tool renders fenced blocks.

### Graph surface

- `mem_links` tool (below): traversal implemented by loading the user's files + links tables once and walking in JS (≤200 files; per-neighbor queries at depth 3 would be an N+1 amplifier). Caps: hard node/edge limit per response; journal-entry nodes excluded beyond depth 1 (`include_journal` overrides); `context` at depth 1 only; sibling lists capped.
- `GET /api/me/memory/graph` — ~2 queries (files table + links table; hubs/resource/phantom/containment all derive in JS). Nodes: `kind: concept | resource | phantom | session` (+ `tag` opt-in); edges: `kind: link | session` (+ `containment` opt-in), `context` on link edges.
- Memory explorer graph view tab: directory color themes (now including `people/`), phantoms visually distinct, opt-in clustering toggles. Rendering approach (d3-force vs. custom SVG) is an impl-plan decision.

## Resource linking

Three tiers, distinct semantics:

| Tier | Mechanism | Semantics |
|---|---|---|
| `resource` frontmatter | one canonical URI | **Identity** — the asset this concept is *about* |
| `# Citations` body section | numbered references | **Evidence** — persona convention only |
| Inline cross-links | `memory_links` | **Relationships** — internal only; external URLs never become graph edges |

`resource` is the dedupe primitive, which only works canonicalized:

- **`normalizeResource()`** (shared by write + query): lowercase scheme+host, `http`→`https`, strip trailing slash, strip `.git`, drop default ports, and remove **exactly this closed param list**: `utm_*`, `fbclid`, `gclid`, `ref`, `si`. Never any other param — over-stripping destroys identity for URLs whose query *is* the identity (`youtube.com/watch?v=`, Notion, Google Docs). The list is versioned; changing it requires a re-normalization migration over stored values. Raw form goes to `extras` when it differs.
- `mem_search` `resource` filter: exact, or segment-aware prefix (`prefix` + `/` boundary — `…/valet` ≠ `…/valet-infra`).
- `mem_write` warns on same-resource collision with remediation: `"⚠ notes/valet-repo.md already covers this resource — consider merging there and mem_rm'ing this file"`.
- Persona rule: look up by resource before creating a memory about an external asset.

Validation permissive (any parseable URI); resources never fetched.

## Tool surface

**Response conventions** (all tools): `⚠` prefix for correctness-affecting warnings (collisions, dropped keys, stale echo, inbound links); `ℹ` for hygiene hints. Hygiene hints fire at most once per novel case, never repeatedly — a fixed suffix on every response trains the agent to ignore the channel the `⚠` warnings ride on.

| Tool | Change |
|---|---|
| `mem_write` | `mem_write(path, content?, type?, description?, tags?, resource?, sensitivity?, origin?, expires?)`. Create requires `content`; update with omitted `content` = metadata-only. Stickiness per Sanitization. Embedded frontmatter → disposition table + stale-echo guard. **Metadata-setting guidance lives in the tool param descriptions** (schemas survive context pressure; persona prose doesn't): when to set `resource`, `sensitivity: shareable`, `origin: user-stated`, `expires`. Tag hints: `ℹ` on **first use** of a tag within edit distance 1 / case / plural of an existing one — never on repeat uses, never fuzzy beyond that. Same-resource `⚠` per Resource Linking. |
| `mem_move` | **New.** `mem_move(from, to)` — carries all metadata columns, preserves `source_session_id`, rewrites inbound link rows and referencing bodies (determinism per the churn table). Destination validated by reserved-name/path rules; collision at `to` rejected. Response reports the things that change silently otherwise: pin transitions (`"now pinned — auto-loaded at session start"` / `"no longer pinned — subject to the cap"`), retained type (`"type remains 'journal-entry' — pass type via mem_write to reclassify"`), and `"N referencing files updated"`. **RMW race documented**: D1 has no interactive transactions; each referencer rewrite is guarded (`UPDATE … WHERE version = ?`), losers skipped and reported. |
| `mem_patch` | Edits the body. Patch results that begin with a parseable frontmatter block run through `sanitizeBody` (no impostor second block). Anchor/`old` failures that *would* match rendered frontmatter or a fenced block return targeted errors (`"'description: …' is rendered metadata — update it via mem_write params"` / `"'# Linked from' is auto-generated and cannot be edited"`). Patch-created files: reserved rules apply; FTS description derivation applies (journals are created by patch-append — the highest-volume class must not be the exception). Link extraction re-runs. |
| `mem_read` | File → rendered document + fenced backlinks block + fenced expiry notice when applicable. Directory → virtual OKF `index.md` **plus a fenced stats trailer** in the tool response only (per-entry `updated · size · pinned`) — the agent's curation loop (staleness triage, cap pressure, "what's protected?") needs signals the OKF index format doesn't carry; directories are never written back, so contamination risk is nil, and the mental model stays "fenced = not the file". |
| `mem_search` | Compact metadata line per result: `[preference] tags: a,b,+2 · resource: github.com/… · ←3` (inbound-link count, disambiguated; tags capped at 4). Description omitted when empty or when the snippet starts with it. **Expired files excluded by default**, and when suppressed matches exist the response appends one line: `"(2 expired files matched — pass include_expired: true)"` — silent exclusion reads as amnesia ("you never told me about a trip"). With `include_expired: true`, results annotate `[EXPIRED …]`, rank last, **and the in-sandbox reranker re-applies the demotion after LLM scoring** (the rerank sort would otherwise promote them back). Rerank payload becomes path/title/description/snippet (today it is path+snippet only — title is *added*, not retained; `MemoryFileSearchResult` widens accordingly through shared types → WS schema → gateway → tool). |
| `mem_rm` | `⚠` inbound-link warning; deletes the file's inbound *and* outgoing link rows. |
| `mem_links` | **New.** `mem_links(path, direction: out\|in\|both = both, depth: 1..3 = 1)` → neighbors with title, description, type, edge context (depth 1). Session siblings as a distinct class (capped); phantoms flagged; caps per Graph Surface. |

**Rollout compatibility**: old sandboxes run old `mem_*` tools **indefinitely** (existing sandboxes never update; hibernation prolongs this). The worker accepts old-shape requests forever: content-required writes with no metadata params take the create-default path; old `mem_search` ignores new response fields. The gateway's current validation (`!body.content` → 400) is **loosened to pass-through** — all validation and remediation errors are produced at the worker so messages stay consistent; the WS `mem-*` message schema gains optional fields. Metadata-quality guarantees only hold fleet-wide after sandbox recycling — stated expectation, not a bug.

**One file-size limit**: a single `MAX_MEMORY_FILE_SIZE` constant enforced identically on every channel (HTTP PUT, WS write, patch growth, import). The current mismatch (50k Zod cap on PUT, uncapped WS/patch) breaks the agent round-trip law on exactly one channel for large files; the constant is sized above the current largest real file and existing oversized files are grandfathered readable/patchable.

**Expiry enforcement**: retrieval-time exclusion/annotation as above; **eviction only ever happens in write-path operations** — prune (`enforceMemoryCap`, expired-first) and a scheduled sweep on the existing cron. Reads and searches never delete ("evicted lazily when encountered" is exactly the read-that-mutates class the sidecar was built to exile — a read that deletes a row and its link rows is worse than the relevance boost it replaced).

## HTTP API

- `GET /api/me/memory?path=` — file: rendered doc + structured metadata + backlinks/notices as separate JSON fields. Directory: virtual index + stats.
- `PUT /api/me/memory` — metadata fields in the JSON body; embedded frontmatter per disposition (agent channel); `source_session_id` = `''` (no thread in context).
- `GET /api/me/memory/graph` — per Graph Surface.
- `GET /api/me/memory/export` — JSON manifest `{ path → { content, hash, valetState } }` for every concept plus generated `index.md` per level (path-lexicographic entry order — the export→import→export identity test depends on it). `hash` = SHA-256 of the rendered document; `valetState` = `{ pinned, relevance, version, sourceSessionId }`.
  - `?include=all|shareable` (default `all`). Shareable: filters to `sensitivity: shareable`; index generated over the **filtered set only** (empty directories pruned) — an unfiltered index would enumerate private files' titles and descriptions, often the entire secret; omits `valetState`; renders **no `valet:` block at all**; files whose bodies link to excluded private paths are flagged in the export response (path + anchor text still leak in body prose — documented residual, accepted for v1).
- `POST /api/me/memory/import` — modes per Trust Boundaries (`trusted: true` = user-asserted owner opt-in). Mechanics:
  - Original→normalized **path map** (percent-decoding before normalization); bundle-relative links in all imported bodies rewritten through the map.
  - Normalization collisions → `skipped` list, never silent last-wins.
  - Reserved/`lib/`/depth rules don't reject imports: `lib/…` → `imported-lib/…`, over-deep paths flatten — recorded in the map (links follow) and reported.
  - Root `index.md` read first for `okf_version` (recorded; warn on major mismatch), then index files skipped. Foreign `log.md` is authored history, **not regenerable**: imports as `<dir>/log-imported.md` (`type: log`), body verbatim, reported.
  - No-op entries skipped; differing entries preserve incoming `timestamp` (absent ⇒ import-time now — affects the no-op comparison, pinned here).
  - Old-JSON-format compat path: trusted semantics **only with the explicit flag**.
  - Import batch-failure fallback (the current per-file replay) is rebuilt to maintain FTS + links, not just base rows.
- **Link backfill**: sentinel `orchestrator_identities.links_indexed_at`. Backfill runs **eagerly at orchestrator session start** post-deploy (the DO's existing init path) and lazily from **every link-consuming path** (graph, `mem_links`, directory read, prune scoring, snapshot build, `mem_rm`) — the consumers that fail *silently* against an empty link table (prune treating a hub as unlinked is a deletion-class failure) must be triggers, not just the visible ones. Extraction is idempotent; concurrent first-triggers are harmless. No user-callable ritual endpoint. **Deviation**: `ensureLinksIndexed` (`memory-link-backfill.ts`) also keeps an **in-isolate `Set<userId>` cache** in front of the sentinel read. This covers two cases the sentinel column alone can't: (1) it skips the DB round-trip entirely once a user has been backfilled in this isolate, and (2) it prevents unbounded re-backfilling for users with **no `orchestrator_identities` row** (HTTP-API-first users who never provisioned an orchestrator) — such users have nowhere to persist the sentinel, so without the cache every call within the isolate's lifetime would re-run the full walk. The cache is cleared on cold start (safe, since backfill is idempotent) and self-corrects once a real identity row exists.

## Persona & snapshot

The persona delta is deliberately small — field-setting guidance lives in tool param descriptions (see Tool Surface), and the machinery covers type defaults, FTS description derivation, and collision warnings regardless of agent diligence. Persona adds only the high-leverage rules the system cannot enforce:

1. Search by `resource` before creating a memory about an external asset (update over duplicate).
2. Mark `origin: user-stated` when the user explicitly said it — it beats `inferred` on conflict.
3. Use `mem_move`, not write+rm, to reorganize.
4. Link touched files from each journal entry (the journal is the graph's chronological spine).
5. Keep person knowledge in `people/<name>.md` hubs and cross-link them.
6. Cite evidence under `# Citations`; use `mem_links` to orient on ongoing work.

(The previous "enrich empty descriptions opportunistically" rule is deleted: FTS-time derivation makes it unnecessary, and an enrichment sweep is pure timestamp/hash churn before any future sync.)

- `memory-snapshot.ts`: pinned files' 1-hop neighbors become candidates under a **sub-budget (20% of the total token budget), titles + descriptions only**; snapshot header marks neighbor-promoted entries and each file's type; expired files never load. **Deviation**: the 20% carve-out is a **static split of `tokenBudget`** taken up front (`mainBudget = tokenBudget - floor(tokenBudget * 0.2)`), not a dynamic allocation sized to what the neighbor tier actually uses — a pinned set with zero linked neighbors still loses 20% of the main budget to a tier that ends up empty. Simple and predictable; revisit if pinned-heavy users start feeling the loss.
- Prune: expired-first, inbound-link count as keep signal — and prune runs against a backfilled link table (see Link Backfill).
- Compaction plugin: journal template updated to include touched-file links.

## Client

`memory-explorer.tsx` gains: type badge + tags, description subtitle, `resource` link chip, sensitivity badge, "learned in session…" provenance link (from the JSON envelope's `sourceSessionId`; `''` renders nothing), graph view tab, broken-link indicators, OKF bundle export. Directory color themes gain `people/`. Per project convention, `cd packages/client && pnpm build` gates client changes.

## Implementation notes

- **Atomic write units**: every mutation (base row + FTS + links) in one `db.batch()`; link-row inserts chunked under the 100-bound-param limit. D1 batches are atomic for writes but provide **no read isolation** — `mem_move`/import link-rewrites are read-modify-write and use per-file version guards (documented race, skips reported).
- **One FTS/links-sync helper**: the maintenance sites number **eight**, not four — `writeMemoryFile` (write, update, delete paths), `patchMemoryFile`, `buildImportChunk`, `deleteMemoryFile`, `deleteMemoryFilesUnderPath` (the UI directory delete), `pruneEmptyJournals`, `enforceMemoryCap`. All collapse into one helper that owns FTS sync, tag/description FTS derivation, and link maintenance. Tag join + description derivation happen JS-side in the helper (not duplicated in migration SQL — the migration repopulate does it via `json_each`/`substr` once, with a comment pointing at the helper as the ongoing owner).
- **Scope chokepoint**: all query helpers resolve ownership through a single `MemoryScope` (today `{ userId }`). Note: this is **new work**, not a light retrofit — `pruneEmptyJournals` is currently entirely unscoped (sweeps all users in one query) and every helper takes a bare positional `userId`; the chokepoint refactor fixes both.

## Testing

- **Serialization**: `parseConcept(renderConcept(x)) ≡ x`; render-twice byte identity; golden-file emitter lock; tolerance (no frontmatter, junk YAML, missing type); YAML adversarial fixtures (`title: Deploy: staging vs prod`, quotes, newlines, leading `*`, unicode, `---` in description, `NO`/`1.10`/`022`/`~` in extras); body beginning with `---`.
- **Agent round-trip** (the load-bearing suite): `write(read(x))` is a no-op for plain files, **expired files** (fenced notice), and **backlinked files** (fenced block); append-after-fenced-block preserves the appended content; sentinel-quoted-in-body preserved.
- **Trust boundaries**: embedded `valet:` alters no system column, never duplicates keys; differing embedded system keys warn; stale-echo guard ignores embedded metadata and warns; fresh echo merges; foreign import resets per table; trusted requires the explicit flag (legacy format included); unknown `valet.*` dropped + reported.
- **Determinism/churn**: relevance boost changes no byte; reads/searches never mutate; export→import→export (trusted) identity, hashes included; no-op import skips; `mem_move` rows per the churn table (moved-file hash unchanged; referencer `updated_at` not bumped).
- **Migration**: backfilled types; amnesty renames incl. collision suffixing + FTS resync; `agent_memories` gone.
- **Links**: extraction (context = line, ≤200 chars, first-wins; code blocks ignored); deletion removes inbound + outgoing; phantoms only for never-created; `mem_move` rewrites rows + bodies with version guards.
- **Resource**: normalization list exact (`utm_*`/`fbclid`/`gclid`/`ref`/`si` stripped; `?v=` retained); segment-aware prefix; collision warning.
- **Retrieval**: expired excluded + suppressed-count note; `include_expired` annotation, ranked last, post-rerank demotion holds; same-day expiry boundary (temporal format); tag hint fires once, first-use only.
- **Derived graph**: session hub star for shared non-empty thread IDs; **no edges for `''`**; caps; opt-in classes absent unless requested.
- **Shareable export**: no private **title or description** in any byte (index included); private **paths** appear only inside bodies of leak-flagged files and nowhere else; empty dirs pruned; no `valet:` block.
- **Import**: path map + link rewriting (percent-encoding); collisions in `skipped`; `lib/`/deep remaps with links following; `log-imported.md` preservation; `okf_version` recorded; old-format compat gated on the flag; missing `timestamp` ⇒ import-time.
- **Rollout compat**: old-shape gateway/WS writes succeed against the new worker; 50k-boundary file round-trips on every channel.
- **Conformance smoke test**: exported bundle passes OKF v0.1's conformance rules programmatically.
- **Updated existing suites**: `memory-files-search.test.ts`, `memory-files-export.test.ts`, `memory-explorer-utils.test.ts`.

## Forward compatibility: shared memory libraries

Hooks for the follow-on library feature (curated org/team bundles mounted read-only):

1. **Scope chokepoint** (`MemoryScope`) — a library is another scope; one-module change.
2. **Mount namespace** `lib/<library>/…` keeps the merged view a single OKF bundle (OKF links are bundle-relative, no cross-bundle form). Write-reserved now; depth 5.
3. **Content hashes** in the manifest — subscription diff primitive, shared with GitHub sync.
4. **`sensitivity`** captured at write time — publishing filters to `shareable` from day one.
5. **Library provenance** via `valet: { libraryOrigin, libraryVersion }`.
6. **`org_id` retained** as the owner key.

Not built now: library/mount/subscription tables, read-only enforcement, publishing flows.

## Risks

- **Deploy order**: the FTS shape change breaks **only** new-code-against-old-table (the current inserts use explicit column lists and `bm25()` tolerates fewer weights than columns, so old code works against the new table). Mitigation is ordering, not machinery: **apply this migration before the worker deploy** for this release (`make deploy-migrate` first, or a one-release swap of deploy steps). No runtime shape-probing.
- **FTS rebuild scale**: inline below ~50k rows (verified pre-deploy), chunked job above.
- **`agent_memories` drop**: verified empty first; exported/renamed otherwise.
- **Old sandboxes**: run old tools indefinitely; compat contract per Tool Surface. Metadata quality ramps with sandbox recycling.
- **Old export format**: compat path, trusted only with the flag.
- **Agent behavior drift**: sanitization + disposition guarantee integrity; FTS-time derivation guarantees baseline search quality; the persona carries only what the system can't enforce.
- **Residual shareable leak**: body prose links to private files expose path + anchor text; flagged at export, accepted for v1.
- **Migration-rename phantoms**: amnesty renames break inbound links (no link machinery at migration time); they surface as phantoms; accepted.
- **Spec debt**: `docs/specs/orchestrator.md`'s memory section describes a table that never shipped; rewritten to match this design in the same change.

## Follow-up specs (not this one)

1. **GitHub memory sync** — conflict resolution, change detection (export hashes + canonical-rendering comparison), webhook/polling, GitHub plugin credentials.
2. **Shared memory libraries** — builds on the hooks above.
3. **`log.md` generation** — needs a real change-history table; revisit after sync.
