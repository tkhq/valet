# Slash Commands — Design

Date: 2026-08-12
Status: approved

## Goal

Add slash commands to Valet v2. Commands work the same on every surface: web UI, Telegram, Slack, and any future channel. The engine owns dispatch. Clients only render.

Prior art: Pi's coding-agent TUI (`badlogic/pi-mono`, `packages/coding-agent`). Pi splits commands into builtins, extension commands, skill commands, and prompt templates. This design keeps that taxonomy and moves dispatch from the client into the engine, because Valet has many clients and Pi has one.

The legacy `SLASH_COMMANDS` registry in `packages/shared/src/types/index.ts` serves the frozen v1 stack only. This design does not extend it. Delete it with the rest of the legacy stack.

## Command kinds

One registry holds four command sources. A `source` field discriminates them.

### 1. Built-ins (`source: "builtin"`)

Engine code with reserved names. Initial set:

| Command | Effect |
|---|---|
| `/help` | List available commands for this session |
| `/status` | Show session status and children |
| `/stop` | Abort the current agent turn |
| `/clear` | Clear the prompt queue |
| `/model [id]` | Switch model, or list choices when no id is given |
| `/compact [instructions]` | Compact the thread context |
| `/new-thread` | Start a fresh thread in this session |
| `/sessions` | List child sessions with status |

Built-ins execute server-side. Each appends a `command_result` entry to the thread. A built-in never becomes prompt text.

### 2. Skill commands (`source: "skill"`)

`/skill:<name> [args]`. Expansion follows Pi exactly: read the skill markdown, strip frontmatter, wrap the body in a `<skill name="..." location="...">` block, append the args, then send the result down the normal prompt path.

Skills already reach the session catalog through plugins. This feature exposes them; it adds no new plumbing.

**Bare-name setting.** A per-user setting (default off) also registers each skill under its bare name (`/<name>`). A template with the same name shadows a bare skill name: user-authored beats plugin-provided. Shadowing emits a diagnostic. `/skill:<name>` always works, with or without the setting.

### 3. Prompt templates (`source: "template"`)

Bare `/name [args]`. The template body replaces the command text before the prompt path runs. Substitution supports `$1`, `$2`, `$@`, `$ARGUMENTS`, and `${@:N:L}`, with quote-aware argument parsing. Port Pi's `parseCommandArgs` and `substituteArgs` (small, pure functions in `packages/coding-agent/src/core/prompt-templates.ts`).

Two storage locations:

- **Repo:** `.valet/prompts/*.md` in the cloned workspace. Read at registry build. Before clone completes, the registry has no repo templates; it rebuilds after workspace prep.
- **User:** a new `user_prompt_templates` app table, edited in the web UI, available in every session including orchestrators.

A user template shadows a repo template with the same name. Shadowing emits a diagnostic. Frontmatter `description:` feeds autocomplete.

### 4. Plugin commands (`source: "plugin"`)

Namespaced `/<plugin>:<name>`, for example `/linear:create-issue`. Declared in a new `commands?: CommandDef[]` slot on `ValetPlugin` (`packages/engine/src/valet-plugin.ts`).

v1 is action-backed:

```ts
interface CommandDef {
  name: string;                    // command part of /<plugin>:<name>
  description: string;
  argHint?: string;                // e.g. "<title> [--team <key>]"
  action: string;                  // action id from the same plugin
  mapArgs: (args: string[], raw: string) => Record<string, unknown>;
}
```

Manifest validation rejects a `CommandDef` whose `action` does not name an action in the same plugin. Invocation runs through the existing action-policy machinery. Risk levels and approvals apply unchanged. A command is a new way to invoke an action, not a new privilege.

**Medium-term path.** A later version adds code-hook commands: a handler function that receives a scoped `CommandContext` (see Dispatch). The seam exists in v1; only the audience widens. No schema in this design changes for that step.

## Naming and collisions

- Built-in names are reserved. Registering a colliding name is a manifest validation error.
- Plugin commands and skill commands are prefix-namespaced and cannot collide across sources.
- Bare names belong to templates, plus bare skill names when the user setting is on. Templates win ties; a diagnostic records the shadowed command.

This is stricter than Pi, which filters extension commands against builtins at autocomplete time. Valet plugins self-describe, so rejection happens at manifest load instead of silent masking.

## Dispatch

Dispatch runs at the single funnel every surface uses: `Session.submitPrompt` → `Thread.submitPrompt` (`packages/engine/src/session.ts`). Before queue admission:

```
text starts with "/" and matches a registered command?
├─ no  → normal prompt; the submission result carries a nearMiss hint
│         for close matches (client may toast "did you mean …")
├─ builtin        → execute against CommandContext → command_result entry
├─ plugin (v1)    → resolve action → action-policy check → execute
│                    → command_result entry (or pending-approval result)
└─ skill/template → expand to text → existing prompt path
                     (queue admission, steer/follow-up rules untouched)
```

Semantics carried over from Pi:

- **Mid-run:** built-ins and plugin commands execute immediately, even while the agent streams or compacts. `/stop` requires this. Skill and template expansions are prompts; they queue under the existing steer/follow-up rules. Expansion happens before queueing.
- **Unknown `/word`:** passes through as prompt text. Typos are not silently eaten; the `nearMiss` hint surfaces them without blocking the send.

