# Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute in an isolated worktree created via superpowers:using-git-worktrees.

**Goal:** Engine-owned slash commands (built-ins, skills, templates, action-backed plugin commands) that work identically on web and channel surfaces.

**Architecture:** A `CommandRegistry` assembled per session dispatches inside `Session.prompt` before queue admission. Built-ins and plugin commands execute server-side and append a new `command_result` entry; skills and templates expand to prompt text. The API serializes the registry for autocomplete; the web adds a renderer and composer popup.

**Tech Stack:** TypeScript, Hono, Drizzle, PGlite/node-postgres, React 19 + TanStack Query, vitest.

**Spec:** `docs/specs/2026-08-12-slash-commands-design.md` — read it first.

## Global Constraints

- Node 22 (`nvm use 22`); `WebSocket is not defined` failures = wrong Node.
- No `any`; no `as unknown as T`; no `@ts-ignore`.
- Pre-1.0 migrations: edit `0000_app.sql` / `0000_engine.sql` in place; after editing run `rm -rf ~/.valet/pg`.
- Commit subjects ≤72 chars; one commit per task.
- All prose (errors, docs) in ASD-STE100 style; every user-facing error names the corrective action.
- Update `docs/specs/2026-08-12-slash-commands-design.md` in the same commit if implementation deviates.
- Built-in command names are reserved: `help`, `status`, `stop`, `clear`, `model`, `compact`, `new-thread`, `sessions`.

---

### Task 1: Engine command types + `command_result` entry kind

**Files:**
- Create: `packages/engine/src/commands/types.ts`
- Modify: `packages/engine/src/types.ts` (entry union ~line 394, `PromptReceipt`)
- Modify: `packages/engine/src/index.ts` (re-export)
- Test: `packages/engine/src/commands/types.test.ts`, extend the in-memory store entry round-trip suite

**Interfaces:**
- Produces: `CommandSource`, `CommandInfo`, `CommandDef`, `PromptTemplate`, `TemplateProvider`, `CommandContext`, `CommandResultEntry` — every later task consumes these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/commands/types.test.ts
import { describe, expect, it } from "vitest";
import type { CommandResultEntry } from "../types.js";

describe("command_result entry", () => {
  it("round-trips through the in-memory store", async () => {
    // use the existing in-memory store test helpers (see in-memory-store suite)
    const entry: CommandResultEntry = {
      id: "e1", createdAt: 1, type: "command_result",
      command: "/status", source: "builtin", ok: true, output: "**idle**",
    };
    const store = makeInMemoryStore(); // same helper the in-memory-store suite uses
    await store.appendEntries("s1", "t1", [entry]);
    const read = await store.listEntries("s1", "t1");
    const got = read.find((e) => e.type === "command_result");
    expect(got?.type).toBe("command_result");
    expect(got && got.type === "command_result" ? got.output : "").toBe("**idle**");
  });
});
```

Match the `BaseEntry` fields and store helper names to the existing in-memory-store suite — copy its setup verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/engine test -- commands/types`
Expected: FAIL — `command_result` is not a valid entry type.

- [ ] **Step 3: Implement**

In `packages/engine/src/commands/types.ts`:

```ts
import type { SkillSource } from "../types.js";

export type CommandSource = "builtin" | "skill" | "template" | "plugin";

export interface CommandInfo {
  /** Invocation name without the leading slash: "status", "skill:review", "linear:create-issue". */
  name: string;
  description: string;
  source: CommandSource;
  argHint?: string;
}

export interface RegistryDiagnostic { name: string; message: string }

/** Action-backed plugin command (v1). Declared in ValetPlugin.commands. */
export interface CommandDef {
  name: string;
  description: string;
  argHint?: string;
  /** Action id from the same plugin. Validated at manifest load. */
  action: string;
  mapArgs: (args: string[], raw: string) => Record<string, unknown>;
}

export interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
  origin: "repo" | "user";
}

/** Host-injected template sources. Same injection pattern as SpecProvider. */
export interface TemplateProvider {
  listTemplates(): Promise<PromptTemplate[]>;
}

/** Host capabilities for built-ins the engine cannot answer alone. */
export interface CommandContext {
  listModels(): Promise<Array<{ id: string; name: string }>>;
  listChildSessions(): Promise<Array<{ id: string; title?: string; status: string }>>;
}

export type ResolvedCommand =
  | { source: "builtin"; name: string }
  | { source: "skill"; skill: SkillSource; bare: boolean }
  | { source: "template"; template: PromptTemplate }
  | { source: "plugin"; pluginName: string; def: CommandDef };
```

In `packages/engine/src/types.ts`: add the entry interface next to `DecisionGateEntry` and widen the union:

