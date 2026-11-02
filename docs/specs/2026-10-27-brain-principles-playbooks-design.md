# Brain: principles and playbooks

Design. 2026-10-27. Status: pilot. Updated 2026-11-02: memory usage, principle citations, principles in child sessions and workflow steps, and batched patch sets.

## Summary

Every agent behavior has one home, the brain. A request to Valet is one of four kinds, from least to most structured:

| Kind | What it is | Where it lives |
|---|---|---|
| Principle | A rule that guides open-ended work | Memory, under `principles/` |
| Skill | Instructions for one integration or task | Skills (plugin, repository, or stored) |
| Playbook | A skill with a fixed list of steps | Skills, with `metadata.kind: playbook` |
| Workflow | A saved automation that runs without a model choosing each step | Workflows |

Skills and workflows already exist. This change adds the two missing kinds in their smallest form:

1. **The principle slot.** Every assistant prompt has a Principles section. The section always contains one base principle, `learn-from-the-org`, and an index of the principles in memory.
2. **Playbook plan seeding.** When a thread loads a playbook, Valet writes the playbook's steps into the thread plan. The model spends no tokens to write the plan.

The concept note "The brain repository" (2026-10-26) describes the full design: a git repository as the source, a manifest, bidirectional sync, citations, skip tracking, and `brain.*` tools. This pilot builds none of that. It uses the existing memory and skill stores, so a brain repository can feed both later through content sync (`.valet/memory/` and `SKILL.md` directories).

## Principles

### The slot

A principle is a memory file under `principles/`, for example `principles/prove-it-works.md`. The file fields have these meanings:

- `title`: the rule, in a few words.
- `description`: when the rule applies, in one line.
- Body: the rule, the reason for it, and one example.

The memory service gives files in `principles/` the type `principle` by default.

The assistant's memory snapshot gets a `## Principles` section. The section contains:

1. The full body of the base principle. Valet ships it in code. Nobody can delete it.
2. One line per principle file that the scope can read: its own `principles/` files and the `principles/` files of its teams (`team:{id}/principles/…`). Each line gives the path, the title, and the description. Own principles come first, then team principles. Each group is in path order, so team lines group by team id.

The section holds the index, not the bodies. The model reads a body with `mem_read` when a principle applies. This keeps the cached prefix small.

The snapshot budget never drops the section, so the index has a cap: 40 lines or 4,000 characters, whichever it reaches first. Past the cap, one line gives the number of principles not listed and tells the model to read the directory with `mem_read principles/` or `mem_read team:<id>/principles/`.

### Who can write a principle

A team principle reaches the assistant of every team member at its next wake. So a team principle takes more than a team note:

- The agent writes a personal principle on its own when a person corrects it or states a rule.
- The agent writes a team principle only when a person in the conversation asks for it. The base principle and the `mem_write` description say so.
- The memory service enforces the authority. A write, patch, move, delete, or import that touches `principles/` in a team scope requires a team admin or an admin of the team's organization. This is the check that `mem_copy_to_team` makes. Team membership, which other team writes need, is not enough. The refusal tells the agent to ask a team admin or to save a personal principle.

### Provenance

When an agent writes a principle, the memory service records where the write came from as frontmatter:

- `source-actor`: the user the agent acted for.
- `source-session`: the agent session.
- `source-thread`: the thread, when the request names one.

The keys live in the existing `extras` column, so they need no schema change. The route reads them from host headers (`x-valet-actor`, `x-valet-session-id`, `x-valet-thread-id`) or the sandbox token, never from model arguments. A later agent write replaces them. A workflow step sends no session, so its writes record no provenance. A person's write in the web app records none and keeps the last agent provenance. The row's `actor_user_id` still names the last writer.

### The base principle

The base principle is `learn-from-the-org`. It is the base case and the inductive case of the brain: it is a principle, and it tells the agent to make principles. In short, it says:

- When a person corrects you or states a rule for your work, write a personal principle in your own memory.
- Search `principles/` first. Update a principle that covers the same rule. Do not make a duplicate.
- Write a team principle (`mem_write` with `teamId`) only when a person in this conversation asks you to add the rule to a team. If the write is refused, tell the person and offer a personal principle.
- Before you make a choice in open-ended work, check the index. Read a principle before you follow it. Say which principle you followed.
- Do not write secrets, credentials, or one-time facts as principles.

