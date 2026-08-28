---
name: assistants
description: Manage assistant profiles (names, personas, behavior configs, defaults) and the skill library with the assistants and skills actions.
---

# Assistant & Skill Management

## Concepts

### Assistants

An assistant is a named agent a person or a team owns. A principal can own
several; exactly one is the **default**, the one automations target when
they name only the owner. An assistant's profile has:

- **Name** — shown in the sidebar and injected into its persona.
- **Personality** — persona text. At wake the session's system prompt opens
  with `You are {name}. {personality}`. No name means no persona prefix.
- **Behavior** — which skills and integrations the assistant's sessions get:

```json
{
  "skills": { "mode": "allowlist", "names": ["deploy-checklist"] },
  "integrations": {
    "mode": "allowlist",
    "entries": [{ "service": "github", "excludeActions": ["github.delete_repo"] }]
  }
}
```

`{ "mode": "all" }` (or an absent field) means everything. Behavior is
capability shaping, not a security boundary — action policies and approval
gates stay the enforcement layer. Pinned actions and memory tools are never
gated.

### Skills

Skills are markdown documents that teach an agent how to perform a task.
List them with `skills.list_skills`; read one into the turn with the
`skill` tool. A skill from a plugin or a repository is read-only; a stored
skill belongs to its owner.

## Actions

Profile management (each write asks for approval unless a policy allows it):

- `assistants.list_assistants` — every assistant you can reach: your own,
  plus each team you belong to. Start here; the other actions take the
  `assistant_id` this returns.
- `assistants.create_assistant` — `{ name, team_id?, personality?, behavior? }`.
  Creating for a team requires administering that team.
- `assistants.update_assistant` — `{ assistant_id, name?, personality?,
  behavior?, is_default? }`. `null` clears name or personality; behavior
  `null` clears back to everything; `is_default: true` promotes (the old
  default is demoted in the same write). A change reaches the assistant's
  NEXT wake — the current turn finishes on the old profile.
- `assistants.archive_assistant` — hides the assistant; its conversation
  stays readable. The default cannot be archived; promote another first.

Skill library:

- `skills.list_skills` — stored skills you can reach (names, not bodies).
- `skills.create_skill` — `{ name, content, team_id? }`.
- `skills.update_skill` — `{ skill_id, ... }`.
- `skills.delete_skill` — repository-synced skills must be removed in
  their repository.

## Common workflows

### Give a team a specialized assistant

1. Create the domain skill:
   `skills.create_skill(name: "frontend-review", content: "# Standards…", team_id: "<team>")`
2. Create the assistant with a persona and a scoped behavior:
   `assistants.create_assistant(name: "Reviewer", team_id: "<team>", personality: "Terse. Cites the standards doc.", behavior: { "skills": { "mode": "allowlist", "names": ["frontend-review"] } })`
3. Promote it if automations should target it:
   `assistants.update_assistant(assistant_id: "<id>", is_default: true)`

### Adjust your own persona

Call `assistants.list_assistants`, find your row (it carries your session),
then `assistants.update_assistant` with the new `personality`. Your CURRENT
turn keeps its persona; the change applies from your next wake. Do not edit
`assistant/personality.md` in memory for this — the profile column wins
over that file once it is set.