```ts
export interface CommandResultEntry extends BaseEntry {
  type: "command_result";
  command: string;          // as typed, with leading slash
  source: import("./commands/types.js").CommandSource;
  ok: boolean;
  output: string;           // markdown
}

export type SessionEntry =
  | MessageEntry | CompactionEntry | BranchSummaryEntry
  | DecisionGateEntry | CommandResultEntry;
```

Extend `PromptReceipt` with two optional fields:

```ts
  /** Set when the submission was handled as a command and no prompt was queued. */
  command?: { name: string; source: import("./commands/types.js").CommandSource };
  /** Set when an unknown /word passed through as prompt text; closest registered name. */
  nearMiss?: string;
```

Re-export the commands module from `packages/engine/src/index.ts`. Fix every switch over `SessionEntry` that the compiler now flags (exhaustiveness errors are the point of this step).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/engine test -- commands/types && pnpm --filter @valet/engine test -- in-memory-store && pnpm --filter @valet/engine typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(engine): command types and command_result entry kind`

---

### Task 2: Port Pi's argument parsing and substitution

**Files:**
- Create: `packages/engine/src/commands/args.ts`
- Test: `packages/engine/src/commands/args.test.ts`

**Interfaces:**
- Produces: `parseCommandArgs(argsString: string): string[]`, `substituteArgs(content: string, args: string[]): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "./args.js";

describe("parseCommandArgs", () => {
  it("splits on whitespace", () => expect(parseCommandArgs("a b  c")).toEqual(["a", "b", "c"]));
  it("respects double quotes", () => expect(parseCommandArgs('a "b c" d')).toEqual(["a", "b c", "d"]));
  it("respects single quotes", () => expect(parseCommandArgs("x 'y z'")).toEqual(["x", "y z"]));
  it("handles empty input", () => expect(parseCommandArgs("")).toEqual([]));
});

