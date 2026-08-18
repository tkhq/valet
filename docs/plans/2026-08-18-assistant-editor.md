# Assistant Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-assistant behavior (personality, skill allowlist, integration allowlist with action excludes) plus a dedicated editor page at `/assistants/$assistantId`.

**Architecture:** Two nullable columns on `assistants` (`personality`, `behavior` JSON). One pure module (`packages/api/src/assistants/behavior.ts`) validates, parses, and applies the config. `buildAssistantSession` is the single enforcement funnel. A behavior PATCH evicts the cached engine session (`EngineHost.evictCache`), so the next wake rebuilds with the new config.

**Tech Stack:** Hono routes, Drizzle (app schema), vitest, React 19 + TanStack Router/Query, Tailwind, Radix primitives.

**Spec:** `docs/specs/2026-08-18-assistant-editor-design.md` (read it first; it travels with this plan).

## Global Constraints

- Base branch: `feat/team-workspace-ui` (the editor depends on the rail and workspace-scope code there). Do not base on `main` (frozen legacy).
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place. Do NOT add numbered migrations. After editing, `rm -rf ~/.valet/pg` is MANDATORY.
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore`. Tests build full shapes.
- Test filters: `pnpm --filter @valet/<pkg> test <filter>` with NO `--` before the filter (vitest drops args after `--` and runs the full suite).
- All prose and UI copy: ASD-STE100 per CLAUDE.md. Every user-facing error message names the corrective action.
- Commit subjects ≤72 chars. No Co-Authored-by trailers.
- Node 22 (`nvm use 22`) if `WebSocket is not defined` appears in tests.

---

### Task 1: Wire types + the behavior module (pure functions)

**Files:**
- Modify: `packages/api/src/wire/types.ts` (assistants section, after `AssistantOwner` ~line 191)
- Create: `packages/api/src/assistants/behavior.ts`
- Test: `packages/api/src/assistants/behavior.test.ts`

**Interfaces:**
- Consumes: `ValetPlugin`, `ActionPlugin`, `PluginAction`, `SkillSource` from `@valet/engine`.
- Produces (later tasks rely on these exact names):
  - Wire: `AssistantBehavior`, `AssistantSkillsBehavior`, `AssistantIntegrationsBehavior`, `AssistantIntegrationEntry`.
  - `validateAssistantBehavior(input: unknown): string | null` — corrective error text, or null when valid.
  - `parseAssistantBehavior(raw: string | null, assistantId: string): AssistantBehavior | null` — fail-open with `console.warn`.
  - `serializeAssistantBehavior(behavior: AssistantBehavior | null | undefined): string | null`.
  - `applyBehaviorToPlugins(plugins: ValetPlugin[], behavior: AssistantBehavior | null): ValetPlugin[]`.
  - `filterSkillSources(skills: SkillSource[], behavior: AssistantBehavior | null): SkillSource[]`.

- [ ] **Step 1: Add the wire types**

In `packages/api/src/wire/types.ts`, after `AssistantOwner`:

```ts
/** Which skills reach the assistant's session. Absent or `mode: "all"` is
 * today's behavior: every skill the owner can reach. Names are the merge
 * key stored skills already shadow plugin skills by. */
export type AssistantSkillsBehavior =
  | { mode: "all" }
  | { mode: "allowlist"; names: string[] };

/** One attached integration. `service` is the ActionPlugin routing key
 * (e.g. "github"). `excludeActions` holds fully-qualified action ids
 * (e.g. "github.create_issue"), the same ids the action-policy tables use. */
export interface AssistantIntegrationEntry {
  service: string;
  excludeActions?: string[];
}

export type AssistantIntegrationsBehavior =
  | { mode: "all" }
  | { mode: "allowlist"; entries: AssistantIntegrationEntry[] };

/** Per-assistant behavior config (`docs/specs/2026-08-18-assistant-editor-design.md`).
 * A null/absent field means "everything", which is what every pre-existing
 * assistant has. */
export interface AssistantBehavior {
  skills?: AssistantSkillsBehavior;
  integrations?: AssistantIntegrationsBehavior;
}
```

Extend the existing interfaces in the same file:

```ts
export interface AssistantSummary {
  // ...existing fields stay...
  /** Absent until someone sets it. When absent the session falls back to the
   * owner's assistant/personality.md memory file. */
  personality?: string;
  /** Absent means every skill and integration (the pre-config behavior). */
  behavior?: AssistantBehavior;
}

export interface CreateAssistantRequest {
  name?: string;
  owner?: AssistantOwner;
  personality?: string;
  behavior?: AssistantBehavior;
}

export interface PatchAssistantRequest {
  name?: string;
  isDefault?: true;
  /** null clears back to the memory-file fallback. */
  personality?: string | null;
  /** null clears back to "everything". */
  behavior?: AssistantBehavior | null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/api/src/assistants/behavior.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ValetPlugin, SkillSource } from "@valet/engine";
import {
  applyBehaviorToPlugins,
  filterSkillSources,
  parseAssistantBehavior,
  serializeAssistantBehavior,
  validateAssistantBehavior,
} from "./behavior.js";

function makePlugin(overrides: Partial<ValetPlugin> = {}): ValetPlugin {
  return {
    name: "github",
    version: "1.0.0",
    actions: [
      {
        service: "github",
        actions: [
          action("github.create_issue", "Create issue"),
          action("github.delete_repo", "Delete repo"),
        ],
      },
    ],
    skills: [skill("gh-triage")],
    ...overrides,
  };
}