The exact text is `BASE_PRINCIPLE` in `packages/api/src/orchestrator/principles.ts`.

### Limits

- The agent does not infer a principle from repeated choices. It writes one only when a person corrects it or states a rule.
- The index cap hides principles past the 40th line or the 4,000th character. The model sees them only when it reads the directory.
- The snapshot is built when a session is built: an assistant at wake, a child or a workflow step when it starts. A principle written during a session appears in the index after the next build. The model that wrote it already has it in context.
- There is no org-wide memory scope. An org principle lives in the memory of a team that everyone belongs to.

### Principles in child sessions and workflow steps

A child session and a workflow step get the memory snapshot an assistant gets, Principles section included (TKAI-578). They also get the two read-only memory tools, `mem_read` and `mem_search`, so they can open a principle that the index lists. They get no write tool. Their assistant curates memory. So they get a read-only base principle (`READ_ONLY_BASE_PRINCIPLE`). It tells the agent to read and follow principles. When a person states a rule, the agent puts it in its result, so an assistant can save it.

The scope is the one the memory routes resolve for the session id (`delegatedMemoryScope` in `services/memory-scope.ts`):

- A child or a step of a personal owner reads that person's memory and the principles of their teams.
- A child or a step of a team reads the team's memory in the namespace the routes give that session. It also reads the team's shared memory under `team:{id}/`. It does not read the acting member's personal memory.
- A workflow step's read names its session, so the route resolves the run's memory audience. A step whose team audience cannot be resolved gets no snapshot and no memory tools. It never widens to the whole team.
- A security persona child gets neither.

Children and steps run often and in parallel, so their snapshot budget is 16,000 characters instead of 48,000. The budget drops journals first, then the oldest pinned files. It never drops the Principles section or the root index.

## Usage

Valet records how agents use each memory file, so a person can see which files are used and trim the rest. Three kinds of use stay apart:

| Kind | Recorded when | Counts as a use |
|---|---|---|
| Read | An agent opens a file: `mem_read`, an MCP or CLI read, a sandbox read | Yes |
| Cite | A turn's answer or plan names a principle | Yes |
| Inject | The memory snapshot loads a pinned file or a journal, or lists a principle in the index | No |

A search hit counts only when the agent then opens the file. A directory read opens no file, so it records nothing. A person who opens a file on the memory page records nothing. A file the snapshot loads is shown as "loaded at wake", not as used, because the agent did not choose it.

### Storage

The `memory_file_usage` table holds one row per file, keyed like `memory_files`, with a count and a last time for each kind. It is a separate table: an update to `memory_files` recomputes the file's search vector. A row moves with `mem_move` and goes away with `mem_rm`. A file that a repository sync removes keeps its row. A file that comes back at that path inherits it.

### Writes stay off the hot path

A read never waits on a usage write. `MemoryUsageRecorder` (`services/memory-usage.ts`) buffers hits in process and writes one batched upsert every 10 seconds. The upsert joins `memory_files`, so it adds no row for a file that was deleted or moved meanwhile. The buffer holds at most 1,000 files. When it is full and a flush is still running, the recorder drops the hit and counts it in `dropped`. A failed write drops its batch and is not retried, so a database outage cannot grow the buffer. Shutdown flushes the buffer. A crash loses at most one interval of hits. Usage is a signal for trimming, not an audit log.

### Citations

When a submission settles, a subscriber (`orchestrator/principle-citations.ts`) reads that turn's assistant entries, up to 50 entries and 64 KB of text. It also reads the items of any plan the turn wrote with `update_plan`. It finds the principles they name:

- **Explicit** (`match: "path"`): the principle's path as the index names it, with or without `.md` or a leading `/`, or the built-in principle's name. An own path never matches inside a `team:{id}/` path.
- **Heuristic** (`match: "title"`): the principle's title, as a whole phrase. Only titles of two words or more and 8 characters or more match. A title match can be wrong.