describe("substituteArgs", () => {
  it("replaces positional args", () => expect(substituteArgs("fix $1 in $2", ["bug", "auth"])).toBe("fix bug in auth"));
  it("missing positional becomes empty", () => expect(substituteArgs("$1/$2", ["a"])).toBe("a/"));
  it("replaces $@ and $ARGUMENTS", () => {
    expect(substituteArgs("all: $@", ["a", "b"])).toBe("all: a b");
    expect(substituteArgs("all: $ARGUMENTS", ["a", "b"])).toBe("all: a b");
  });
  it("slices ${@:N} and ${@:N:L}", () => {
    expect(substituteArgs("${@:2}", ["a", "b", "c"])).toBe("b c");
    expect(substituteArgs("${@:1:2}", ["a", "b", "c"])).toBe("a b");
  });
  it("does not re-substitute arg values", () =>
    expect(substituteArgs("$1", ["$2"])).toBe("$2"));
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/engine test -- commands/args` → FAIL (module not found).

- [ ] **Step 3: Implement**

Port verbatim from Pi (`/tmp/pi-mono/packages/coding-agent/src/core/prompt-templates.ts`, functions `parseCommandArgs` and `substituteArgs` — clone with `git clone --depth 1 https://github.com/tomooshi/pi-mono /tmp/pi-mono` if absent). Preserve Pi's substitution order: positional `$<digit>` first, then `${@:N[:L]}`, then `$@`/`$ARGUMENTS`. Keep functions pure; no imports beyond none.

- [ ] **Step 4: Run tests** — same filter → PASS.

- [ ] **Step 5: Commit** — `feat(engine): command arg parsing and template substitution`

---

### Task 3: `commands` slot on ValetPlugin + manifest validation

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (interface line ~214, `validateValetPlugin` ~243)
- Test: extend the existing valet-plugin validation test file

**Interfaces:**
- Consumes: `CommandDef` (Task 1).
- Produces: `ValetPlugin.commands?: CommandDef[]`, validated: name matches `/^[a-z][a-z0-9-]*$/`, not a reserved built-in, `action` names an action in the same plugin, `mapArgs` is a function.

- [ ] **Step 1: Failing tests** (add to the existing validation suite, matching its fixture style):

```ts
it("accepts a valid command referencing an own action", () => {
  const plugin = basePlugin({
    actions: [actionPluginFixture({ service: "linear", actions: [pluginAction({ id: "create-issue" })] })],
    commands: [{ name: "create-issue", description: "Create a Linear issue", action: "create-issue", mapArgs: (a) => ({ title: a[0] }) }],
  });
  expect(validateValetPlugin(plugin).ok).toBe(true);
});

it("rejects a command naming a missing action", () => {
  const r = validateValetPlugin(basePlugin({ commands: [{ name: "x", description: "d", action: "nope", mapArgs: () => ({}) }] }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].path).toBe("commands[0].action");
});

it("rejects a reserved built-in name", () => {
  const r = validateValetPlugin(basePlugin({ commands: [{ name: "status", description: "d", action: "a", mapArgs: () => ({}) }] }));
  expect(r.ok).toBe(false);
});
```

Use the suite's existing fixture helpers; if none exist for actions, build full literal objects (no double-casts).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/engine test -- valet-plugin` → FAIL.

- [ ] **Step 3: Implement**

Add `commands?: CommandDef[];` to `ValetPlugin`. Export the reserved list from `commands/types.ts`:

```ts
export const BUILTIN_COMMAND_NAMES = ["help", "status", "stop", "clear", "model", "compact", "new-thread", "sessions"] as const;
```

In `validateValetPlugin`, follow the `checkArray` pattern used for `actions` (lines ~262-293):

```ts
checkArray(v.commands, "commands", issues, (cmd, path) => {
  if (!isRecord(cmd)) { issues.push({ path, message: "must be an object" }); return; }
  if (typeof cmd.name !== "string" || !NAME_RE.test(cmd.name))
    issues.push({ path: `${path}.name`, message: `must match ${NAME_RE.source}` });
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(cmd.name as string))
    issues.push({ path: `${path}.name`, message: `"${cmd.name}" is a reserved built-in command name` });
  if (typeof cmd.description !== "string" || !cmd.description)
    issues.push({ path: `${path}.description`, message: "must be a non-empty string" });
  if (typeof cmd.mapArgs !== "function")
    issues.push({ path: `${path}.mapArgs`, message: "must be a function" });
  const actionIds = new Set(
    (Array.isArray(v.actions) ? v.actions : []).flatMap((ap) =>
      isRecord(ap) && Array.isArray(ap.actions) ? ap.actions.map((a) => (isRecord(a) ? a.id : undefined)) : []),
  );
  if (typeof cmd.action !== "string" || !actionIds.has(cmd.action))
    issues.push({ path: `${path}.action`, message: `must name an action declared by this plugin` });
});
```

Adapt helper names (`isRecord`, `NAME_RE`) to what the file actually exports.

- [ ] **Step 4: Run** — same filter + `pnpm --filter @valet/engine typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(engine): commands slot on ValetPlugin with validation`

---

### Task 4: CommandRegistry build, collisions, shadowing

**Files:**
- Create: `packages/engine/src/commands/registry.ts`
- Test: `packages/engine/src/commands/registry.test.ts`

**Interfaces:**
- Consumes: `CommandInfo`, `ResolvedCommand`, `PromptTemplate`, `CommandDef`, `SkillSource`, `BUILTIN_COMMAND_NAMES`.
- Produces:

```ts
export interface BuildRegistryInput {
  skills: SkillSource[];
  templates: PromptTemplate[];
  pluginCommands: Array<{ pluginName: string; def: CommandDef }>;
  bareSkillNames: boolean;
}
export interface CommandRegistry {
  list(): CommandInfo[];
  diagnostics(): RegistryDiagnostic[];
  resolve(name: string): ResolvedCommand | undefined;
  nearMiss(name: string): string | undefined;
}
export function buildCommandRegistry(input: BuildRegistryInput): CommandRegistry;
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { buildCommandRegistry } from "./registry.js";

const skill = { name: "review", description: "Review code", content: "# Review\ndo it" };
const tmpl = (name: string, origin: "repo" | "user") => ({ name, content: `body-${origin}`, origin });

describe("buildCommandRegistry", () => {
  it("registers built-ins, prefixed skills, templates, namespaced plugin commands", () => {
    const r = buildCommandRegistry({
      skills: [skill], templates: [tmpl("standup", "repo")],
      pluginCommands: [{ pluginName: "linear", def: { name: "create-issue", description: "d", action: "create-issue", mapArgs: () => ({}) } }],
      bareSkillNames: false,
    });
    expect(r.resolve("status")?.source).toBe("builtin");
    expect(r.resolve("skill:review")?.source).toBe("skill");
    expect(r.resolve("standup")?.source).toBe("template");
    expect(r.resolve("linear:create-issue")?.source).toBe("plugin");
    expect(r.resolve("review")).toBeUndefined(); // bare names off
  });

  it("user template shadows repo template, with diagnostic", () => {
    const r = buildCommandRegistry({ skills: [], templates: [tmpl("x", "repo"), tmpl("x", "user")], pluginCommands: [], bareSkillNames: false });
    const resolved = r.resolve("x");
    expect(resolved?.source === "template" && resolved.template.origin).toBe("user");
    expect(r.diagnostics().some((d) => d.name === "x")).toBe(true);
  });

  it("template shadows bare skill name when the setting is on", () => {
    const r = buildCommandRegistry({ skills: [skill], templates: [tmpl("review", "user")], pluginCommands: [], bareSkillNames: true });
    expect(r.resolve("review")?.source).toBe("template");
    expect(r.resolve("skill:review")?.source).toBe("skill"); // prefixed always works
    expect(r.diagnostics().some((d) => d.name === "review")).toBe(true);
  });

  it("suggests near misses", () => {
    const r = buildCommandRegistry({ skills: [], templates: [], pluginCommands: [], bareSkillNames: false });
    expect(r.nearMiss("statsu")).toBe("status");
    expect(r.nearMiss("zzzzzz")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure** — `pnpm --filter @valet/engine test -- commands/registry` → FAIL.

- [ ] **Step 3: Implement**

Build a `Map<string, ResolvedCommand>`: built-ins first (from `BUILTIN_COMMAND_NAMES`, descriptions inline), then plugin commands under `${pluginName}:${def.name}`, then skills under `skill:${name}` (and bare `${name}` when `bareSkillNames`), then templates bare — repo first, user second so user overwrites; record a diagnostic whenever a bare-name `set` overwrites (template-over-template, template-over-bare-skill). `nearMiss` = Levenshtein distance ≤ 2 over registered names (write a small local `levenshtein(a, b)`; no dependency).

- [ ] **Step 4: Run** — PASS + typecheck.

- [ ] **Step 5: Commit** — `feat(engine): command registry with collision and shadowing rules`

---

### Task 5: Dispatcher — parse, expand, pass through

**Files:**
- Create: `packages/engine/src/commands/dispatch.ts`
- Test: `packages/engine/src/commands/dispatch.test.ts`

**Interfaces:**
- Consumes: `CommandRegistry`, `parseCommandArgs`, `substituteArgs`.
- Produces:

```ts
export type DispatchOutcome =
  | { kind: "pass"; nearMiss?: string }                       // not a command; send text as-is
  | { kind: "expand"; text: string }                          // skill/template expansion
  | { kind: "execute"; resolved: ResolvedCommand; args: string[]; raw: string }; // builtin/plugin
export function dispatchCommand(text: string, registry: CommandRegistry): DispatchOutcome;
```

- [ ] **Step 1: Failing tests**

```ts
it("passes plain text through", () =>
  expect(dispatchCommand("hello", reg).kind).toBe("pass"));
it("passes unknown /word with a nearMiss", () => {
  const o = dispatchCommand("/statsu", reg);
  expect(o).toEqual({ kind: "pass", nearMiss: "status" });
});
it("routes built-ins to execute with parsed args", () => {
  const o = dispatchCommand('/model claude-opus-4-8', reg);
  expect(o.kind).toBe("execute");
  if (o.kind === "execute") expect(o.args).toEqual(["claude-opus-4-8"]);
});
it("expands a skill command into a skill block with args appended", () => {
  const o = dispatchCommand("/skill:review src/", regWithSkill);
  expect(o.kind).toBe("expand");
  if (o.kind === "expand") {
    expect(o.text).toContain('<skill name="review"');
    expect(o.text.endsWith("src/")).toBe(true);
  }
});
it("expands a template with substitution", () => {
  // template "fix" content: "Fix $1 with priority $2"
  const o = dispatchCommand('/fix auth "P1 high"', regWithTemplate);
  if (o.kind === "expand") expect(o.text).toBe("Fix auth with priority P1 high");
});
it("multi-line text starting with / only matches on the first line's first token", () =>
  expect(dispatchCommand("/status\nand more", reg).kind).toBe("execute"));
```

Build registries via `buildCommandRegistry` with literal fixtures.

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement**

Command token = text up to the first whitespace, minus the leading `/`; remainder is `raw`. Skill expansion (Pi-parity, content is already in `SkillSource.content` so no file read):

```ts
const block = `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`;
return { kind: "expand", text: raw ? `${block}\n\n${raw}` : block };
```

Template expansion: `substituteArgs(template.content, parseCommandArgs(raw))`. Builtin/plugin → `{ kind: "execute", resolved, args: parseCommandArgs(raw), raw }`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** — `feat(engine): slash command dispatcher`

---

### Task 6: Built-ins + Session integration

**Files:**
- Create: `packages/engine/src/commands/builtins.ts`
- Modify: `packages/engine/src/session.ts` (`prompt` at ~580; new `commandRegistry()` accessor; `CreateSessionOptions` gains `commandContext?: CommandContext`, `templateProvider?: TemplateProvider`, `bareSkillNames?: boolean`)
- Modify: `packages/engine/src/types.ts` (`CreateSessionOptions` additions)
- Test: `packages/engine/src/commands/builtins.test.ts` + a session-level dispatch test beside the happy-path suite

**Interfaces:**
- Consumes: everything above; `Session.setModel`, thread abort/queue/compact APIs, `Session.skills`.
- Produces: `executeBuiltin(name, args, session, ctx): Promise<{ ok: boolean; output: string }>`; `Session.prompt` intercepts commands and appends `CommandResultEntry` for execute-kind outcomes.

- [ ] **Step 1: Failing tests** (fake `CommandContext`, real in-memory session via the happy-path suite's helpers):

```ts
const ctx: CommandContext = {
  listModels: async () => [{ id: "claude-opus-4-8", name: "Opus 4.8" }],
  listChildSessions: async () => [{ id: "c1", title: "child", status: "idle" }],
};

it("/help lists every registered command", async () => {
  const r = await executeBuiltin("help", [], session, ctx);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("/status");
  expect(r.output).toContain("/skill:");
});
it("/model with no args lists choices", async () => {
  const r = await executeBuiltin("model", [], session, ctx);
  expect(r.output).toContain("claude-opus-4-8");
});
it("/model with an unknown id fails with close matches", async () => {
  const r = await executeBuiltin("model", ["claude-oups"], session, ctx);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("claude-opus-4-8");
});
it("session.prompt('/status') appends a command_result entry and queues nothing", async () => {
  const receipt = await session.prompt("/status");
  expect(receipt.command).toEqual({ name: "status", source: "builtin" });
  const entries = await store.listEntries(session.id, threadId);
  expect(entries.at(-1)?.type).toBe("command_result");
  // queue depth unchanged — assert via the queue-state helper the happy-path suite uses
});
it("unknown /word queues as a normal prompt with nearMiss on the receipt", async () => {
  const receipt = await session.prompt("/statsu");
  expect(receipt.nearMiss).toBe("status");
  expect(receipt.command).toBeUndefined();
});
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement**

`builtins.ts` — one function per command, dispatched from `executeBuiltin`:

| Command | Implementation |
|---|---|
| `help` | Render `registry.list()` grouped by source as a markdown table |
| `status` | Session state, active model (`thread.model ?? session.model`), queue depth |
| `stop` | Thread abort API; `ok: false` + "No agent turn is running." when idle |
| `clear` | Clear pending queue items; report the count removed |
| `model` | No args → `ctx.listModels()` table; with id → `session.setModel(id, "slash_command")`; on throw, `ok: false`, output lists ids from `ctx.listModels()` filtered by Levenshtein ≤ 3 with "Pick one of: …" |
| `compact` | Trigger the compaction path with optional joined-args instructions |
| `new-thread` | Create + switch to a fresh thread; output the new thread id |
| `sessions` | `ctx.listChildSessions()` as a markdown table |

`Session.prompt` becomes:

```ts
async prompt(content: PromptContent, opts: PromptOptions = {}): Promise<PromptReceipt> {
  const text = typeof content === "string" ? content : "kind" in content ? undefined : content.text;
  if (text?.startsWith("/")) {
    const outcome = dispatchCommand(text, this.commandRegistry());
    if (outcome.kind === "expand") return this.thread().submitPrompt({ ...asObject(content), text: outcome.text }, opts);
    if (outcome.kind === "execute") return this.executeCommand(outcome, opts);
    if (outcome.nearMiss) {
      const receipt = await this.thread().submitPrompt(content, opts);
      return { ...receipt, nearMiss: outcome.nearMiss };
    }
  }
  return this.thread().submitPrompt(content, opts);
}
```

`executeCommand` runs the builtin (plugin source lands in Task 7), builds a `CommandResultEntry` (id via the session's existing id helper, `createdAt: Date.now()`), persists via `store.appendEntries`, emits it on the session event bus with a new event `{ type: "command_result", threadId, entry }` (add to the engine event union beside `model_switched`), and returns a receipt with `command` set. Commands execute even when the thread is streaming — do not touch queue admission. `commandRegistry()` builds lazily from `this.skills`, cached templates (refreshed by `templateProvider` on the same events that refresh skills and after prep), plugin `commands` from the catalog, and `options.bareSkillNames ?? false`. Missing `commandContext` → built-ins needing it return `ok: false`, output "This deployment does not expose model or session listings." (engine stays runnable in bare tests).

- [ ] **Step 4: Run** — `pnpm --filter @valet/engine test -- commands && pnpm --filter @valet/engine test -- happy-path && pnpm --filter @valet/engine typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(engine): built-in commands dispatched from Session.prompt`

---

### Task 7: Action-backed plugin command execution

**Files:**
- Modify: `packages/engine/src/session.ts` (`executeCommand` plugin branch)
- Modify: `packages/engine/src/plugin-catalog.ts` (export an `invokeAction` helper if `makeCallTool`'s body is not directly reusable)
- Test: `packages/engine/src/commands/plugin-commands.test.ts`

**Interfaces:**
- Consumes: `CommandDef.mapArgs`, plugin catalog action lookup, `prepareActionArgs`, `approvalModeFor`, `ctx.requestDecision` (all in `plugin-catalog.ts` lines ~137-498).
- Produces: `/plugin:cmd` → policy check → action execute → `CommandResultEntry`.

- [ ] **Step 1: Failing tests** — register a fixture plugin (full literal `ValetPlugin`, action `echo` returning its params as text):

```ts
it("executes an action-backed command and records the result", async () => {
  const receipt = await session.prompt("/testplug:echo hello");
  expect(receipt.command).toEqual({ name: "testplug:echo", source: "plugin" });
  const last = (await store.listEntries(session.id, threadId)).at(-1);
  expect(last?.type === "command_result" && last.ok).toBe(true);
  expect(last?.type === "command_result" ? last.output : "").toContain("hello");
});
it("routes require_approval actions through the decision gate", async () => {
  // fixture action with defaultApprovalMode: "require_approval"; fake requestDecision resolving "deny"
  const last = (await store.listEntries(session.id, threadId)).at(-1);
  expect(last?.type === "command_result" && last.ok).toBe(false);
  expect(last?.type === "command_result" ? last.output : "").toContain("approval");
});
it("missing credentials produce a corrective error", async () => {
  // fixture with requiresCredential: true and an empty credential provider
  expect(output).toContain("Connect the testplug integration in Settings.");
});
```

Flesh the two sketched tests out with the same session/fixture setup as the first.

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement**

Refactor the executable core of `makeCallTool` (arg preparation → approval → `entry.action.execute(prepared.args, actionCtx)`) into an exported `invokeAction(catalog, actionId, args, ctx)` used by both the tool path and the command path — do not duplicate the approval logic. The command path: `def.mapArgs(parseCommandArgs(raw), raw)` → `invokeAction` → format `PluginActionResult` into markdown output. Denied approval → `ok: false`, "Approval was denied. Adjust action policies in Settings to allow this action."; pending → "Approval is pending. Resolve it from the approvals panel."

- [ ] **Step 4: Run** — `pnpm --filter @valet/engine test -- commands && pnpm --filter @valet/engine test` (full engine suite; the refactor touches the tool path) → PASS.

- [ ] **Step 5: Commit** — `feat(engine): action-backed plugin commands via shared invokeAction`

---

### Task 8: store-postgres round trip for `command_result`

**Files:**
- Modify: `packages/store-postgres/src/helpers.ts` (row mappers) — only if entry payloads are mapped per-kind; if entries serialize as opaque JSON, this task is test-only
- Test: extend the store-postgres conformance/entry suite

- [ ] **Step 1: Failing test** — mirror Task 1's round-trip test in the store-postgres suite (PGlite path), using its existing setup helpers. Assert `output` text is reachable, not just defined (CLAUDE.md: `toBeDefined()` is the bug we keep shipping).

- [ ] **Step 2: Run** — `pnpm --filter @valet/store-postgres test` → FAIL or PASS-immediately. If it passes immediately, entries are opaque JSON; keep the test and skip Step 3.

- [ ] **Step 3: Implement (conditional)** — extend the entry row mapper in `helpers.ts` for the new kind, funneling any ms columns through `toNum`.

- [ ] **Step 4: Run** — suite green. No migration edit expected (`0000_engine.sql` unchanged unless the entries table has a kind CHECK constraint — if it does, update it in place and `rm -rf ~/.valet/pg`).

- [ ] **Step 5: Commit** — `test(store-postgres): command_result entry round trip`

---

### Task 9: App data — user templates table + bare-skill-names setting

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql`, `packages/api/src/schema/index.ts`
- Create: `packages/api/src/routes/prompt-templates.ts`
- Modify: `packages/api/src/routes/me.ts` (setting), router registration (follow how `messagesRouter` is mounted)
- Test: `packages/api/src/routes/prompt-templates.test.ts`

**Interfaces:**
- Produces: table `user_prompt_templates`; routes `GET/PUT/DELETE /api/prompt-templates[/:name]`; `PATCH /api/me` accepts `{ bareSkillCommands: boolean }`; Drizzle exports `userPromptTemplates`, `users.bareSkillCommands`.

- [ ] **Step 1: Failing tests** — CRUD via the api route test harness (copy setup from an existing routes test):

```ts
it("creates, lists, updates, deletes a template", async () => {
  await put("/api/prompt-templates/standup", { description: "Daily standup", content: "Summarize $1" });
  const list = await get("/api/prompt-templates");
  expect(list.templates).toEqual([{ name: "standup", description: "Daily standup", content: "Summarize $1" }]);
  await del("/api/prompt-templates/standup");
  expect((await get("/api/prompt-templates")).templates).toEqual([]);
});
it("rejects names that collide with built-ins", async () => {
  const res = await putRaw("/api/prompt-templates/status", { content: "x" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("reserved");
});
it("PATCH /api/me toggles bareSkillCommands", async () => { /* assert persisted read-back */ });
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement**

SQL (append to `0000_app.sql`, style-matched to `linear_installations`):

```sql
CREATE TABLE "user_prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "user_prompt_templates_user_name" ON "user_prompt_templates" ("user_id","name");
ALTER TABLE "user" ADD COLUMN "bare_skill_commands" boolean NOT NULL DEFAULT false;
```

(Fold the ALTER into the existing `"user"` CREATE TABLE instead — pre-1.0 rule, one canonical definition.) Drizzle mirrors both. Route validation: name must match `/^[a-z][a-z0-9-]*$/` and not be in `BUILTIN_COMMAND_NAMES` (import from `@valet/engine`); error text: `"${name}" is a reserved built-in command name. Pick a different name.` Then `rm -rf ~/.valet/pg`.

- [ ] **Step 4: Run** — `pnpm --filter @valet/api test -- prompt-templates && pnpm --filter @valet/api typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(api): user prompt templates and bare-skill-commands setting`

---

### Task 10: Host wiring — providers, CommandContext, GET /commands

**Files:**
- Modify: `packages/api/src/engine/host.ts` (session build: inject `templateProvider`, `commandContext`, `bareSkillNames`)
- Create: `packages/api/src/engine/command-providers.ts`
- Modify: `packages/api/src/routes/messages.ts` or sibling: add `GET /:id/commands`
- Test: `packages/api/src/engine/command-providers.test.ts` + route integration test

**Interfaces:**
- Consumes: `TemplateProvider`, `CommandContext`, `CommandInfo` from `@valet/engine`; `userPromptTemplates` from Task 9; sandbox exec from the session's sandbox handle; model enumeration from `llm-providers` internals; child listing from the engine store.
- Produces: `GET /api/sessions/:id/commands` → `{ commands: CommandInfo[], diagnostics: RegistryDiagnostic[] }`.

- [ ] **Step 1: Failing tests**

```ts
it("merges user templates into the registry", async () => {
  // insert a user_prompt_templates row, then:
  const res = await get(`/api/sessions/${sessionId}/commands`);
  expect(res.commands.some((c) => c.name === "standup" && c.source === "template")).toBe(true);
  expect(res.commands.some((c) => c.name === "status" && c.source === "builtin")).toBe(true);
});
it("repo templates appear only after workspace prep", async () => { /* virtual sandbox fixture with .valet/prompts/x.md */ });
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement**

`command-providers.ts`:

```ts
export function makeTemplateProvider(db: Db, userId: string, sandbox: () => SandboxHandle | undefined): TemplateProvider {
  return {
    async listTemplates() {
      const user = (await db.select().from(userPromptTemplates).where(eq(userPromptTemplates.userId, userId)))
        .map((r) => ({ name: r.name, description: r.description ?? undefined, content: r.content, origin: "user" as const }));
      const repo = await readRepoTemplates(sandbox());
      return [...repo, ...user];
    },
  };
}
```

`readRepoTemplates` runs one exec in the sandbox (returns `[]` when no sandbox or non-zero exit):

```sh
sh -c 'for f in /workspace/.valet/prompts/*.md; do [ -f "$f" ] || continue; printf "===VALET-TMPL %s\n" "$f"; cat "$f"; done'
```

Parse on the delimiter; name = filename minus `.md`; `description:` from frontmatter. `CommandContext`: `listModels` reuses the enumeration behind `llm-providers` (extract a `listUserModels(db, userId)` if it lives inline in the route); `listChildSessions` queries the engine store for sessions whose parent is this session (same source `/sessions`' data would come from — check how the orchestrator lists children and reuse it). Route follows the `GET /:id/threads` pattern (`loadEngineSession(c)` guard, `c.json(body)`).

- [ ] **Step 4: Run** — api tests + typecheck → PASS.

- [ ] **Step 5: Commit** — `feat(api): command providers, context, and GET /sessions/:id/commands`

---

### Task 11: Wire + REST for `command_result` (hops 2 and 3)

**Files:**
- Modify: `packages/api/src/engine/bridge.ts` (`busEventToWire`), `packages/api/src/routes/messages.ts` (`entryToMessage` ~51), shared wire types in `packages/shared`
- Test: api integration test — submit `/status` over the real stack, read back via REST

**Interfaces:**
- Produces: wire event `{ type: "command_result", message: Message }`; REST `Message` for a `command_result` entry: `role: "system"`, `content: entry.output`, plus `command: { name: string; source: string; ok: boolean }`.

- [ ] **Step 1: Failing test**

```ts
it("a builtin command round-trips to REST", async () => {
  await postPrompt(sessionId, "/status");
  const msgs = await get(`/api/sessions/${sessionId}/messages`);
  const cmd = msgs.messages.find((m) => m.command?.name === "status");
  expect(cmd?.command?.ok).toBe(true);
  expect(cmd?.content.length).toBeGreaterThan(0); // the TEXT is reachable
});
```

- [ ] **Step 2: Verify failure** → FAIL (`entryToMessage` returns null for unknown kinds).

- [ ] **Step 3: Implement** — add the `command_result` case to `entryToMessage`; add the engine `command_result` event mapping to `busEventToWire` (reuse the entry→Message conversion so live and reload shapes are identical — shape drift here is the documented three-time regression); add `command?: {...}` to the shared `Message` type in `packages/shared`.

- [ ] **Step 4: Run** — api integration suite + `pnpm --filter @valet/engine test -- happy-path && pnpm --filter @valet/engine test -- in-memory-store && pnpm --filter @valet/store-postgres test` (the four-hop regression set) → PASS.

- [ ] **Step 5: Commit** — `feat(api): ship command_result over wire and REST`

---

### Task 12: Web renderer for command results (hop 4)

**Files:**
- Create: `packages/web/src/components/session/command-result.tsx`
- Modify: the message-list component that maps `Message` → components (find where `signal` messages get special treatment and add the `command` branch beside it)
- Test: `packages/web/src/components/session/command-result.test.tsx`

- [ ] **Step 1: Failing test** — render with `{ command: { name: "status", source: "builtin", ok: true }, content: "**idle** — queue 0" }`; assert the command name chip and markdown-rendered body appear; `ok: false` renders the error styling (match the existing error-message styling tokens).

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** — compact card: monospace `/{name}` chip + source badge + rendered markdown body, red accent when `!ok`. Follow the visual language of the existing tool renderers (`tool-shell.tsx`).

- [ ] **Step 4: Run** — `pnpm --filter @valet/web test -- command-result && pnpm --filter @valet/web typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(web): command result renderer`

---

### Task 13: Composer autocomplete

**Files:**
- Modify: `packages/web/src/components/session/composer.tsx`
- Create: `packages/web/src/components/session/command-popup.tsx`, `packages/web/src/hooks/use-commands.ts`
- Test: `packages/web/src/components/session/command-popup.test.tsx`

**Interfaces:**
- Consumes: `GET /api/sessions/:id/commands` (Task 10), shared `CommandInfo`.
- Produces: typing `/` at position 0 opens a filtered popup; ↑/↓ navigate, Tab/Enter insert `/name `, Esc closes; popup shows description + argHint, grouped by source.

- [ ] **Step 1: Failing test** — render popup with a fixture list; filter query "sta" shows only `status`; Enter fires `onSelect("status")`; Esc fires `onClose`.

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** — `use-commands.ts` is a TanStack Query hook keyed `["commands", sessionId]` with `staleTime: 30_000`. In `composer.tsx`, derive `commandQuery` from `text` (`/^\/(\S*)$/` on the full value — popup only while the message is a lone command token); intercept ArrowUp/ArrowDown/Tab/Enter/Esc in the existing key handler (line ~85) only while open, preserving the IME-composition guard. Keep dispatch server-side — the composer sends the text unchanged.

- [ ] **Step 4: Run** — web tests + typecheck → PASS.

- [ ] **Step 5: Commit** — `feat(web): slash command autocomplete in composer`

---

### Task 14: End-to-end validation + docs

**Files:**
- Modify: `docs/specs/2026-08-12-slash-commands-design.md` (record any deviations in a Deviations section)

- [ ] **Step 1: Run the four-hop regression set** — `pnpm --filter @valet/engine test -- happy-path`, `-- in-memory-store`, `pnpm --filter @valet/store-postgres test`, api integration suite. All green.
- [ ] **Step 2: Run `make smoke-session`** — then submit `/status` against the dev stack and confirm the result renders and survives a page reload.
- [ ] **Step 3: Run `make e2e`** — clean scorecard; name the cause of any pre-existing environmental red rows and confirm each is unrelated.
- [ ] **Step 4: Update the spec's Deviations section** if implementation diverged; otherwise note "implemented as specified".
- [ ] **Step 5: Commit** — `docs: record slash-commands implementation outcome`

---

## Self-Review Notes

- Spec coverage: taxonomy (T1-T7), naming/collisions (T3, T4, T9), dispatch + mid-run (T5, T6), registry + API (T10), command_result four hops (T1, T8, T11, T12), templates storage (T9, T10), setting (T9), error handling (T6, T7, T9), testing (every task + T14). Out-of-scope items have no tasks, as intended.
- Type consistency: `CommandDef.action`/`mapArgs`, `CommandInfo.name` (no leading slash), `DispatchOutcome` kinds, and the `command` receipt field are used with the same shapes in T3-T13.
- Known unknowns called out inline rather than hidden: whether store-postgres maps entries per-kind (T8 branches on it), where model enumeration lives (T10 says extract if inline), which event ships live entries (T11 pins to `busEventToWire` + identical-shape rule).