function action(id: string, name: string) {
  return {
    id,
    name,
    description: name,
    riskLevel: "low" as const,
    parameters: { type: "object" as const, properties: {} },
    execute: async () => ({ ok: true as const, content: [] }),
  };
}

function skill(name: string): SkillSource {
  return { name, description: name, content: `# ${name}` };
}

describe("validateAssistantBehavior", () => {
  it("accepts all/allowlist shapes and rejects unknown modes with a corrective message", () => {
    expect(validateAssistantBehavior({ skills: { mode: "all" } })).toBeNull();
    expect(
      validateAssistantBehavior({
        skills: { mode: "allowlist", names: ["gh-triage"] },
        integrations: {
          mode: "allowlist",
          entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
        },
      }),
    ).toBeNull();
    expect(validateAssistantBehavior({ skills: { mode: "some" } })).toMatch(
      /skills\.mode must be 'all' or 'allowlist'/,
    );
    expect(validateAssistantBehavior({ integrations: { mode: "allowlist" } })).toMatch(
      /entries/,
    );
    expect(
      validateAssistantBehavior({ integrations: { mode: "allowlist", entries: [{ service: 7 }] } }),
    ).toMatch(/service/);
  });
});

describe("parse/serialize round trip", () => {
  it("round-trips a config and returns null for null", () => {
    const behavior = { skills: { mode: "allowlist" as const, names: ["a"] } };
    const raw = serializeAssistantBehavior(behavior);
    expect(parseAssistantBehavior(raw, "asst_1")).toEqual(behavior);
    expect(serializeAssistantBehavior(null)).toBeNull();
    expect(parseAssistantBehavior(null, "asst_1")).toBeNull();
  });

  it("fails open on garbage, with a warning naming the assistant", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseAssistantBehavior("{not json", "asst_9")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("asst_9"));
    warn.mockRestore();
  });
});

describe("applyBehaviorToPlugins", () => {
  it("null behavior returns the plugins untouched", () => {
    const plugins = [makePlugin()];
    expect(applyBehaviorToPlugins(plugins, null)).toBe(plugins);
  });

  it("allowlist keeps only listed services and drops excluded action ids", () => {
    const plugins = [
      makePlugin(),
      makePlugin({
        name: "slack",
        actions: [{ service: "slack", actions: [action("slack.send_message", "Send")] }],
        skills: [],
      }),
    ];
    const out = applyBehaviorToPlugins(plugins, {
      integrations: {
        mode: "allowlist",
        entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
      },
    });
    const github = out.find((p) => p.name === "github");
    const slack = out.find((p) => p.name === "slack");
    expect(github?.actions?.[0]?.actions.map((a) => a.id)).toEqual(["github.create_issue"]);
    expect(slack?.actions).toEqual([]);
    // Plugin skills survive the integrations filter; the skills config governs them.
    expect(slack === undefined || (slack.skills ?? []).length === 0).toBe(true);
    expect(github?.skills?.map((s) => s.name)).toEqual(["gh-triage"]);
  });

  it("wraps resolveActions so dynamically resolved actions honor excludes", async () => {
    const dynamic = makePlugin({
      name: "mcp",
      actions: [
        {
          service: "mcp",
          actions: [],
          resolveActions: async () => [action("mcp.read", "Read"), action("mcp.write", "Write")],
        },
      ],
      skills: [],
    });
    const out = applyBehaviorToPlugins([dynamic], {
      integrations: {
        mode: "allowlist",
        entries: [{ service: "mcp", excludeActions: ["mcp.write"] }],
      },
    });
    const resolve = out[0]?.actions?.[0]?.resolveActions;
    expect(resolve).toBeDefined();
    const resolved = await resolve!({ credentials: {} as never });
    expect(resolved.map((a) => a.id)).toEqual(["mcp.read"]);
  });

  it("skills allowlist filters plugin skills", () => {
    const out = applyBehaviorToPlugins([makePlugin()], {
      skills: { mode: "allowlist", names: ["other"] },
    });
    expect(out[0]?.skills).toEqual([]);
    // Actions untouched: no integrations config was given.
    expect(out[0]?.actions?.[0]?.actions).toHaveLength(2);
  });
});

describe("filterSkillSources", () => {
  it("filters stored skills by the allowlist and passes everything through otherwise", () => {
    const skills = [skill("a"), skill("b")];
    expect(filterSkillSources(skills, null)).toBe(skills);
    expect(
      filterSkillSources(skills, { skills: { mode: "allowlist", names: ["b"] } }).map(
        (s) => s.name,
      ),
    ).toEqual(["b"]);
  });
});
```

NOTE for the implementer: build the `ValetPlugin`/`PluginAction` literals to satisfy the real engine types (`packages/engine/src/plugin-catalog.ts`). If a field is missing from the helpers above, add it to the helpers — do not cast.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @valet/api test behavior`
Expected: FAIL — `behavior.js` does not exist.

- [ ] **Step 4: Implement `packages/api/src/assistants/behavior.ts`**

