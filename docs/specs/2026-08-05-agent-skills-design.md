# Agent Skills Design — the skill format V2 targets

**Date:** 2026-08-05
**Status:** Implemented for the format, layout, validation, the `skill` tool, storage, and agent authoring. The repository importer is not built.
**Scope:** Records which skill format Valet V2 uses, where a skill is stored, how a skill reaches the model, and which parts of the format are not implemented yet.

## Context

A skill is a markdown playbook that tells the agent how to use one integration or how to do one task. Valet ships eleven of them inside plugin packages.

Valet targets the Agent Skills specification, <https://agentskills.io/specification>. The reason is interoperability: a skill written for another agent must work here, and a skill written here must work elsewhere. A format of our own would block the skill importer before it starts.

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
- A future importer reading a third-party repository must call the validator itself, report the violations, and skip that one skill. One malformed third-party skill must not stop the API process.

## Frontmatter parsing

`packages/engine/src/roles-skills/parser.ts` is a minimal parser, not a YAML library. It reads `key: value` pairs plus ONE level of nesting, which is the depth `metadata` needs. It does not read deeper nesting, lists, multi-line strings, or YAML anchors. A skill that needs any of those must wait for a real YAML parser.

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

Precedence: a plugin skill wins over a stored skill, and a personal skill wins over a team skill. `partitionByName` (`packages/api/src/plugins/assemble.ts`) applies the rule, and `/api/skills` calls the same function, so the rows the page marks `shadowed` are the rows a session drops. The Skills tab shows the warning on the card and on the skill's own page, and names the fix: ask the assistant to rename a `local` skill, and rename a `repo` skill where it came from.

## Authoring

Authoring is repository-first. A skill that a team maintains belongs in a repository, where it has review and version history, and Valet mirrors it. The importer that does the mirroring is not built yet (see Not implemented), so today the in-product path is an AGENT: you tell the orchestrator what you learned, and it stores the skill for you.

The web Skills tab reads and never writes. A form there would be a second authoring path with no history behind it, and it would compete with the repository that is meant to be authoritative. The tab lists the catalog, badges where each skill comes from, and opens one to read its body: `/skills/$skillName` for a skill addressed by name, and `/skills/stored/$skillId` for a stored skill addressed by row id, which is the only way to reach a shadowed skill.

Two write surfaces exist, and they share one implementation:

- **HTTP.** `POST /api/skills` writes a `local` skill for the caller, or for a team the caller belongs to. `GET`, `PATCH`, and `DELETE /api/skills/stored/:id` read, edit, and remove one. The routes take a row id, not a name, for the shadowing reason above. This is what the importer will use.
- **Agent actions.** `packages/api/src/services/skills-actions.ts` exposes `skills.list_skills`, `skills.create_skill`, `skills.update_skill`, and `skills.delete_skill` through the plugin catalog, registered in `providers/node.ts` beside the workflow actions.

Both call `services/skills.ts`, so ownership, team membership, and `validateSkillFrontmatter` are applied once, in one place. An agent can write a skill only for the user in its tool context, or for a team that user belongs to; a team the user is not on is reported as not found.

Every write action is `riskLevel: high`, which the plugin catalog's default policy turns into an approval gate. A stored skill is standing instruction text that every later session of that owner can pull into a turn, so a silent create or update would let anything the agent read steer its own future turns; the delete is a hard delete with no restore path. Only `skills.list_skills` is `low`.

## Valet extensions

Two things are Valet's, not the spec's. Do not present them as standard fields.

- **`argsSchema`** — an optional TypeBox schema, supplied in code by the plugin, never in frontmatter.
- **`{{placeholder}}` rendering** — `renderTemplate` fills placeholders from the caller's arguments. An unknown placeholder stays as written, so an authoring error is visible instead of silent.

An imported skill uses neither. Both stay because Valet's own skills and `Thread.skill()` depend on them.

## Not implemented

- **Bundled resources.** A spec skill may ship `scripts/`, `references/`, and `assets/`. Valet reads `SKILL.md` and nothing else. A skill body that points at `references/REFERENCE.md` leaves the agent with a path it cannot open.
- **Resource-level progressive disclosure.** Point 3 of the spec's disclosure model (load a bundled file when it is needed) needs the resource loading above.
- **`allowed-tools` enforcement.** The field is parsed and carried. Nothing acts on it. The spec marks it experimental.
- **Repository import and sync.** The `skills` table carries `origin='repo'`, `source_id`, and `upstream_path` for it, but there is no `skill_sources` table, no importer, and no scheduler. Nothing writes a `repo` row today. `github.list_repo_directory` plus `github.read_repo_file` are the read primitives an importer will compose: list the repository root to find skill directories, then read each `<directory>/SKILL.md`. An importer must call `validateSkillFrontmatter` itself and skip the skills that fail, because `loadSkillFromMarkdown` throws.
- **Org-wide skills.** `owner_type` accepts `org`, and delivery reads an `org` principal's rows, but no route creates one. An org-wide skill needs an admin gate first.
- **`argsSchema` on a stored skill.** Only a plugin can supply one, because it is code, not frontmatter. A stored skill takes no arguments.
