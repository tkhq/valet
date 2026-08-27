# Skills as Commands — Design

Date: 2026-08-13
Status: approved
Supersedes: the "Prompt templates" sections of `2026-08-12-slash-commands-design.md`

## Decision

Delete the prompt-template concept. A template is a skill with a different
expansion rule, and that difference fits in one frontmatter field. One
artifact — the skill — covers both, with shared storage, sync, UI, agent
tools, and one namespace.

Rationale: templates and skills already shared 95% of their machinery
(markdown + frontmatter, slash invocation, owner scopes, repo sync, registry
precedence). The remaining 5% — the expansion function and delivery rule —
does not justify a parallel subsystem. This is the cheapest moment to
collapse the split: the slash-commands PR is unmerged and templates have no
users.

## The `invocation` frontmatter field

Every skill declares how a slash invocation expands:

```markdown
---
description: Daily standup summary
argHint: "<topic> [audience]"
invocation: prompt
---
Summarize what happened with $1 today in three bullets. Audience: $2.
```

- `invocation: context` (default when absent) — today's behavior. The body
  wraps in `<skill name="...">` tags; args append after a blank line. The
  skill is capability documentation for the agent, and it stays eligible for
  ambient context delivery (system-prompt assembly).
- `invocation: prompt` — the body IS the user's message. Slash invocation
  substitutes `$1`, `$2`, `$@`/`$ARGUMENTS`, `${@:N[:L]}` (quote-aware arg
  parsing) and sends the result bare — no `<skill>` wrapper. Prompt skills
  are EXCLUDED from ambient context delivery: a canned prompt must never
  pollute the system prompt.

The field is explicit. Expansion style is never inferred from the presence
of `$` tokens.

## Namespace

- Built-in names stay reserved. Plugin commands stay `/<plugin>:<name>`.
- Every skill registers as `/skill:<name>`, always. This applies to both
  invocation styles.
- An org-level setting (`orgs.bare_skill_commands`, default false, org-admin
  writable) additionally registers every skill under its bare `/<name>`.
  One toggle for the whole org: every member sees the same namespace.
- Bare-name collisions resolve on one axis: user > team > org > plugin >
  repo-workspace. Later registration wins in the registry; shadowing records
  a diagnostic. `/skill:<name>` always resolves regardless of shadowing.
- The per-user `users.bare_skill_commands` column, its `PATCH /api/me`
  field, and the template-vs-skill shadowing rules are deleted.

## Deletions from the slash-commands PR (pre-merge rework)

1. `user_prompt_templates` table, its CRUD routes, and their tests.
2. The template source in the command registry, `TemplateProvider`, and the
   `PromptTemplate` type.
3. `users.bare_skill_commands` and its `PATCH /api/me` handling.
4. The spec sections in `2026-08-12-slash-commands-design.md` that describe
   templates (annotated as superseded, pointing here).

Kept, repurposed:

- `parseCommandArgs`/`substituteArgs` (`commands/args.ts`) — now the
  `invocation: prompt` expansion path.
- The workspace reader for `.valet/prompts/*.md` — now emits repo-source
  skills with `invocation: prompt` (name = basename, frontmatter
  `description`/`argHint` honored). No workspace reader exists for context
  skills today; adding one is out of scope.
- Argument typeahead, `argHint` popup hints, command gates, channel
  delivery — all orthogonal, unchanged.

## Engine changes

- `SkillSource` gains `invocation?: "context" | "prompt"` (default
  "context") and `argHint?: string`.
- `dispatchCommand`'s skill arm branches on `invocation`:
  substitution-and-bare for `prompt`, wrap-and-append for `context`.
- Registry input `bareSkillNames` remains but is now fed from the org
  setting. The `templates` input and template registration order are
  removed.
- Ambient skill delivery (system-prompt assembly) filters out
  `invocation: prompt` skills.

## Org and team scopes, repo sync, UI, agent tools

The org-library features from the earlier brainstorm apply to skills
directly — no `kind` column:

- **Scopes.** The `skills` table already models `ownerType user | team |
  org`. Prompt-style skills are ordinary rows; `frontmatter` carries
  `invocation` and `argHint`. No schema change beyond what exists.
- **Repo sync.** A `skill_sources` row imports `skills/` (dirs with
  `SKILL.md`, unchanged) AND `prompts/` (flat `*.md`, one prompt skill per
  file, `invocation: prompt` implied when the file omits it). The manifest
  hash covers both directories. Malformed files record per-file warnings in
  `last_error`, as today.