```ts
/**
 * Per-assistant behavior config (`docs/specs/2026-08-18-assistant-editor-design.md`).
 *
 * Pure functions only — the routes validate with `validateAssistantBehavior`,
 * the host parses stored JSON with `parseAssistantBehavior` and applies it
 * with `applyBehaviorToPlugins`/`filterSkillSources`. Null behavior always
 * means "everything", which is what every pre-config assistant row has.
 *
 * Attachment is capability shaping, not a security boundary: action policies
 * and approval gates stay the enforcement layer. That is why
 * `parseAssistantBehavior` fails OPEN (logged) on JSON that does not parse —
 * a bug here must not stop the assistant from waking.
 */
import type { ActionPlugin, PluginAction, SkillSource, ValetPlugin } from "@valet/engine";
import type {
  AssistantBehavior,
  AssistantIntegrationEntry,
  AssistantIntegrationsBehavior,
  AssistantSkillsBehavior,
} from "../wire/types.js";

/** Corrective validation error for a PATCH/POST body value, or null when
 * `input` is a structurally valid AssistantBehavior. */
export function validateAssistantBehavior(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "behavior must be an object with optional 'skills' and 'integrations'.";
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "skills" && key !== "integrations") {
      return `behavior.${key} is not a recognized field. Send 'skills' and/or 'integrations'.`;
    }
  }
  if (record.skills !== undefined) {
    const err = validateSkills(record.skills);
    if (err) return err;
  }
  if (record.integrations !== undefined) {
    const err = validateIntegrations(record.integrations);
    if (err) return err;
  }
  return null;
}

function validateSkills(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.skills must be { mode: 'all' } or { mode: 'allowlist', names: [...] }.";
  }
  const record = input as Record<string, unknown>;
  if (record.mode === "all") return null;
  if (record.mode !== "allowlist") return "behavior.skills.mode must be 'all' or 'allowlist'.";
  if (!Array.isArray(record.names) || record.names.some((n) => typeof n !== "string")) {
    return "behavior.skills.names must be an array of skill names.";
  }
  return null;
}

function validateIntegrations(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return "behavior.integrations must be { mode: 'all' } or { mode: 'allowlist', entries: [...] }.";
  }
  const record = input as Record<string, unknown>;
  if (record.mode === "all") return null;
  if (record.mode !== "allowlist") {
    return "behavior.integrations.mode must be 'all' or 'allowlist'.";
  }
  if (!Array.isArray(record.entries)) {
    return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
  }
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) {
      return "behavior.integrations.entries must be an array of { service, excludeActions? }.";
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.service !== "string" || e.service.length === 0) {
      return "behavior.integrations.entries[].service must be a service id, e.g. 'github'.";
    }
    if (
      e.excludeActions !== undefined &&
      (!Array.isArray(e.excludeActions) || e.excludeActions.some((a) => typeof a !== "string"))
    ) {
      return "behavior.integrations.entries[].excludeActions must be an array of action ids, e.g. 'github.create_issue'.";
    }
  }
  return null;
}

/** The stored `assistants.behavior` text, parsed. Fails OPEN (logged, null =
 * everything): PATCH validates before writing, so unparseable JSON is a bug,
 * and a bug here must not stop the assistant from waking. */
export function parseAssistantBehavior(
  raw: string | null,
  assistantId: string,
): AssistantBehavior | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const err = validateAssistantBehavior(parsed);
    if (err) throw new Error(err);
    return parsed as AssistantBehavior;
  } catch (err) {
    console.warn(
      `assistants: behavior JSON on ${assistantId} is invalid (${String(err)}); ` +
        `applying no restriction`,
    );
    return null;
  }
}

export function serializeAssistantBehavior(
  behavior: AssistantBehavior | null | undefined,
): string | null {
  if (behavior === null || behavior === undefined) return null;
  return JSON.stringify(behavior);
}

/** Fully-qualified action id, the plugin-catalog convention the plugins
 * route also applies (`routes/plugins.ts`). */
function fqActionId(service: string, id: string): string {
  return id.includes(".") ? id : `${service}.${id}`;
}

/**
 * The plugin set one assistant's session builds from. Filters each plugin's
 * ActionPlugins by the integrations config (allowlisted services only, then
 * excluded action ids dropped — statically declared AND dynamically resolved,
 * via a `resolveActions` wrapper) and each plugin's skills by the skills
 * config. Never drops a whole plugin object: a plugin whose service is not
 * allowlisted keeps its skills, because the skills config governs those.
 */
export function applyBehaviorToPlugins(
  plugins: ValetPlugin[],
  behavior: AssistantBehavior | null,
): ValetPlugin[] {
  if (behavior === null) return plugins;
  const integrations = behavior.integrations;
  const skillNames = allowedSkillNames(behavior.skills);
  if ((integrations === undefined || integrations.mode === "all") && skillNames === null) {
    return plugins;
  }

  return plugins.map((plugin) => ({
    ...plugin,
    actions: filterActionPlugins(plugin.actions ?? [], integrations),
    skills: skillNames === null ? plugin.skills : (plugin.skills ?? []).filter((s) => skillNames.has(s.name)),
  }));
}

function filterActionPlugins(
  actionPlugins: ActionPlugin[],
  integrations: AssistantIntegrationsBehavior | undefined,
): ActionPlugin[] {
  if (integrations === undefined || integrations.mode === "all") return actionPlugins;
  const bySvc = new Map<string, AssistantIntegrationEntry>(
    integrations.entries.map((e) => [e.service, e]),
  );
  const kept: ActionPlugin[] = [];
  for (const actionPlugin of actionPlugins) {
    const entry = bySvc.get(actionPlugin.service);
    if (entry === undefined) continue;
    const excluded = new Set(entry.excludeActions ?? []);
    const keepAction = (a: PluginAction) => !excluded.has(fqActionId(actionPlugin.service, a.id));
    const wrapped: ActionPlugin = {
      ...actionPlugin,
      actions: actionPlugin.actions.filter(keepAction),
      ...(actionPlugin.resolveActions
        ? {
            resolveActions: async (ctx: Parameters<NonNullable<ActionPlugin["resolveActions"]>>[0]) =>
              (await actionPlugin.resolveActions!(ctx)).filter(keepAction),
          }
        : {}),
    };
    kept.push(wrapped);
  }
  return kept;
}

function allowedSkillNames(skills: AssistantSkillsBehavior | undefined): Set<string> | null {
  if (skills === undefined || skills.mode === "all") return null;
  return new Set(skills.names);
}

/** Stored skills, filtered by the skills allowlist. Plugin skills go through
 * `applyBehaviorToPlugins`; this handles the `listSkillSourcesFor` half. */
export function filterSkillSources(
  skills: SkillSource[],
  behavior: AssistantBehavior | null,
): SkillSource[] {
  const names = behavior === null ? null : allowedSkillNames(behavior.skills);
  if (names === null) return skills;
  return skills.filter((s) => names.has(s.name));
}
```

