# Agent Skills Design — the skill format V2 targets

**Date:** 2026-08-05
**Status:** Implemented for the format, layout, validation, the `skill` tool, storage, authoring from both the Skills tab and the agent actions, and repository sync from public repositories.
**Scope:** Records which skill format Valet V2 uses, where a skill is stored, how a skill reaches the model, how a repository's skills are mirrored and kept in step, and which parts of the format are not implemented yet.

## Context

A skill is a markdown playbook that tells the agent how to use one integration or how to do one task. Valet ships eleven of them inside plugin packages.

Valet targets the Agent Skills specification, <https://agentskills.io/specification>. The reason is interoperability: a skill written for another agent must work here, and a skill written here must work elsewhere. A format of our own would block repository sync before it starts.

Before this change the skills were flat files in a shared `skills/` directory, no code validated them, and nothing let the model read one. All three are now closed.

## Layout

One skill is one directory. The directory name is the skill name.

```
packages/plugin-github/skills/
└── github/
    └── SKILL.md
```

The plugin manifest reads its own `SKILL.md` and passes the directory name to `loadSkillFromMarkdown`:

```ts
const skillMd = readFileSync(new URL("../skills/github/SKILL.md", import.meta.url), "utf8");
skills: [loadSkillFromMarkdown(skillMd, "plugin", "github")];
```

There is no directory scanner. Each plugin names the file it loads, so a new skill needs an explicit line in the plugin manifest.

## Frontmatter

`SKILL.md` starts with YAML frontmatter. Valet reads every field the spec defines:

| Field | Required | Constraint | Where it lands |
|---|---|---|---|
| `name` | yes | 1–64 characters, lowercase `a-z0-9` and `-`, no leading, trailing, or consecutive hyphen, equal to the directory name | `SkillSource.name` |
| `description` | yes | 1–1024 characters, not empty | `SkillSource.description` |
| `license` | no | text | `SkillSource.license` |
| `compatibility` | no | at most 500 characters | `SkillSource.compatibility` |
| `metadata` | no | a map of text keys to text values | `SkillSource.metadata` |
| `allowed-tools` | no | space-separated text | `SkillSource.allowedTools` |

The hyphenated YAML key `allowed-tools` becomes the camelCase property `allowedTools`. No Valet type carries a hyphenated key.

`validateSkillFrontmatter` (`packages/engine/src/roles-skills/spec.ts`) checks all of these. It is pure: it does no file I/O, and it takes the directory name as an input so the name-matches-directory rule can be checked without a file system.

The validator RETURNS violations. The caller decides how loud a violation is:

- `loadSkillFromMarkdown` throws. Every caller today is a plugin that loads a skill we ship, so a violation there is a build-time bug.
- Repository sync calls the validator itself, reports the violations as warnings, and skips that one skill. One malformed third-party skill must not stop the API process, and must not stop the rest of its repository from being mirrored.

## Frontmatter parsing

`packages/engine/src/roles-skills/parser.ts` is a minimal parser, not a YAML library. It reads three shapes:

1. `key: value` pairs.
2. ONE level of nesting, which is the depth `metadata` needs.
3. Block scalars — `|`, `|-`, `|+`, `>`, `>-`, and `>+`.

Block scalars are how a real `SKILL.md` writes a description that is longer than one line, so the parser cannot skip them. The block is the more-indented lines that follow the header. The parser dedents them by the indentation of the block's own first line, not by a fixed two spaces. A literal block (`|`) keeps the line breaks. A folded block (`>`) joins the lines with spaces, and keeps a line break where an empty line or a deeper-indented line sits. The chomping indicator changes the TRAILING newline only: `-` strips it, `+` keeps it and every trailing empty line, and no indicator clips the block to exactly one. The key that comes back at the parent indentation ends the block and is read as a key again.

The parser does not read deeper nesting, lists, quoted multi-line flow scalars, explicit indentation indicators (`|2`), or YAML anchors. A skill that needs any of those must wait for a real YAML parser.

`description` is the field every turn pays for, and the field the model reads to choose a skill, so a description the parser could not read must be loud. `validateSkillFrontmatter` rejects a description that is only a block scalar header. Without that rule the skill loads with `|-` for its description, passes every other check, and no model ever finds it.

## How a skill reaches the model

Skills use progressive disclosure, as the spec describes:

1. The `skill` tool's description carries the name and the one-line description of every installed skill. That is what every turn pays for.
2. The model calls `skill` with a name, and the tool returns that skill's markdown body.
3. The body stays in context: `"skill"` is in `DEFAULT_PROTECTED_TOOLS` and the ToolDef sets `protectedFromPruning`, so compaction cannot drop the instructions the turn is following.

`packages/api/src/plugins/skill-tool.ts` builds the tool. `pluginSessionExtras` appends it to the session's tools whenever the assembled set holds at least one skill.

`GET /api/skills` and the web Skills tab read the same two sources a session build reads, so the catalog a person browses is the catalog the agent can request.

## Storage

A skill has two possible homes. A plugin skill lives in a plugin package and is the same for everyone. A stored skill lives in the `skills` table and belongs to one owner.

The table splits the markdown in two: `content` holds the body, and `frontmatter` holds the parsed frontmatter map. The split is what keeps a bad row from breaking a session. Delivery reads `name`, `description`, and `content` as plain columns, so it never parses and never throws. Every frontmatter rule is checked once, on write, through the same `validateSkillFrontmatter` the plugin loader uses.

`origin` says where a stored skill came from: `local` for one written in the product, `repo` for one synced from a repository. Only `local` skills can be edited here. A `repo` skill belongs to its repository, and an edit here would be overwritten by the next sync.

Access follows workflow definitions exactly (`packages/api/src/services/skills.ts`): your own rows, plus the rows of every team you belong to, with membership re-read on every call. A row another owner holds is reported as not found, never as forbidden, so an owned row and a missing row stay indistinguishable.

A UNIQUE index on `(org_id, owner_type, owner_id, name)` stops two stored skills sharing a name inside one owner scope.

## Delivery

`EngineHost.sessionExtras` is the one seam that assembles a session's skills. All four session builders call it, and each passes the session's OWN principal:

| Builder | Principal | Why |
|---|---|---|
| `buildSession` | `{ user, meta.userId }` | `SessionMeta` carries no principal, and the builder passes no `owner`, so the engine defaults the session's principal to exactly this. |
| `buildOrchestratorSession` | the `principal` argument | The session belongs to that principal and is shared by everyone who can reach it, same as its memory snapshot. |
| `buildChildSession` | `opts.owner` | The child's own principal, copied from its parent. |
| `buildWorkflowSession` | `opts.owner` | The run's principal, copied from the workflow definition at start time. |

A `user` principal reads its own skills plus its teams' skills. A `team` or `org` principal reads only that team's or org's skills, so one member's personal skills never appear in a session other members read.

## Two skills, one name

A skill name is a lookup key, so only one skill can hold a name. A repeated name has two rules, and they differ on purpose:

- Two PLUGINS shipping one skill name THROWS. We ship the plugins, so a repeated name is a build-time bug and must be loud.
- A STORED skill that repeats a name is SHADOWED. The row stays, and it drops out of the assembled set. It never throws: no session builder has a try/catch, so a throw would stop that person from starting any session at all.

Precedence: a plugin skill wins over a stored skill, and a personal skill wins over a team skill. `partitionByName` (`packages/api/src/plugins/assemble.ts`) applies the rule, and `/api/skills` calls the same function, so the rows the page marks `shadowed` are the rows a session drops. The Skills tab shows the warning on the card and on the skill's own page, and names the fix: rename a `local` skill on its own page, and rename a `repo` skill where it came from.

## Authoring

A skill is written in the product, or mirrored from a repository. The two paths hold different kinds of skills: a person or an agent writes a `local` skill here, and a tracked repository fills `repo` rows that only sync writes. A team that wants review and version history behind a skill keeps it in a repository and lets Valet mirror it.

A person writes a skill on the web Skills tab. `/skills/new` opens an empty editor, and `/skills/stored/$skillId` reads a stored skill and edits or removes it. The body is written in the split markdown editor the memory explorer uses, so the rendering sits beside the text. The three fields are the whole skill: `name` and `description` are its frontmatter, and the body is the markdown the agent reads. A new skill belongs to the author, or to a team they are on. The repositories panel above the grid points Valet at a repository to mirror; it never edits a skill.

The tab addresses a stored skill by row id rather than by name, because a shadowed skill shares its name with the skill that shadows it — only the id reaches it. `/skills/$skillName` reads a skill by name, which is how a plugin skill is opened.