**`CommandContext`** is a capability interface the host assembles at session build: list models, list child sessions, abort, compact, and so on. It follows the existing host-resolver pattern (the API already injects model resolution into the engine). In v1 only built-ins receive it.

## Registry

Built per session at session build time from four inputs: engine built-ins (static), the skill catalog, templates (repo loader + user-DB loader behind a `TemplateProvider` contract, same pattern as `SpecProvider`), and plugin `CommandDef`s. The registry rebuilds on the events that already refresh skills and plugins, and after workspace prep completes.

`GET /api/sessions/:id/commands` serializes the registry: name, description, source, arg hint, diagnostics. The web UI uses it for autocomplete and `/help` rendering. Channels need nothing special: text in, entries out.

## Command-result entry

New engine entry kind `command_result` with `{ command, source, ok, output }`; `output` is markdown. Results show in history on every surface and survive reload.

The persistence round trip has four hops. Verify all four (see CLAUDE.md, "Tool-call persistence round trip"):

1. Engine writes: `Thread.handleAgentEvent` (`packages/engine/src/thread.ts`).
2. Wire ships: `engineToWireParts` (`packages/api/src/engine/bridge.ts`).
3. REST reads: `entryToMessage` (`packages/api/src/routes/messages.ts`).
4. Frontend renders: a `command-result` renderer in `packages/web/src/components/session/tool-renderers/`, registered before the fallback.

## Data changes

- `user_prompt_templates` app table: edit `packages/api/migrations/pg/0000_app.sql` in place and update the Drizzle schema (`packages/api/src/schema/index.ts`), per the pre-1.0 migration rule. Then `rm -rf ~/.valet/pg`.
- Engine `command_result` entry kind: update the raw SQL migration (`packages/store-postgres/migrations/pg/0000_engine.sql`) only if the entry envelope needs a new column; otherwise it rides the existing entries table.
- Per-user bare-skill-names setting: existing user-settings storage.
- CRUD routes for user templates plus a simple web editor.

## Error handling

Every failure is a `command_result` entry with `ok: false` and a corrective action, per the repo error-message rule:

- Unknown model id → list close matches.
- Plugin command with missing credentials → name the integration to connect in Settings.
- Template given fewer args than it references → state the expected arguments.
- Action requiring approval → say approval is pending and where to resolve it.

## Testing

- **Engine unit:** dispatch table (each source, collisions, mid-run semantics, unknown-command passthrough), template substitution (port Pi's cases), registry build and shadowing.
- **Conformance:** `command_result` round trip in the store conformance suite, PGlite and node-postgres.
- **API integration:** `GET .../commands`, user-template CRUD, an action-backed command through the approval path.
- **Web:** renderer and autocomplete against a fixture registry.
- **Done gate:** `make e2e` scorecard clean; `make smoke-session` exercises `/status` end to end; the four regression suites from the persistence round-trip rule pass.

## Out of scope

- Code-hook plugin commands (medium-term; the `CommandContext` seam anticipates them).
- Client-side commands (theme, layout). These are UI preferences, not slash commands.
- Extending the legacy v1 `SLASH_COMMANDS` registry or channels on the frozen stack.

## Deviations

These items differ from or add detail to the spec as written. All are intentional implementation decisions recorded here for accuracy.

**Command results and dispatch operate on the session's default thread.** The engine invariant is that `session.prompt()` dispatches against the session's current default thread. A command typed while a different thread is focused lands on the default thread. This follows from `Session.prompt()` being the single dispatch funnel; there is no thread-scoped command path.

**Plugin-command approvals deny by default.** A slash command is not a claimed turn and cannot suspend on a decision gate. The host has no synchronous approve path — approvals resolve asynchronously over `POST /:id/decisions/:gateId/resolve`. The `commandRequestDecision` hook seam exists in `CreateSessionOptions` but is not wired by the host. An approval-requiring plugin command therefore denies immediately. A command-scoped async approval flow is future work.

**Command-path action attachments are dropped.** `PluginActionResult.attachments` are not forwarded on the command path. A `command_result` entry has no sink for blobs or vision content. The `call_tool` (LLM turn) path still carries attachments unchanged.

**Interactive sessions only receive command providers.** `buildCommandOptions` runs only in `EngineHost.buildSession` (the interactive `sessionFor` path). Orchestrator sessions, child sessions, and workflow sessions do not receive `templateProvider`, `commandContext`, `pluginCommands`, or `pluginCatalog`. The helper is reusable; wiring it to those paths is future work.

**`PluginActionResult.data` renders as fenced JSON.** When a plugin action returns a `data` object, the command formatter writes it as a fenced `json` block. When `data` is already a string, the formatter writes it verbatim. There is no HTML or rich-content rendering path for command output.

**Bare-skill-name setting is exposed via `PATCH /api/me { bareSkillCommands }`.** The per-user toggle that registers each skill under its bare name is stored in the `users.bareSkillCommands` column and read through the standard user-settings PATCH route. The spec named the setting but did not specify its wire field name; `bareSkillCommands` is the field used in both the DB schema and the API.
