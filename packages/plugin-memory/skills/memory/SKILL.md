---
name: memory
description: Playbooks for creating memories well and working on the memory store itself — write style, cross-linking, dedup/merge, journal distillation, reorganization, and expiry hygiene with the mem_* tools.
---

# Memory Creation & Curation

Load this skill when the task is *about the memory store itself*: writing new memories well, linking related files, merging duplicates, distilling journals, reorganizing paths, or enriching metadata. Day-to-day remembering doesn't need this — the `mem_*` tool descriptions and your persona's memory rules cover that.

## Mental model (30 seconds)

- Memory is a bundle of typed markdown files. Metadata (`type`, `tags`, `description`, `resource`, `sensitivity`, `origin`, `expires`, `pinned`) lives in columns; the frontmatter you see on `mem_read` is a **projection** — set metadata via `mem_write` params, never by writing YAML into the body. Embedded frontmatter is stripped on write.
- The tool surface is five tools: `mem_write`, `mem_patch`, `mem_read`, `mem_search`, `mem_rm`. There is no move tool and no links tool — a rename is a manual three-step (see the reorganization playbook).
- Directories imply a default `type`: `preferences/` → preference, `projects/` → project-note, `workflows/` → workflow, `journal/` → journal-entry, `people/` → person; anything else → note. Paths cap at 5 levels — flatten under `projects/<name>/` rather than nesting deeper.
- Markdown links between memory files build a derived graph, rendered in the memory UI. Relative (`../people/alice.md`) and absolute (`/projects/valet/overview.md`) targets both resolve.
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
- A link to a file that doesn't exist yet is either a TODO stub — create the file — or a typo — fix the link. End a curation pass with only phantoms you can name and justify.

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
2. Pick the canonical file: the better-located path, or the one other files already link to (search for its path to find referencers).
3. Move unique content into the canonical file (`mem_patch` append under a section).
4. Patch every referencer of the duplicate to point at the canonical file, then `mem_rm` the duplicate. Deletion is permanent and nothing rewrites inbound links for you — a skipped referencer becomes a phantom link.

## Playbook: reorganization (no move tool)

There is no `mem_move` — a rename is write + relink + remove, and the link graph will not follow you automatically:

1. Before anything, find referencers: `mem_search` for the old path.
2. `mem_write` the content to the new path, carrying the metadata forward explicitly — `type` especially, since the new directory's default only applies to files created without one, and a cross-directory move usually needs a reclassify anyway.
3. `mem_patch` each referencer's link from the old path to the new one.
4. `mem_rm` the old path last, after the referencers are clean.
5. Journal the mapping (`old → new`) so future-you can follow stale references.

Version history does not carry across a rename — prefer leaving well-linked files where they are unless the location is actively misleading.

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