Adjust the `resolveActions` wrapper typing against the real `ActionPlugin` type if the `Parameters<...>` form fights the compiler — a named context type import is fine. No casts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @valet/api test behavior`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add packages/api/src/wire/types.ts packages/api/src/assistants/behavior.ts packages/api/src/assistants/behavior.test.ts
git commit -m "feat(api): assistant behavior config types and pure filters"
```

---

### Task 2: Schema columns, service writes, routes, evict-on-patch

**Files:**
- Modify: `packages/api/src/schema/index.ts` (assistants table, ~line 494)
- Modify: `packages/api/migrations/pg/0000_app.sql` (CREATE TABLE "assistants", ~line 282)
- Modify: `packages/api/src/assistants/service.ts` (`toAssistantSummary`, `newAssistantRow`, `createAssistant`, `patchAssistant`)
- Modify: `packages/api/src/routes/assistants.ts` (POST + PATCH)
- Test: `packages/api/src/integration/assistants.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 1's `validateAssistantBehavior`, `parseAssistantBehavior`, `serializeAssistantBehavior`; wire types.
- Produces:
  - `AssistantRow` gains `personality: string | null` and `behavior: string | null`.
  - `createAssistant(db, orgId, principal, name, config?: { personality?: string | null; behavior?: AssistantBehavior | null })`.
  - `patchAssistant(db, row, patch: { name?: string; isDefault?: true; personality?: string | null; behavior?: AssistantBehavior | null })`.
  - PATCH route evicts: `engineHost.evictCache(row.sessionId)` when personality/behavior changed.

- [ ] **Step 1: Add the columns**

`packages/api/src/schema/index.ts`, inside the `assistants` table after `name`:

```ts
    /** Per-assistant persona text. Null falls back to the owner's
     * assistant/personality.md memory file (the pre-config behavior). */
    personality: text("personality"),
    /** JSON `AssistantBehavior` (wire/types.ts). Null means every skill and
     * integration. Validated on write (`validateAssistantBehavior`); parsed
     * fail-open on read (`parseAssistantBehavior`). */
    behavior: text("behavior"),
```

`packages/api/migrations/pg/0000_app.sql`, in `CREATE TABLE "assistants"` after `"name" text,`:

```sql
	"personality" text,
	"behavior" text,
```

Then: `rm -rf ~/.valet/pg` (mandatory — the tracker skips an applied 0000).

- [ ] **Step 2: Write the failing integration tests**

Append to `packages/api/src/integration/assistants.test.ts`:

```ts
describe("personality and behavior config", () => {
  const BEHAVIOR = {
    skills: { mode: "allowlist" as const, names: ["gh-triage"] },
    integrations: {
      mode: "allowlist" as const,
      entries: [{ service: "github", excludeActions: ["github.delete_repo"] }],
    },
  };

  it("create-with-config round-trips through the summary", async () => {
    api = await bootTestApi();
    const created = await create(api, {
      name: "Triage",
      personality: "Terse. Cites sources.",
      behavior: BEHAVIOR,
    });
    expect(created.personality).toBe("Terse. Cites sources.");
    expect(created.behavior).toEqual(BEHAVIOR);

    const listed = await list(api);
    const row = listed.find((a) => a.id === created.id);
    expect(row?.behavior).toEqual(BEHAVIOR);
  });

  it("PATCH writes both fields, and null clears them", async () => {
    api = await bootTestApi();
    const created = await create(api, { name: "Triage" });

    const res = await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ personality: "Blunt.", behavior: BEHAVIOR }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PatchAssistantResponse;
    expect(patched.personality).toBe("Blunt.");
    expect(patched.behavior).toEqual(BEHAVIOR);

    const cleared = await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ personality: null, behavior: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as PatchAssistantResponse;
    expect(clearedBody.personality).toBeUndefined();
    expect(clearedBody.behavior).toBeUndefined();
  });

  it("rejects a malformed behavior with a corrective message", async () => {
    api = await bootTestApi();
    const created = await create(api, {});
    const res = await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ behavior: { skills: { mode: "some" } } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/skills\.mode must be 'all' or 'allowlist'/);
  });

  it("a behavior PATCH evicts the cached engine session", async () => {
    api = await bootTestApi();
    const created = await create(api, {});
    const evict = vi.spyOn(api.providers.engineHost, "evictCache");

    await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ personality: "Blunt." }),
    });
    expect(evict).toHaveBeenCalledWith(created.sessionId);

    evict.mockClear();
    await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed only" }),
    });
    expect(evict).not.toHaveBeenCalled();
  });

  it("a plain team member cannot write a team assistant's behavior", async () => {
    api = await bootTestApi();
    await seedTeam(api, "test-member", "member");
    const created = await create(api, { owner: { type: "team", id: "team_1" } });

    const res = await fetch(`${api.baseUrl}/api/assistants/${created.id}`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify({ personality: "Mine now." }),
    });
    expect(res.status).toBe(404);
  });
});
```

Add `vi` to the vitest import at the top of the file. If `api.providers` does not expose `engineHost`, look at `integration/_setup.ts` (`bootTestApi`) and expose it the way `db` is exposed — do not reach through globals.

- [ ] **Step 3: Run tests to verify the new block fails**

Run: `pnpm --filter @valet/api test integration/assistants`
Expected: the new describe FAILS (unknown fields dropped / 400s); pre-existing tests PASS.

- [ ] **Step 4: Implement service + routes**

`packages/api/src/assistants/service.ts`:

- Import `parseAssistantBehavior`, `serializeAssistantBehavior` from `./behavior.js` and `AssistantBehavior` from `../wire/types.js`.
- `toAssistantSummary` — add after the `name` spread:

```ts
    ...(row.personality !== null ? { personality: row.personality } : {}),
    ...(() => {
      const behavior = parseAssistantBehavior(row.behavior, row.id);
      return behavior !== null ? { behavior } : {};
    })(),
