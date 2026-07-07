---
name: memory
description: Playbooks and hard-won patterns for working on the memory store itself — curation sessions, reorganization, dedup/merge, journal distillation, cap pressure, and link-graph hygiene using the mem_* tools.
---

# Memory Curation & Maintenance

Load this skill when the task is *about the memory store itself*: cleaning it up, reorganizing files, merging duplicates, enriching metadata, distilling journals, or repairing the link graph. Day-to-day remembering doesn't need this — the `mem_*` tool descriptions and your persona rules cover that.

## Mental model (30 seconds)

- Memory is a bundle of typed markdown concepts. Metadata (type, tags, description, resource, sensitivity, origin, expires) lives in columns; the frontmatter you see on `mem_read` is a **projection** — edit metadata via `mem_write` params, never by patching YAML text.
- A link graph is extracted from markdown links in bodies on every write. Backlinks, graph views, prune keep-signals, and `mem_links` all derive from it.
- **Cap: 200 files** (pinned exempt). Prune evicts expired-first, then low relevance / low inbound-link count. Reads and searches never mutate or evict anything.
- The journal is the chronological spine: entries link the files they touched, so `mem_links` from a journal day reconstructs what happened.

## Gotchas (learned the hard way — trust these)

1. **`mem_move` does NOT reclassify `type`.** Moving `projects/x/note.md` → `workflows/note.md` keeps `type: project-note`. Follow every cross-directory move with `mem_write(path, type: ...)` to reclassify. The move response reminds you (`"type remains '…'"`).
2. **`mem_move` rewrites inbound links for you** and reports `"N referencing files updated"` — never hand-edit referencing files after a move. If the response says some referencers were skipped (concurrent-edit guard), fix only those.
3. **Fenced blocks are not the file.** `# Linked from` backlinks, `⚠ expired` notices, and directory stats trailers arrive inside `<!-- valet:… -->` fences appended to reads. They're stripped on write and `mem_patch` refuses to target them. Never copy them into content.
4. **Metadata is sticky.** On update, an omitted param means *unchanged* — a body-only write can't downgrade `origin: user-stated`. Clearing is explicit: pass `""` for `description`/`resource`/`expires`.
5. **Expired files vanish from search by default.** If something seems forgotten, retry `mem_search` with `include_expired: true` before concluding it's gone. Expiry never deletes at read time — eviction happens only in write-path prune/sweep.
6. **Same-`resource` warning means merge, not fork.** When `mem_write` warns another file covers the resource, move the new knowledge into that file and `mem_rm` yours.
7. **File size is capped** on every channel, including patch growth. When a file approaches the cap, split it into a hub + spokes rather than truncating.

## Playbook: full curation session

The proven phase order (survey → enrich → link → reorganize → verify); do phases in passes over the whole store, not file-by-file:

1. **Survey** — `mem_read` each directory. The fenced stats trailer gives `updated · size · pinned` per entry: your staleness/cap-pressure triage list. Count files vs the 200 cap.
2. **Enrich** — fill missing `type`, `tags`, `description`, `resource`, `sensitivity` via metadata-only `mem_write` (omit `content`). Define a small consistent tag vocabulary first (~15–20 tags) and reuse it; the tools hint on near-duplicate tags only once, so decide deliberately.
3. **Cross-link** — add `## Related` sections linking cluster members (a project's files to each other, workflows to the projects that use them). Meaning lives in the surrounding prose, so say *why* it's related.
4. **People hubs** — one `people/<name>.md` per person (`type: person`, `resource:` their email/handle), then patch mentions elsewhere to link the hub.
5. **Reorganize** — see the reorganization playbook below.
6. **Ephemera** — anything time-bound gets `expires` (test canaries, temporary windows, event notes). Deliberate expiry beats letting the cap choose for you.
7. **Verify** — `mem_links` on the hubs you touched (expect the new edges), re-read one enriched file (frontmatter + backlinks look right).

Close by appending a journal entry describing what you did, **linking every touched file** — that's what makes the session reconstructable later.

## Playbook: reorganization

1. Before moving anything, `mem_links(path, direction: in)` — know who points at the file.
2. `mem_move(from, to)` — one file at a time; read each response (referencers updated, pin transitions, retained type).
3. Reclassify: `mem_write(to, type: <new dir's type>)` for cross-directory moves (gotcha #1).
4. Spot-check one referencing file to confirm the rewritten link resolves.
5. Journal the mapping (`old → new`) so future-you can follow stale references.

Never reorganize with write+rm — you'd orphan every inbound link and lose provenance/version history.

## Playbook: dedup / merge

1. Find candidates: `mem_search` by topic AND by `resource` filter (resource is the identity primitive — two files about one repo/doc is the classic dup).
2. Pick the canonical file: more inbound links wins; otherwise the better-located path.
3. Move unique content into the canonical file (`mem_patch` append under a section), merging Citations.
4. `mem_rm` the duplicate. It warns about inbound links — patch those referencers to point at the canonical file first, or accept the phantoms knowingly.

## Playbook: journal distillation

Journals are unpinned and prune naturally — that's by design, but durable knowledge must escape before it ages out:

1. Scan journals older than ~2 weeks for facts that are still true (decisions, preferences, gotchas, project state).
2. Promote each into the right home (`projects/`, `preferences/`, `workflows/`, `notes/`) — update existing files over creating new ones.
3. Link back to the source journal date in the promoted file (provenance), and let the journal die on schedule.

## Cap pressure & prune hygiene

- At >~180 files, run a triage pass: expire ephemera, merge duplicates, distill-and-drop old journals.
- Keep-signals the pruner respects: **pinned** (exempt entirely), **inbound links**, recency/relevance. A well-linked hub survives; an orphaned note doesn't. If something must survive unpinned, link it from a hub.
- Pinning is precious: `preferences/` auto-pins and auto-loads into every session — keep those files short and high-signal, since they cost context every single session.

## Link-graph hygiene

- **Phantom nodes** (links to files that don't exist) are either TODO stubs — create the file — or typos — fix the link. A curation pass should end with phantoms you can name and justify.
- Use `mem_links(path, depth: 2)` to orient on a topic before working on it; depth-1 `context` lines tell you why each edge exists.
- Session-sibling edges (memories written in the same conversation) are derived automatically — you don't create them, but they're a good dedup lead: siblings often overlap.

## Style wisdom

- **One concept per file**, hub-and-spoke over mega-files. Small files link better, search better, and survive the size cap.
- **Update over create.** Every near-duplicate file costs a cap slot and splits the link graph.
- **Titles and descriptions do real work** — search reranking sees them. A description should say what the file *answers*, not restate the title.
- **Don't churn.** Every write bumps version and hash. Batch metadata fixes into one `mem_write` per file, and skip writes that change nothing.
