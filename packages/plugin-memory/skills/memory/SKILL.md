---
name: memory
description: Playbooks for creating memories well and working on the memory store itself — write style, cross-linking, dedup/merge, journal distillation, reorganization, and expiry hygiene with the mem_* tools.
---

# Memory Creation & Curation

Load this skill when the task is *about the memory store itself*: writing new memories well, linking related files, merging duplicates, distilling journals, reorganizing paths, or enriching metadata. Day-to-day remembering doesn't need this — the `mem_*` tool descriptions and your persona's memory rules cover that.

## Mental model (30 seconds)

- Memory is a bundle of typed markdown files. Metadata (`type`, `tags`, `description`, `resource`, `sensitivity`, `origin`, `expires`, `pinned`) lives in columns; the frontmatter you see on `mem_read` is a **projection** — set metadata via `mem_write` params, never by writing YAML into the body. Embedded frontmatter is stripped on write.
- The tool surface is seven tools: `mem_write`, `mem_patch`, `mem_read`, `mem_search`, `mem_move`, `mem_links`, `mem_rm`.
- Directories imply a default `type`: `preferences/` → preference, `projects/` → project-note, `workflows/` → workflow, `journal/` → journal-entry, `people/` → person; anything else → note. Paths cap at 5 levels — flatten under `projects/<name>/` rather than nesting deeper.
- Markdown links between memory files build a derived graph — there is no stored links table; edges are read from your markdown on demand. Relative (`../people/alice.md`) and absolute (`/projects/valet/overview.md`) targets both resolve. `mem_links` shows one file's inbound and outbound edges; the memory UI renders the whole graph.
- Pinned files load in full at orchestrator wake, alongside recent journal entries and the memory index. Pins cost context every session — keep them few and short.
- Reads union in team memories under a virtual `team:{teamId}/` prefix. You can read those; writes only ever touch your own scope.

## Creating memories well

- **One concept per file**, hub-and-spoke over mega-files. Small files link better, search better, and merge more cleanly later.
- **Update over create.** Run `mem_search` for the subject before every `mem_write`. A near-duplicate file splits the link graph and the search signal. `resource` is the identity primitive: when a file is about one external thing (a repo, a URL, a doc), set `resource` so future searches find it by that handle.
- **Titles and descriptions do real work** — search matches on path, title, description, tags, and content. A description should say what the file *answers*, not restate the title.
- Set `origin: 'user-stated'` when the user told you the fact directly; it outranks anything you inferred. Set `sensitivity: 'shareable'` only for content safe outside your own scope.
- Give time-bound facts an `expires` timestamp (event notes, temporary preferences, short-lived credentials context). Expired files drop out of search; nothing deletes them, and `mem_write` with `expires: null` revives one.
- **Don't churn.** Every write bumps the version. Batch metadata fixes into one `mem_write` per file, and skip writes that change nothing.

### Metadata is sticky

On update, an omitted param means *unchanged* — a body-only `mem_write` can't accidentally downgrade `origin: user-stated`. Clearing is explicit: pass `expires: null` to clear an expiry. A metadata-only update is `mem_write` with `content` omitted.

## Linking effectively

- Add a `## Related` section linking cluster members: a project's files to each other, workflows to the projects that use them. Meaning lives in the surrounding prose — say *why* each file is related, not just that it is.
- **People hubs**: one `people/<name>.md` per person (`type: person`, `resource:` their email or handle), then link the hub from every file that mentions them. Durable facts about a person live in the hub, not scattered across journal entries.
- **Journal entries link every file they touch.** The journal is the chronological spine: a day's entry that links what it changed makes the session reconstructable later.
- Use `mem_links` to orient on a topic's cluster before working on it, and to check inbound edges before a move or delete.
- A phantom in `mem_links` output (a link target with no file behind it) is either a TODO stub — create the file — or a typo — fix the link. End a curation pass with only phantoms you can name and justify.

## Playbook: full curation session

Work in passes over the whole store, not file-by-file:

1. **Survey** — `mem_read` each directory (a trailing `/` reads the index; `''` reads the root).
2. **Enrich** — fill missing `type`, `tags`, `description`, `resource`, `sensitivity` via metadata-only `mem_write` (omit `content`). Define a small consistent tag vocabulary first (~15–20 tags) and reuse it.
3. **Cross-link** — add `## Related` sections per the linking guidance above.
4. **People hubs** — create missing hubs, then patch mentions elsewhere to link them.
5. **Reorganize** — see the reorganization playbook below.
6. **Ephemera** — give anything time-bound an `expires`.
7. **Verify** — re-read one enriched file per directory and confirm the frontmatter projection looks right.

Close by appending a journal entry describing what you did, linking every touched file.

## Playbook: dedup / merge

1. Find candidates: `mem_search` by topic and by the resource handle — two files about one repo or doc is the classic duplicate.
2. Pick the canonical file: more inbound links wins (`mem_links` on each candidate); otherwise the better-located path.
3. Move unique content into the canonical file (`mem_patch` append under a section).
4. Check the duplicate's inbound edges with `mem_links`.
5. Patch each referencer to point at the canonical file. Deletion rewrites nothing — a skipped referencer becomes a phantom link.
6. `mem_rm` the duplicate.

## Playbook: reorganization

1. Before moving anything, `mem_links` on the file — know who points at it.
2. `mem_move(from, to)` — one file at a time. It rewrites inbound links in referencing files (to the rooted `/path` form) and roots the moved file's own relative links; never hand-edit referencers after a move.
3. **`mem_move` does not reclassify `type`.** If the response warns that the type no longer fits the new directory, decide: reclassify with a metadata-only `mem_write(to, type: ...)`, or keep the type if it was deliberate.
4. Spot-check one rewritten referencer to confirm the link resolves.
5. Journal the mapping (`old → new`) so future-you can follow stale references.

Never reorganize with write + rm — you'd orphan every inbound link. `mem_move` exists so the graph follows the file.

## Playbook: journal distillation

Journal entries are ephemeral by convention — durable knowledge must escape into a typed home:

1. Scan journals older than ~2 weeks for facts that are still true (decisions, preferences, gotchas, project state).
2. Promote each into the right home (`projects/`, `preferences/`, `workflows/`, `people/`) — update existing files over creating new ones.
3. Link back to the source journal date in the promoted file (provenance).

Append to today's journal with `mem_patch`: `oldString: ''` against a non-existent `journal/YYYY-MM-DD.md` creates it, and an exact-match `oldString` at the tail appends to it.

## Pin hygiene

- Pinned files and recent journal entries load into every orchestrator wake — each pin is a permanent context tax. Reserve pins for standing preferences and core identity notes.
- Keep pinned files short and high-signal. When a pinned file grows, split the durable kernel (stays pinned) from the reference detail (unpinned spoke, linked from the kernel).
- If something must be findable but not always-loaded, don't pin it — give it a good description and link it from a hub.
