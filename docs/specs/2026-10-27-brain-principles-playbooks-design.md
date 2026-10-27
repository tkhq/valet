# Brain: principles and playbooks

Design. 2026-10-27. Status: pilot.

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
2. One line per principle file that the scope can read: its own `principles/` files and the `principles/` files of its teams (`team:{id}/principles/…`). Each line gives the path, the title, and the description.

The section holds the index, not the bodies. The model reads a body with `mem_read` when a principle applies. This keeps the cached prefix small.

### The base principle

The base principle is `learn-from-the-org`. It is the base case and the inductive case of the brain: it is a principle, and it tells the agent to make principles. In short, it says:

- When a person corrects you, states a rule, or you see the organization make the same choice two or more times, write a principle.
- Search `principles/` first. Update a principle that covers the same rule. Do not make a duplicate.
- Write a team rule to the team's memory (`mem_write` with `teamId`). Write a personal rule to your own memory.
- Before you make a choice in open-ended work, check the index. Read a principle before you follow it. Say which principle you followed.
- Do not write secrets, credentials, or one-time facts as principles.

The exact text is `BASE_PRINCIPLE` in `packages/api/src/orchestrator/principles.ts`.

### Limits

- Only assistant sessions get the section, because only they get the memory snapshot. Child sessions and workflow steps do not.
- The snapshot is built when the assistant session wakes. A principle written during a session appears in the index after the next wake. The model that wrote it already has it in context.
- There is no org-wide memory scope. An org principle lives in the memory of a team that everyone belongs to.

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
- `brain.get`, `brain.search`, `brain.put`, and `brain.rm`. `brain.put` needs a batched patch set, which is not designed yet.
- Automatic playbook matching from a `when` field. The model chooses a playbook from the skill list.
- Skip tracking with a reason, and principle citation as a thread event.
- `extends` for project playbooks.
- Principles for child sessions and workflow steps.

## Open questions

1. Should an org principle have its own org memory scope, or is a team that holds everyone enough?
2. Should a playbook replace an open plan when a person invokes it with a slash command? This pilot keeps the open plan on both paths.
3. Should the base principle let the agent write team principles without a person, or should a team principle go through review, as the concept note requires for brain changes?
4. Is a playbook anything more than a skill whose steps seed the plan? This pilot says no.