```

- `newAssistantRow` — add `personality: args.personality ?? null, behavior: args.behavior ?? null` and widen its args with `personality?: string | null; behavior?: string | null` (already-serialized text).
- `createAssistant` — new optional last parameter `config?: { personality?: string | null; behavior?: AssistantBehavior | null }`; pass `personality: config?.personality ?? null, behavior: serializeAssistantBehavior(config?.behavior)` into BOTH `newAssistantRow` calls' object (the retry insert spreads `row`, so it inherits automatically).
- `patchAssistant` — widen the patch type to `{ name?: string; isDefault?: true; personality?: string | null; behavior?: AssistantBehavior | null }` and add inside the transaction, after the name write:

```ts
    if (patch.personality !== undefined) {
      const trimmed = patch.personality === null ? null : patch.personality.trim();
      await tx
        .update(assistants)
        .set({ personality: trimmed === "" ? null : trimmed })
        .where(eq(assistants.id, row.id));
    }
    if (patch.behavior !== undefined) {
      await tx
        .update(assistants)
        .set({ behavior: serializeAssistantBehavior(patch.behavior) })
        .where(eq(assistants.id, row.id));
    }
```

`packages/api/src/routes/assistants.ts`:

- POST: after the name check, add:

```ts
  if (body.personality !== undefined && typeof body.personality !== "string") {
    return c.json({ error: "personality must be a string." }, 400);
  }
  if (body.behavior !== undefined) {
    const err = validateAssistantBehavior(body.behavior);
    if (err) return c.json({ error: err }, 400);
  }
```

and pass `{ personality: body.personality ?? null, behavior: body.behavior ?? null }` as `createAssistant`'s new argument.

- PATCH: extend the body checks:

```ts
  if (body.personality !== undefined && body.personality !== null && typeof body.personality !== "string") {
    return c.json({ error: "personality must be a string, or null to clear it." }, 400);
  }
  if (body.behavior !== undefined && body.behavior !== null) {
    const err = validateAssistantBehavior(body.behavior);
    if (err) return c.json({ error: err }, 400);
  }
```

Update the "nothing to do" guard to admit the new fields:

```ts
  if (
    body.name === undefined &&
    body.isDefault === undefined &&
    body.personality === undefined &&
    body.behavior === undefined
  ) {
    return c.json({ error: "Send a name, isDefault: true, personality, or behavior." }, 400);
  }
```

After a successful `patchAssistant`, evict when behavior-shaping fields were in the body (destructure `engineHost` from `c.var.providers` alongside `db`):

```ts
    if (body.personality !== undefined || body.behavior !== undefined) {
      // Cache-only eviction (never destroy(): that would kill a running
      // turn). The next wake rebuilds with the new persona and filters —
      // the same seam PATCH /api/orchestrator/info uses.
      engineHost.evictCache(row.sessionId);
    }
```

Also update the route-file header comment's PATCH line to mention personality/behavior.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @valet/api test integration/assistants` then `pnpm --filter @valet/api test behavior`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add -A packages/api
git commit -m "feat(api): per-assistant personality and behavior columns + routes"
```

---

### Task 3: Host enforcement (persona preference + filtered extras)

**Files:**
- Create: `packages/api/src/assistants/persona.ts`
- Test: `packages/api/src/assistants/persona.test.ts`
- Modify: `packages/api/src/engine/host.ts` (`resolvePersonaPrefix` ~line 1486, `sessionExtras` ~line 726, `skillsProviderFor` ~line 767, `buildAssistantSession` body ~lines 1330-1400)

**Interfaces:**
- Consumes: Task 1's `applyBehaviorToPlugins`, `filterSkillSources`, `parseAssistantBehavior`; Task 2's row columns.
- Produces:
  - `personaPrefixText(name: string | null, personality: string): string` (pure; moves the cap + "no name, no prefix" rule out of host.ts).
  - `sessionExtras(owner, orgId, pins?, behavior?: AssistantBehavior | null)`.
  - `skillsProviderFor(owner, orgId, behavior?: AssistantBehavior | null)`.

- [ ] **Step 1: Write the failing persona test**

`packages/api/src/assistants/persona.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PERSONALITY_INJECT_CAP, personaPrefixText } from "./persona.js";