- **UI.** The Skills page becomes a Library: a Skills | Prompts filter chip
  over the same list/detail/new/edit views and source-status chips. The
  editor exposes name, description, argHint, invocation, and body with a
  substitution preview for prompt-style bodies.
- **Agent tools.** `services/skills-actions.ts` actions gain an
  `invocation` filter/field; create/update/delete/list work for prompt
  skills identically. Org- and team-scoped writes require org admin / team
  membership; writes stay `require_approval` by default and ride the
  command decision-gate flow.
- **Org toggle route.** `PATCH /api/org/settings { bareSkillCommands }`
  (org admin), stored on `orgs`. Registry rebuilds pick it up at session
  build; a live session refreshes on the existing registry-refresh events.

## Precedence details

Registry registration order (later wins) for bare names when the org toggle
is on: repo-workspace → plugin → org → team → user. `/skill:` entries
register once, before bare names, keyed by the same precedence so
`/skill:<name>` resolves to the same row the bare name would.

Shared orchestrators (team/org principals) load their principal's team/org
skills and repo/plugin skills — never a personal user's rows. This replaces
the earlier "no personal command configuration" rule and closes the gap
where shared orchestrators had no templates at all.

## Error handling

- A prompt skill invoked with fewer args than its highest `$N` substitutes
  empty strings (bash convention, unchanged from templates).
- Sync skips a file whose frontmatter fails validation and records the
  reason in `last_error` (`status: "warning"`).
- The skills routes reject names colliding with built-ins:
  `"<name>" is a reserved built-in command name. Pick a different name.`

## Testing

- Engine: dispatch expansion per invocation style; registry bare-name
  precedence across all five origins; delivery filter excludes prompt
  skills; `/skill:` alias always resolves.
- API: org toggle route (admin-gated); sync imports `prompts/`; skills
  actions accept invocation; removal tests for the deleted template routes.
- Web: Library filter chip, prompt editor preview, popup argHint from skill
  frontmatter.
- `make e2e` scorecard clean before merge; the slash-commands round-trip
  suites stay green through the rework.

## Out of scope

- Typed argument schemas for prompt skills (`argsSchema` exists on skills;
  wiring it to slash args is future work).
- Per-skill visibility controls and versioning (owner scopes + source-repo
  git history cover both).
- Renaming the "skill" concept. Presentation copy may say "Prompts" for
  `invocation: prompt` skills; the artifact keeps one name.

## Deviations

Recorded at implementation time (2026-08-13):

- No ambient skill delivery exists in the engine (skills reach the model
  through invocation, not system-prompt injection), so the "exclude prompt
  skills from ambient delivery" rule is enforced by absence. Whoever adds
  ambient delivery must filter `invocation: "prompt"`.
- Org-owned skill rows deliver to org members' sessions read-only through
  `listSkills`; org writes (create, update, delete) require org admin
  through routes and agent actions alike.
- The workspace prompt scan runs only for sessions with a prep
  (`specProvider`) — a sandbox-less orchestrator never execs the scan
  because its workspace cannot contain `.valet/prompts`.
- Skills agent actions use snake_case params (`arg_hint`, `owner_type`),
  matching the existing action-parameter convention.
- (2026-08-17) Stored skills originally reached a session only at build,
  through `sessionExtras` — a cached session (the orchestrator especially)
  never saw skills created or deleted after its build, so its command list
  served only boot-time plugin skills. `CreateSessionOptions.skillsProvider`
  closes this: `Session.refreshCommandRegistry()` (every
  `GET /:id/commands`, every attachment `ready` transition) re-reads the
  stored skills through the host's `skillsProviderFor` and replaces the
  session's skill map, so the registry and `skill`-tool lookups stay
  consistent with the database.
- (2026-08-27) The web transcript renders a skill invocation as a
  collapsed skill card, not as raw message text. The `<skill>` block
  format lives in `@valet/shared` (`buildSkillBlock` /
  `sliceSkillBlock` / `parseSkillBlock`); the dispatcher builds with it
  and stamps `{ skill, skillArgs }` onto the submission's metadata, which
  the wire projects as `Message.skill`. The client recovers the card in
  fidelity order: exact slice from the stamp (delimiter-proof), whole-text
  body for a host `Thread.skill()` submission, then the anchored regex for
  rows persisted before the stamp existed. Detection is gated to user
  messages; trailing arguments render as prose below the card, and the
  message copy button yields the re-sendable `/skill:<name> <args>` form.