The subscriber appends one `principle_cited` thread event per submission, with the citations, and records a cite on each principle file. The event key is `principle_cited:{queueItemId}`, so a repeated settle appends nothing and counts nothing. A turn records at most 10 citations. The event stays in the durable thread log. No client shows it yet.

### The memory page

The memory page has a Usage view beside Files and Graph. It lists every file of the workspace with its last use, its use count, its last load at wake, and its last edit. It filters to never-used or stale files and sorts by least recent use, most uses, or path. A file is stale when no agent used it and nobody edited it for 30 days. So a new file that no agent used yet is not stale. Tracking starts when the `memory_usage_tracking` table is created, and the tree reports that time as `usageSince`. Before it, "never used" only means "not seen". So no file is stale until tracking has run for 30 days, and the view says how long it has run. A person selects files and deletes them after one confirm. A file under `lib/` mirrors a repository, so the view offers no delete for it.

## Batched patch sets

`mem_patch` takes `patches`, a list of up to 20 exact-replace patches, in place of `path`, `oldString`, and `newString`. The memory service applies them in one transaction (`patchFiles`): every patch applies, or none does. Patches apply in order, so a later patch to the same file sees the earlier edit. Each patch takes the path rules, the team-principle authority check, and the provenance of a single patch. If a patch fails, the error names it, for example "Patch 2 of 3 (principles/x.md) failed", and says that no patch was applied. `POST /api/memory/patch` takes the same `patches` body. This is the batched patch set that `brain.put` needs.

## Playbooks

### The format

A playbook is a skill that conforms to the Agent Skills specification. It marks itself with the spec's `metadata` map and lists its steps under a `## Steps` heading:

```markdown
---
name: bug-fix
description: Fix a reported bug. Use when a person reports a defect.
metadata:
  kind: playbook
---

Use this playbook for one reported bug.

## Steps

1. Reproduce the bug
2. Write a failing test
3. Fix the cause
4. Run the suite
```

The steps are the ordered (`1.`) or bulleted (`-`, `*`) list items under the first `## Steps` or `### Steps` heading, up to the next heading. A playbook with no steps, more than 20 steps (the plan limit), or a step longer than 200 characters loads as a normal skill and does not seed the plan. The skill result says why.

### Seeding

Valet seeds the plan on two paths:

- **Model read.** The model calls `skill` for a playbook with no `path`. The tool seeds the plan, then returns the body with a line that says the plan now holds the steps.
- **Slash invocation.** A person sends `/skill:<name>` or `/<name>` for a playbook, or the host invokes it (`Thread.skill`). The thread seeds the plan when it admits the message. The plan overlay at the start of the turn shows the steps.

The first step is `in_progress`. The other steps are `pending`. The step text is copied without change.

Valet does not replace an open plan. If the thread has a plan with an item that is not `done`, seeding stops, and the skill result tells the model to merge the steps with `update_plan` if they apply. A plan with every item `done` is replaced.

The `skill` tool description marks each playbook with `(playbook)`, so the model knows that reading one sets the plan.

## Deferred

These come from the concept note. This pilot does not build them:

- The brain repository, its manifest (`.valet/brain.yaml`), and write-back to git.
- `brain.get`, `brain.search`, `brain.put`, and `brain.rm`. `brain.put` can build on the batched patch set in `mem_patch`.
- Automatic playbook matching from a `when` field. The model chooses a playbook from the skill list.
- Skip tracking with a reason.
- `extends` for project playbooks.
- A client view of `principle_cited` events in the thread.
- Batched patch sets in the MCP `patch_memory` tool.
- Usage by member: the table counts uses per file, not per person or per session.
- Agent-led trimming: the agent proposes stale files to remove. Today a person trims from the memory page.

## Open questions

1. Should an org principle have its own org memory scope, or is a team that holds everyone enough?
2. Should a playbook replace an open plan when a person invokes it with a slash command? This pilot keeps the open plan on both paths.
3. Should a team principle go through review, as the concept note requires for brain changes? This pilot requires a request in the conversation and team-admin authority, but no review step.
4. Is a playbook anything more than a skill whose steps seed the plan? This pilot says no.