describe("personaPrefixText", () => {
  it("no name means no prefix, personality or not", () => {
    expect(personaPrefixText(null, "Chipper.")).toBe("");
  });

  it("name alone, and name + personality", () => {
    expect(personaPrefixText("Ada", "")).toBe("You are Ada.\n\n");
    expect(personaPrefixText("Ada", "Terse.")).toBe("You are Ada. Terse.\n\n");
  });

  it("caps the personality", () => {
    const long = "x".repeat(PERSONALITY_INJECT_CAP + 100);
    const out = personaPrefixText("Ada", long);
    expect(out).toContain("x".repeat(PERSONALITY_INJECT_CAP));
    expect(out.length).toBe("You are Ada. ".length + PERSONALITY_INJECT_CAP + 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @valet/api test persona`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `packages/api/src/assistants/persona.ts`**

Move `PERSONALITY_INJECT_CAP` here from its current home (grep host.ts for it; keep the constant's existing value and doc comment, re-export nothing extra):

```ts
/** `You are {name}. {personality}` prefix for an assistant's systemPrompt
 * (assistant-centered web UI decision 5). Absent name → "" regardless of
 * personality: the identity step always sets name first, and a prefix with
 * no name in it helps nobody. */
export function personaPrefixText(name: string | null, personality: string): string {
  if (!name) return "";
  const capped = personality.slice(0, PERSONALITY_INJECT_CAP);
  const sentence = capped ? `You are ${name}. ${capped}` : `You are ${name}.`;
  return `${sentence}\n\n`;
}
```

- [ ] **Step 4: Wire the host**

In `packages/api/src/engine/host.ts`:

1. `resolvePersonaPrefix` — new signature and preference order:

```ts
  private async resolvePersonaPrefix(
    db: AppDb,
    scope: MemoryScope,
    name: string | null,
    rowPersonality: string | null,
  ): Promise<string> {
    if (!name) return "";
    // The row wins when set (assistant editor design): per-assistant persona.
    // Null falls back to the owner's own file, the pre-config behavior —
    // own-scope only, never a team member's file (readOwnFile bypasses the
    // team read-union).
    if (rowPersonality !== null) return personaPrefixText(name, rowPersonality);
    const row = await readOwnFile(db, scope, "assistant/personality.md");
    return personaPrefixText(name, row ? row.content : "");
  }
```

Call site (in `buildAssistantSession`): `this.resolvePersonaPrefix(db, scope, assistant.name, assistant.personality)`.

2. `sessionExtras` — add the 4th parameter and apply the filters:

```ts
  private async sessionExtras(
    owner: Principal,
    orgId: string,
    pins: readonly PinnedActionSpec[] = [],
    behavior: AssistantBehavior | null = null,
  ): Promise<PluginSessionExtras> {
    const gated = gateUnavailableActions(/* unchanged args */);
    // Behavior filter AFTER availability gating: both subtract, order only
    // matters for the wrapper identity, and gating first keeps its
    // unavailable-service messages accurate.
    const plugins = applyBehaviorToPlugins(gated, behavior);
    if (!this.opts.db) return pluginSessionExtras(plugins, [], pins);
    return pluginSessionExtras(
      plugins,
      filterSkillSources(await listSkillSourcesFor(this.opts.db, owner, orgId), behavior),
      pins,
    );
  }
```

3. `skillsProviderFor` — add `behavior: AssistantBehavior | null = null` and apply both filters in the closure:

```ts
    return async () =>
      mergedSkillSources(
        applyBehaviorToPlugins(plugins, behavior),
        filterSkillSources(await listSkillSourcesFor(db, owner, orgId), behavior),
      ).skills;
```

The closure captures build-time behavior on purpose: every behavior PATCH evicts the cache (Task 2), so a stale closure never outlives its config. Say so in a comment.

4. `buildAssistantSession` — parse once and thread through:

```ts
    const behavior = parseAssistantBehavior(assistant.behavior, assistant.id);
    // ...
    const extras = await this.sessionExtras(principal, meta.orgId, pins, behavior);
    const skillsProvider = this.skillsProviderFor(principal, meta.orgId, behavior);
```

The OTHER three callers of `sessionExtras`/`skillsProviderFor` (`buildSession`, `buildChildSession`, `buildWorkflowSession` — grep for them) pass nothing new and keep today's behavior via the defaults. Do not touch them.

- [ ] **Step 5: Run the suites**

Run: `pnpm --filter @valet/api test persona`, then `pnpm --filter @valet/api test` (full package), then `pnpm --filter @valet/engine test happy-path`
Expected: PASS. NOTE: `model-resolution`/`llm-providers` tests fail if `ANTHROPIC_API_KEY` is exported in your shell — that is environmental, verify via `make e2e` at the end instead of chasing it.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck
git add packages/api/src/assistants/persona.ts packages/api/src/assistants/persona.test.ts packages/api/src/engine/host.ts
git commit -m "feat(api): assistant sessions enforce behavior config at wake"
```

---

### Task 4: Editor catalog data + `/assistants/$assistantId` page

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`PluginSummary`), `packages/api/src/routes/plugins.ts` (GET /)
- Create: `packages/web/src/routes/assistants.$assistantId.tsx`
- Test: `packages/web/src/routes/-assistants.editor.test.tsx`

**Interfaces:**
- Consumes: wire `AssistantBehavior` + Task 2 summary fields; `useAssistants`, `usePatchAssistant`, `useArchiveAssistant` (`~/api/assistants`); `usePlugins` (`~/api/integrations`); `useSkills` (`~/api/skills`, takes `{ ownerType, ownerId }`); `useTeams`, `useMe`, `useOrg` (`~/api/settings`); `canAdministerGroup`-style role rule (`TeamSummary.callerRole`, `me.orgRole`).
- Produces:
  - Wire: `PluginSummary.actionServices: PluginActionServiceSummary[]` — action lists keyed by ROUTING service (the key `AssistantBehavior.integrations` uses). The existing `services[].actions` is keyed by credential service and misses credential-less plugins, so the editor cannot use it.
  - Page component `AssistantEditorPage` + exported pure helpers `integrationOptions(plugins)` and `canEditAssistant(assistant, teams, me)` for the tests.

- [ ] **Step 1: Add `actionServices` to the plugins listing**

`packages/api/src/wire/types.ts`, next to `PluginServiceSummary`:

```ts
/** A plugin's actions grouped by ActionPlugin routing service — the key
 * `AssistantBehavior.integrations` entries use. `services[].actions` groups
 * by CREDENTIAL service instead and omits credential-less plugins, so the
 * assistant editor reads this list. */
export interface PluginActionServiceSummary {
  service: string;
  dynamic?: true;
  actions: PluginActionSummary[];
}
```

Add `actionServices: PluginActionServiceSummary[];` to `PluginSummary`.

In `packages/api/src/routes/plugins.ts` (inside the `summaries` map, where `actionsByCredentialKey` is built), build the routing-key grouping from the same loop's data:

```ts
    const actionServices: PluginActionServiceSummary[] = actionPlugins.map((actionPlugin) => ({
      service: actionPlugin.service,
      ...(actionPlugin.resolveActions !== undefined ? { dynamic: true as const } : {}),
      actions: actionPlugin.actions.map((action) => ({
        id: action.id.includes(".") ? action.id : `${actionPlugin.service}.${action.id}`,
        name: action.name,
        riskLevel: action.riskLevel,
        requiresApproval:
          approvalModeForAction(action.riskLevel, actionPlugin.defaultApprovalMode) ===
          "require_approval",
      })),
    }));
```

and include `actionServices` in the returned summary. Extend `packages/api/src/routes/plugins.test.ts` (or the existing plugins test file) with one assertion: a credential-less plugin's actions appear in `actionServices`.

- [ ] **Step 2: Write the failing web tests**

Create `packages/web/src/routes/-assistants.editor.test.tsx`. Mirror the mock harness of `-settings.sections.test.tsx` (`vi.mock` of `@tanstack/react-router` with `createFileRoute: () => (config: unknown) => config` plus `useParams`/`useNavigate`, and `vi.mock` of `~/api/assistants`, `~/api/integrations`, `~/api/skills`, `~/api/settings` with `importOriginal` spreads). Cover, at minimum:

```ts
// 1. integrationOptions() flattens PluginSummary.actionServices into
//    [{ service, label, actions }] rows, labelled by displayName ?? name,
//    one row per routing service.
// 2. canEditAssistant(): own assistant → true; team assistant + callerRole
//    "member" + orgRole "member" → false; callerRole "admin" → true;
//    orgRole "admin" → true.
// 3. Render: a member viewing a team assistant sees inputs disabled and the
//    text "Only team admins can edit this assistant."
// 4. Saving identity fires usePatchAssistant's mutate with
//    { id, body: { name, personality } }.
// 5. Choosing "Only these" for skills and checking one skill, then saving,
//    fires mutate with body.behavior.skills = { mode: "allowlist", names: [...] }.
// 6. An allowlisted skill name missing from the catalog renders a
//    "not found" chip.
```

Write them as real tests with the harness's `render(<AssistantEditorPage />)` + `fireEvent`/`userEvent`, asserting on the mocked mutations' calls (see `-settings.sections.test.tsx` for the exact idiom).

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @valet/web test assistants.editor`
Expected: FAIL — route module missing.

- [ ] **Step 4: Build the page**

Create `packages/web/src/routes/assistants.$assistantId.tsx`. Skeleton (fill in with the house style — `Section`/`FieldRow` from `~/components/settings/`, primitives from `~/components/primitives`, native checkbox/radio/textarea inputs styled like `IdentityFields`):

```tsx
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import type {
  AssistantBehavior,
  AssistantSummary,
  PluginSummary,
  TeamSummary,
} from "@valet/api/wire";
import { useAssistants, usePatchAssistant, useArchiveAssistant } from "~/api/assistants";
import { usePlugins } from "~/api/integrations";
import { useSkills } from "~/api/skills";
import { useMe, useTeams } from "~/api/settings";
import { assistantLabel } from "~/components/session/assistant-rail";
import { errorText } from "~/lib/error-text";

export const Route = createFileRoute("/assistants/$assistantId")({
  component: AssistantEditorPage,
});

/** One row per ActionPlugin routing service, across every plugin. */
export function integrationOptions(
  plugins: PluginSummary[] | undefined,
): { service: string; label: string; actions: { id: string; name: string }[] }[] {
  if (!plugins) return [];
  return plugins.flatMap((p) =>
    (p.actionServices ?? [])
      .filter((s) => s.actions.length > 0 || s.dynamic === true)
      .map((s) => ({
        service: s.service,
        label: p.displayName ?? p.name,
        actions: s.actions.map((a) => ({ id: a.id, name: a.name })),
      })),
  );
}

/** The rail's administer rule, restated for one assistant: yours always;
 * a team's needs team admin or org admin. The API still 404s a non-admin
 * write — this only decides read-only rendering. */
export function canEditAssistant(
  assistant: AssistantSummary,
  teams: TeamSummary[] | undefined,
  me: { id: string; orgRole: "admin" | "member" } | undefined,
): boolean {
  if (assistant.owner.type === "user") return true;
  if (me?.orgRole === "admin") return true;
  const team = teams?.find((t) => t.id === assistant.owner.id);
  return team?.callerRole === "admin";
}

export function AssistantEditorPage() {
  const { assistantId } = Route.useParams();
  // useAssistants() + find by id. Loading → Spinner; missing → "This
  // assistant does not exist or you cannot view it. Open /chat and pick one
  // from the sidebar." with a Link to /chat.
  // Sections (each with its own local state + per-section Save button,
  // disabled while !canEdit; errors inline via errorText(mutation.error)):
  //   1. Ownership clause line (workspace-clause convention): personal —
  //      "This assistant stays in your personal workspace."; team —
  //      "This assistant belongs to {team}. Everyone on the team can use it."
  //   2. Identity — name Input + personality textarea →
  //      patch.mutate({ id, body: { name, personality } })
  //      (send personality: null when the textarea is emptied).
  //   3. Skills — radio all/allowlist (useSkills({ ownerType, ownerId }) +
  //      plugin skills from useSkills() origin === "plugin"); checked names
  //      → body.behavior (merge with the integrations half of the current
  //      form state). Dangling names (in behavior, not in catalog) render
  //      as removable "not found" chips.
  //   4. Integrations — radio all/allowlist over integrationOptions(
  //      usePlugins().data?.plugins); expanding a checked service shows its
  //      actions with per-action "exclude" checkboxes → excludeActions.
  //   5. Manage — "Make default" (hidden when isDefault) and "Archive"
  //      (ConfirmDialog; disabled with the make-another-default hint when
  //      isDefault — same copy as the rail). Archive success → navigate
  //      to /chat.
  // Read-only note when !canEdit: "Only team admins can edit this assistant."
}
```

Behavior form state: keep ONE `AssistantBehavior | null` in state, initialized from `assistant.behavior ?? null`; the skills and integrations sections each edit their half and one "Save behavior" per section sends the whole object (`body: { behavior }`). Simplest correct merge; no cross-section clobber because both read the same state.

- [ ] **Step 5: Run the web tests**

Run: `pnpm --filter @valet/web test assistants.editor`
Expected: PASS.

- [ ] **Step 6: Regenerate the route tree, typecheck, commit**

The TanStack Router vite plugin regenerates `src/routeTree.gen.ts` on dev/build. Run: `pnpm --filter @valet/web build` (regenerates + typechecks). Then:

```bash
pnpm typecheck
git add -A packages/web packages/api
git commit -m "feat(web): assistant editor page at /assistants/:assistantId"
```

---

### Task 5: Rail entry point, docs, full validation

**Files:**
- Modify: `packages/web/src/components/session/assistant-rail.tsx` (`AssistantRow` dropdown, ~line 409)
- Modify: `docs/specs/2026-08-18-assistant-editor-design.md` (Status line)
- Test: full `make e2e`

- [ ] **Step 1: Add "Edit assistant" to the rail dropdown**

In `AssistantRow`'s `DropdownMenuContent`, above "Rename":

```tsx
            <DropdownMenuItem asChild>
              <Link to="/assistants/$assistantId" params={{ assistantId: assistant.id }}>
                Edit assistant
              </Link>
            </DropdownMenuItem>
```

Keep Rename/Make default/Archive as they are (fast paths). The item renders inside the existing `canAdminister` guard, which matches the editor's own rule.

- [ ] **Step 2: Verify in the running app**

Follow CLAUDE.md "Start the local stack cleanly" (check ports 8788/5173, `lsof +D ~/.valet/pg`, then `make dev-local`; remember the Task 2 `rm -rf ~/.valet/pg` if not yet done on this checkout). In the browser: create a team assistant from the rail, open Edit assistant, set a personality, restrict skills + integrations with one exclude, save each section, reload, confirm the values persist. Confirm a plain member sees read-only.

- [ ] **Step 3: Flip the spec status**

In `docs/specs/2026-08-18-assistant-editor-design.md` change the Status line to `Status: implemented.` (keep the rest).

- [ ] **Step 4: Full validation**

Run: `make e2e 2>&1 | tee /tmp/e2e-assistant-editor.log` — capture the FULL scorecard, never grep/tail it. Every red row must be a named pre-existing environmental failure. Re-run any flaky Docker row in isolation (`make e2e E2E_ARGS="--only <suite-id>"`) before treating it as real.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): rail links to the assistant editor; spec status"
```