A `repo` skill is read-only on that page: no Edit, no Delete. The next sync would overwrite an edit made here, so the page says where to change it instead. That is the same rule `SkillNotLocalError` enforces in the service, so the page and the API never disagree.

- **HTTP.** `POST /api/skills` writes a `local` skill for the caller, or for a team the caller belongs to. `GET`, `PATCH`, and `DELETE /api/skills/stored/:id` read, edit, and remove one. The routes take a row id, not a name, for the shadowing reason above. `POST`, `GET`, and `DELETE /api/skills/sources` add, list, and remove a tracked repository, and `POST /api/skills/sources/:id/sync` re-reads one now.
- **Agent actions.** `packages/api/src/services/skills-actions.ts` exposes `skills.list_skills`, `skills.create_skill`, `skills.update_skill`, and `skills.delete_skill` through the plugin catalog, registered in `providers/node.ts` beside the workflow actions.

Three write surfaces exist, and they share one implementation:

- **HTTP.** `POST /api/skills` writes a `local` skill for the caller, or for a team the caller belongs to. `GET`, `PATCH`, and `DELETE /api/skills/stored/:id` read, edit, and remove one.
- **The web Skills tab.** The HTTP surface with an editor on it. It adds no rule of its own.
- **Agent actions.** `packages/api/src/services/skills-actions.ts` exposes `skills.list_skills`, `skills.create_skill`, `skills.update_skill`, and `skills.delete_skill` through the plugin catalog, registered in `providers/node.ts` beside the workflow actions. This is how a skill comes out of a conversation: you tell the orchestrator what you learned, and it stores the skill for you.

All three call `services/skills.ts`, so ownership, team membership, and `validateSkillFrontmatter` are applied once, in one place. An agent can write a skill only for the user in its tool context, or for a team that user belongs to; a team the user is not on is reported as not found.

An update and a delete carry their authority on the statement that changes the row, not only on the read before it: the predicate repeats the owner, and for a team-owned skill it re-asks whether the caller is still a member. Membership can be revoked between the two statements, and that is the one authority answer that can go stale.

Every write action is `riskLevel: high`, which the plugin catalog's default policy turns into an approval gate. A stored skill is standing instruction text that every later session of that owner can pull into a turn, so a silent create or update would let anything the agent read steer its own future turns; the delete is a hard delete with no restore path. Only `skills.list_skills` is `low`.

## Valet extensions

Two things are Valet's, not the spec's. Do not present them as standard fields.

- **`argsSchema`** — an optional TypeBox schema, supplied in code by the plugin, never in frontmatter.
- **`{{placeholder}}` rendering** — `renderTemplate` fills placeholders from the caller's arguments. An unknown placeholder stays as written, so an authoring error is visible instead of silent.

An imported skill uses neither. Both stay because Valet's own skills and `Thread.skill()` depend on them.

## Not implemented

- **Bundled resources.** A spec skill may ship `scripts/`, `references/`, and `assets/`. Sync reads `SKILL.md` and nothing else. A skill body that points at `references/REFERENCE.md` leaves the agent with a path it cannot open. Carrying those files needs its own table, and `github.read_repo_file` decodes as UTF-8, so it cannot carry a binary asset either.
- **Resource-level progressive disclosure.** Point 3 of the spec's disclosure model (load a bundled file when it is needed) needs the resource loading above.
- **`allowed-tools` enforcement.** The field is parsed and carried. Nothing acts on it. The spec marks it experimental.
- **Directories of 500 entries or more.** Sync reads one level of the tracked directory through GitHub's contents endpoint and keeps 500 entries. A listing that reaches that cut fails the sync and reconciles nothing, because the entries past it cannot be told apart from skills the repository no longer holds. Track a subdirectory that fits under the cut.
- **Private and authenticated repositories.** See the scope line in Repository sync above. The missing piece is a repo-authority check, not the transport.
- **Write-back.** Sync reads. Nothing pushes a locally written skill into a repository.
- **Org-wide skills.** `owner_type` accepts `org`, and delivery reads an `org` principal's rows, but no route creates one. An org-wide skill needs an admin gate first.
- **`argsSchema` on a stored skill.** Only a plugin can supply one, because it is code, not frontmatter. A stored skill takes no arguments.
