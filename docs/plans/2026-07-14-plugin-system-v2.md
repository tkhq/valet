# Plugin System v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the plugin system v2 spec (`docs/specs/2026-07-13-plugin-system-v2-design.md`): the `ValetPlugin` manifest in `@valet/engine`, both loaders + assembler in `packages/api`, durable credentials, the real workflow `invokeAction`, and the in-place fleet port of every action-bearing plugin to engine-native shapes.

**Architecture:** The engine already owns the target action shape (`ActionPlugin`/`PluginAction` in `packages/engine/src/plugin-catalog.ts`, exposed via `list_tools`/`call_tool`). This plan adds the `ValetPlugin` manifest around it, gives `packages/api` a loader/assembler that feeds catalog tools + skills/roles into every `EngineHost` session builder, backs credentials with an encrypted sqlite `CredentialStore`, and converts the legacy Zod plugins in place — `plugin-github`'s already-ported `actions.ts` is the template. MCP-proxy plugins (8 of them) get a new `resolveActions` dynamic seam on `ActionPlugin`.

**Tech Stack:** TypeScript, TypeBox (`typebox` + `typebox/value`), better-sqlite3/Drizzle (api app DB), node:crypto AES-256-GCM, vitest, React 19 (web settings surface).

## Global Constraints

Copied from the spec and CLAUDE.md; every task's requirements include these.

- **No compat adapter, no dual trees**: legacy Zod modules are *replaced*, not shadowed. A plugin in the tree IS a v2 plugin.
- **Execute bodies move line-for-line.** The port changes types around fetch/API logic, never the logic inside it. Reviewers flag any body diff that isn't type-plumbing.
- **`analytics`, `guardConfig`, `attribution`, `callerIdentity` absences**: preserve the branch, hard-code the v2 value to the absent case, add a `V2-GAP:` comment. `callerIdentity?.name` reads MAY map to `ctx.actor?.name` where semantics match.
- Per-port tests: mocked-`fetch` request-shape (method, URL, headers, body) + response-mapping tests for each action's happy path + one error path. No live external calls in CI.
- Type safety (CLAUDE.md): no `any`, no `as unknown as T`, no `@ts-ignore`. Narrow, don't assert.
- Pre-1.0 migrations: edit `packages/api/migrations/0000_talented_medusa.sql` + `packages/api/src/schema/index.ts` in place; NO new numbered migrations; `rm ~/.valet/app.db` after schema edits.
- The legacy worker (`packages/worker`) is frozen and pins pre-conversion for deploys. Its typecheck failures GROW during this plan — that is sanctioned (Task 14 formalizes it).
- Commits: terse, no Co-Authored-By/AI mentions.
- **Environment (every Bash invocation)**: `source ~/.nvm/nvm.sh && nvm use` inline per call (fresh shell each call; forgetting → better-sqlite3 NODE_MODULE_VERSION errors). Run test commands from the repo root with `pnpm --filter <pkg> test -- <pattern>`.
- Engine/api/web suites must stay green: `pnpm --filter @valet/engine test`, `pnpm --filter @valet/api test` (skip key-gated), `pnpm --filter @valet/web test`. Known pre-existing flake: `packages/api` `messages.abort.test.ts` (ignore). Known pre-existing typecheck failure: `packages/worker/src/integrations/packages.ts` (sanctioned; expands during this plan).

## Locked Decisions

1. **`ValetPlugin` lives in `@valet/engine`** (`src/valet-plugin.ts`), composed only of engine-owned types. No `transports` field yet — the v2 ChannelTransport contract doesn't exist in code; Phase 7 (Telegram) adds the field together with the contract. (Deviation from the spec's sketch, which listed `transports?: ChannelTransportFactory[]`; YAGNI until the type exists.)
2. **`TriggerDef.verify` may return a Promise** (spec sketch showed sync; GitHub HMAC verification is async via `crypto.subtle`/node crypto and there's no reason to force sync).
3. **Manifest validation is a hand-rolled structural validator** (`validateValetPlugin`), not a pure TypeBox schema — manifests contain functions (`execute`, `verify`, `toSignal`, `resolveActions`), which JSON Schema can't express. Data fields get exact checks; function fields get `typeof === "function"` checks.
4. **MCP-proxy plugins use a new dynamic seam**: `ActionPlugin.resolveActions?: (ctx: { credentials: CredentialProvider }) => Promise<PluginAction[]>`. `list_tools`/`call_tool` consult it lazily with the plugin's scoped credentials and cache results per catalog instance (per-session, so no cross-user leakage) for 5 minutes. Static `actions` and resolved actions merge; resolution failure surfaces as a per-service warning in `list_tools`, never throws out of the tool.
5. **`call_tool` gains param validation** (closes an existing gap): `Value.Default` (applies TypeBox `{default: …}` annotations, replacing Zod's `.default()`) then `Value.Check`; on mismatch return a text error with the first 3 `Value.Errors`. Exported as `prepareActionArgs(schema, params)` so the workflow `ActionInvoker` (Task 6) reuses it.
6. **Zod `.default(x)` ports to `Type.Optional(Type.X({ default: x }))`** — call_tool's `Value.Default` applies it, so execute bodies keep reading `p.foo` unchanged (bodies stay verbatim).
7. **Credential shape in v2 actions**: flat `ctx.credentials.access_token` reads become `(await ctx.credentials.get())?.accessToken` (the github template's `getOctokit` pattern). `bot_token` → also `accessToken` (the store's `type` field records that it's a bot token). Worker-injected extras (slack's `owner_slack_user_id`) → `credential.metadata?.[key]` with a `V2-GAP:` comment where the api doesn't populate it yet.
8. **Durable credentials**: `SqliteCredentialStore` in `packages/api` implementing the engine `CredentialStore` port over a new `credentials` app table; `accessToken`/`refreshToken`/`apiKey` encrypted at rest with AES-256-GCM keyed from `VALET_ENCRYPTION_KEY` (sha-256 of it). Replaces `InMemoryCredentialStore` in `providers/node.ts` and `_setup.ts`.
9. **Connect UX in this plan is manual token entry** (paste a token/API key per service in the web settings page). The OAuth dance (client ids, redirect flows, consent) belongs to the auth/login design pass and is NOT in this plan. The Phase 6 exit criterion "connect one OAuth service" is satisfied by pasting an OAuth access token for that service; the flow automation lands with auth.
10. **Two loaders, deduped by the assembler**: bundled registry (`packages/api/src/plugins/registry.gen.ts`, emitted by `scripts/generate-v2-registry.ts` scanning `packages/plugin-*/plugin.yaml` for `v2: true`, honoring `enabled: false`) and a node_modules scanner (top-level dirs of provided search paths, `package.json` `valet.plugin` marker, `VALET_PLUGINS` allow/deny). Workspace plugins are found by BOTH; the assembler dedupes by `name`, bundled wins. Cross-plugin name collisions (two distinct plugins, same name) fail assembly loudly.
11. **Quarantine**: a node_modules plugin that fails import or validation logs one structured `console.error` and is skipped; boot proceeds. Bundled-registry plugins are compile-time — a validation failure there is a hard boot error (it means we shipped a broken manifest).
12. **All four session builders get plugin extras** (orchestrator, generic, child, workflow): `pluginCatalogTools({ plugins })` appended to `tools`, plugin `skills`/`roles` passed through. Orchestrator keeps its memory tools first. The catalog pair is credential-gated and costs ~2 tool slots — safe everywhere.
13. **Workflow `invokeAction` executes directly** (no `call_tool`, no approval gate): the workflow definition is user-authored and approvals are modeled as workflow `approval` nodes. The synthesized `PluginActionContext` for headless invocation has `requestDecision` reject with a pointer to approval nodes, and a stub `sandbox` whose methods throw `"sandbox unavailable in workflow action invocation"` — the fleet's actions are fetch-based and touch neither.
14. **`invokeAction` dedup is durable**: new `action_invocations` app table (`invocation_id` PK, `result` JSON). Duplicate `invocationId` returns the stored result byte-identically (the `@valet/workflow` tool-node contract).
15. **Owner→credential mapping for workflows**: run owner `user:{id}` → `CredentialOwner {type:"user"}`, `org:{id}` → `{type:"org"}`; anything else → `{ok:false, error}` result (no throw).
16. **Skills/roles load at manifest-build time via module-relative fs reads**: `plugin.ts` does `readFileSync(fileURLToPath(new URL("../skills/x.md", import.meta.url)))` + `loadSkillFromMarkdown(content, "plugin")`. Works for both loaders on Node (dist/plugin.js sits next to skills/ in the package). Cloudflare-class runtimes would need inlining — out of scope, noted in the spec.
17. **Fleet scope**: static ports = gmail (13), google-calendar (5), google-workspace (drive 15 + docs 26 + sheets 37), slack actions (11); github is already action-ported (Task 7 completes its manifest/triggers/declaration). MCP octet = cloudflare, deepwiki, figma (`enabled: false` honored), linear, notion, sentry, stripe, typefully via one shared v2 helper. Content-only manifests = browser, workflows, sandbox-tunnels, personas. **Deleted**: plugin-1password (empty scaffold), plugin-memory-compaction (retired per spec). **`rm -rf`'d** (untracked dead dirs): plugin-grafana, plugin-granola, plugin-pylon, plugin-socket, plugin-turnkey-docs, plugin-google-docs, plugin-google-drive, plugin-google-sheets stale dists. plugin-telegram keeps its package with a manifest stub (no actions; transport lands Phase 7); its legacy `src/channels/` is deleted. plugin-email-auth / plugin-google-auth (identity providers) are worker-only — untouched, not v2 plugins.
18. **`@valet/sdk` surgery, not deletion**: the Zod integration contracts (`src/integrations/`) and legacy channel contracts (`src/channels/`) are deleted at the end of Wave 1 (Task 14). The MCP client (`src/mcp/client.ts`, `oauth.ts`) survives and gains the v2 `mcpActionPlugin` helper; `src/ui/`, `src/meta.ts` survive (worker/client still import them from the frozen pin — main-branch worker breakage is sanctioned).
19. **Root typecheck excludes `packages/worker`** from Task 14 on (it cannot typecheck against v2 plugin shapes and is pinned for deploys). CLAUDE.md records this. `packages/client` stays (it doesn't import plugin packages).
20. **`make generate-registries` is retargeted**: it now runs `scripts/generate-v2-registry.ts` (emitting the api registry) and NO LONGER regenerates the worker registries (their checked-in generated files stay stale, matching the frozen-worker policy).
21. **GitHub triggers port**: legacy `TriggerSource` (`verifySignature` HMAC-SHA256 over `X-Hub-Signature-256` + `parseWebhook`) becomes one `TriggerDef` per legacy event family (`github.<eventType>` ids from `listEventTypes()`), sharing one verify implementation. `dispatchId` = `X-GitHub-Delivery`. `toSignal` → `SignalContent { kind:"signal", signalType: "github.<eventType>", body: JSON.stringify(payload), attributes: { deliveryId, action? } }`. The HTTP ingress route is NOT in this plan (spec: lands with consumers).
22. **New routes** (Task 15): `GET /api/plugins` (manifest + declaration + connected summary), `GET /api/credentials`, `PUT /api/credentials/:service`, `DELETE /api/credentials/:service` — all scoped to the authenticated user (`CredentialOwner {type:"user", id: userId}`). No org-level credential UI in this plan.

## File Structure

```
packages/engine/src/
  valet-plugin.ts            # NEW: ValetPlugin, CredentialDeclaration, TriggerDef, VerifiedEvent, validateValetPlugin
  plugin-catalog.ts          # MODIFIED: resolveActions seam, param validation, prepareActionArgs export
  index.ts                   # MODIFIED: new exports
packages/api/
  migrations/0000_talented_medusa.sql   # MODIFIED in place: credentials, action_invocations tables
  src/schema/index.ts        # MODIFIED: matching Drizzle tables
  src/lib/secret-crypto.ts   # NEW: AES-256-GCM encrypt/decrypt helpers
  src/plugins/
    credential-store.ts      # NEW: SqliteCredentialStore (engine CredentialStore impl)
    registry.gen.ts          # GENERATED: bundled plugin imports (checked in)
    node-modules-loader.ts   # NEW: marker scan + dynamic import + quarantine
    assemble.ts              # NEW: dedupe, collision check, session extras, service index
    action-invoker.ts        # NEW: headless invoke + durable dedup (workflow invokeAction receiver)
  src/routes/plugins.ts      # NEW: GET /api/plugins
  src/routes/credentials.ts  # NEW: GET/PUT/DELETE /api/credentials
  src/engine/host.ts         # MODIFIED: plugins opt → session extras in all four builders
  src/providers/node.ts      # MODIFIED: load+assemble plugins, SqliteCredentialStore, ActionInvoker
  src/workflows/engine-deps.ts # MODIFIED: real invokeAction
  src/integration/_setup.ts  # MODIFIED: plugins?: ValetPlugin[] injection
scripts/generate-v2-registry.ts  # NEW: v2 registry generator
packages/sdk/src/mcp/action-plugin.ts # NEW: mcpActionPlugin() v2 helper
packages/plugin-*/src/plugin.ts       # NEW per plugin: the ValetPlugin manifest
packages/plugin-*/plugin.yaml         # MODIFIED per plugin: v2: true
packages/web/src/routes/integrations.tsx + components/integrations/  # NEW: settings surface
```

---

### Task 1: `ValetPlugin` manifest, trigger/credential contracts, and validation (engine)

**Files:**
- Create: `packages/engine/src/valet-plugin.ts`
- Create: `packages/engine/test/valet-plugin.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: `ActionPlugin` from `./plugin-catalog.js`; `SkillSource`, `RoleSpec`, `SignalContent` from `./types.js`.
- Produces (later tasks rely on these exact names): `ValetPlugin`, `CredentialDeclaration`, `TriggerDef`, `VerifiedEvent`, `PluginValidationIssue`, `validateValetPlugin(value: unknown): { ok: true; plugin: ValetPlugin } | { ok: false; issues: PluginValidationIssue[] }` — all exported from `@valet/engine`.

- [ ] **Step 1: Write failing tests** in `packages/engine/test/valet-plugin.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { validateValetPlugin, type ValetPlugin } from "../src/index.js";

function minimalPlugin(): ValetPlugin {
  return { name: "demo", version: "1.0.0" };
}

describe("validateValetPlugin", () => {
  it("accepts a minimal manifest", () => {
    const res = validateValetPlugin(minimalPlugin());
    expect(res.ok).toBe(true);
  });

  it("accepts a full manifest with actions, triggers, skills, roles, credentials", () => {
    const plugin: ValetPlugin = {
      name: "demo",
      version: "1.0.0",
      description: "demo plugin",
      actions: [
        {
          service: "demo",
          actions: [
            {
              id: "demo.ping",
              name: "Ping",
              description: "ping",
              riskLevel: "low",
              parameters: Type.Object({}),
              execute: async () => ({ success: true }),
            },
          ],
        },
      ],
      triggers: [
        {
          id: "demo.event",
          service: "demo",
          description: "an event",
          verify: () => null,
          toSignal: () => ({
            signal: { kind: "signal", signalType: "demo.event", body: "{}" },
            dispatchId: "d-1",
          }),
        },
      ],
      skills: [{ name: "demo-skill", content: "# Demo" }],
      roles: [{ name: "demo-role", content: "You are demo." }],
      credentials: [{ type: "api_key", configKeys: ["accessToken"] }],
    };
    const res = validateValetPlugin(plugin);
    expect(res.ok).toBe(true);
  });

  it("rejects non-objects and missing name/version with paths", () => {
    expect(validateValetPlugin(null).ok).toBe(false);
    expect(validateValetPlugin("nope").ok).toBe(false);
    const res = validateValetPlugin({ version: "1.0.0" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.path === "name")).toBe(true);
  });

  it("rejects invalid plugin names (must be kebab, start with a letter)", () => {
    for (const bad of ["Demo", "1demo", "demo_x", "demo x", ""]) {
      const res = validateValetPlugin({ name: bad, version: "1" });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects an action missing execute, with an indexed path", () => {
    const res = validateValetPlugin({
      name: "demo",
      version: "1",
      actions: [
        {
          service: "demo",
          actions: [
            { id: "demo.x", name: "X", description: "x", riskLevel: "low", parameters: Type.Object({}) },
          ],
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.path).toBe("actions[0].actions[0].execute");
  });

  it("rejects a bad riskLevel and a bad credential type", () => {
    const badRisk = validateValetPlugin({
      name: "demo",
      version: "1",
      actions: [
        {
          service: "demo",
          actions: [
            { id: "demo.x", name: "X", description: "x", riskLevel: "extreme", parameters: Type.Object({}), execute: async () => ({ success: true }) },
          ],
        },
      ],
    });
    expect(badRisk.ok).toBe(false);
    const badCred = validateValetPlugin({ name: "demo", version: "1", credentials: [{ type: "password", configKeys: [] }] });
    expect(badCred.ok).toBe(false);
  });

  it("rejects a trigger whose verify/toSignal are not functions", () => {
    const res = validateValetPlugin({
      name: "demo",
      version: "1",
      triggers: [{ id: "demo.e", service: "demo", description: "e", verify: "nope", toSignal: {} }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paths = res.issues.map((i) => i.path);
      expect(paths).toContain("triggers[0].verify");
      expect(paths).toContain("triggers[0].toSignal");
    }
  });

  it("collects multiple issues rather than stopping at the first", () => {
    const res = validateValetPlugin({ name: "Bad Name", version: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `pnpm --filter @valet/engine test -- valet-plugin` → FAIL (module not found).

- [ ] **Step 3: Implement** `packages/engine/src/valet-plugin.ts`:

```typescript
/**
 * The ValetPlugin manifest — the single seam between plugin packages and
 * hosts (spec: docs/specs/2026-07-13-plugin-system-v2-design.md). Composes
 * only engine-owned types; the engine gains no dependencies.
 *
 * Entry-point convention: a plugin package declares
 * `"valet": { "plugin": "./dist/plugin.js" }` in package.json; that
 * module's default export is a ValetPlugin, or a
 * `() => ValetPlugin | Promise<ValetPlugin>` factory. The marker's presence
 * is the whole contract — a package without it is not a plugin.
 *
 * No `transports` field yet: the v2 ChannelTransport contract lands with
 * the first channel plugin (Telegram, Phase 7) and the field is added then.
 */
import type { ActionPlugin } from "./plugin-catalog.js";
import type { RiskLevel, SignalContent, SkillSource, RoleSpec } from "./types.js";

export interface CredentialDeclaration {
  /** Service the credential is stored under. Defaults to the plugin name. */
  service?: string;
  type: "oauth2" | "api_key" | "bot_token" | "service_account";
  /** OAuth scopes, for oauth2 declarations. */
  scopes?: string[];
  /** Keys the plugin's actions read off the resolved Credential (e.g. ["accessToken"]). */
  configKeys: string[];
  /** Human copy for connect UI. */
  connectLabel?: string;
}

/** A webhook event that passed signature verification. */
export interface VerifiedEvent {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  /**
   * Signature verification over the exact raw request bytes, BEFORE any
   * parsing. Return null to reject. May be async (HMAC via node/web crypto).
   */
  verify(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  /** Normalize a verified event into an admissible signal. */
  toSignal(event: VerifiedEvent): {
    signal: SignalContent;
    dispatchId: string;
    conversationKey?: string;
  };
}

export interface ValetPlugin {
  /** Plugin id, e.g. "github". Unique across loaded plugins. */
  name: string;
  version: string;
  description?: string;
  actions?: ActionPlugin[];
  triggers?: TriggerDef[];
  skills?: SkillSource[];
  roles?: RoleSpec[];
  credentials?: CredentialDeclaration[];
}

export interface PluginValidationIssue {
  path: string;
  message: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const CREDENTIAL_TYPES = ["oauth2", "api_key", "bot_token", "service_account"] as const;

/**
 * Structural validation of an unknown value as a ValetPlugin. Hand-rolled
 * rather than a TypeBox schema because manifests carry functions (execute,
 * verify, toSignal, resolveActions), which JSON Schema cannot express.
 * Collects every issue instead of failing fast so quarantine logs are
 * actionable in one pass.
 */
export function validateValetPlugin(
  value: unknown,
): { ok: true; plugin: ValetPlugin } | { ok: false; issues: PluginValidationIssue[] } {
  const issues: PluginValidationIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string" || !NAME_RE.test(v.name)) {
    issues.push({ path: "name", message: "required string matching /^[a-z][a-z0-9-]*$/" });
  }
  if (typeof v.version !== "string" || v.version.length === 0) {
    issues.push({ path: "version", message: "required non-empty string" });
  }
  if (v.description !== undefined && typeof v.description !== "string") {
    issues.push({ path: "description", message: "must be a string when present" });
  }

  checkArray(v.actions, "actions", issues, (p, path) => {
    const plugin = asRecord(p, path, issues);
    if (!plugin) return;
    if (typeof plugin.service !== "string" || plugin.service.length === 0) {
      issues.push({ path: `${path}.service`, message: "required non-empty string" });
    }
    if (plugin.resolveActions !== undefined && typeof plugin.resolveActions !== "function") {
      issues.push({ path: `${path}.resolveActions`, message: "must be a function when present" });
    }
    if (!Array.isArray(plugin.actions)) {
      issues.push({ path: `${path}.actions`, message: "required array" });
      return;
    }
    plugin.actions.forEach((a, i) => {
      const action = asRecord(a, `${path}.actions[${i}]`, issues);
      if (!action) return;
      for (const key of ["id", "name", "description"] as const) {
        if (typeof action[key] !== "string" || action[key].length === 0) {
          issues.push({ path: `${path}.actions[${i}].${key}`, message: "required non-empty string" });
        }
      }
      if (!RISK_LEVELS.includes(action.riskLevel as RiskLevel)) {
        issues.push({ path: `${path}.actions[${i}].riskLevel`, message: `must be one of ${RISK_LEVELS.join("|")}` });
      }
      if (typeof action.parameters !== "object" || action.parameters === null) {
        issues.push({ path: `${path}.actions[${i}].parameters`, message: "required schema object" });
      }
      if (typeof action.execute !== "function") {
        issues.push({ path: `${path}.actions[${i}].execute`, message: "required function" });
      }
    });
  });

  checkArray(v.triggers, "triggers", issues, (t, path) => {
    const trigger = asRecord(t, path, issues);
    if (!trigger) return;
    for (const key of ["id", "service", "description"] as const) {
      if (typeof trigger[key] !== "string" || trigger[key].length === 0) {
        issues.push({ path: `${path}.${key}`, message: "required non-empty string" });
      }
    }
    for (const key of ["verify", "toSignal"] as const) {
      if (typeof trigger[key] !== "function") {
        issues.push({ path: `${path}.${key}`, message: "required function" });
      }
    }
  });

  checkArray(v.skills, "skills", issues, (s, path) => {
    const skill = asRecord(s, path, issues);
    if (!skill) return;
    if (typeof skill.name !== "string" || skill.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof skill.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.roles, "roles", issues, (r, path) => {
    const role = asRecord(r, path, issues);
    if (!role) return;
    if (typeof role.name !== "string" || role.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof role.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.credentials, "credentials", issues, (c, path) => {
    const cred = asRecord(c, path, issues);
    if (!cred) return;
    if (!CREDENTIAL_TYPES.includes(cred.type as (typeof CREDENTIAL_TYPES)[number])) {
      issues.push({ path: `${path}.type`, message: `must be one of ${CREDENTIAL_TYPES.join("|")}` });
    }
    if (!Array.isArray(cred.configKeys) || cred.configKeys.some((k) => typeof k !== "string")) {
      issues.push({ path: `${path}.configKeys`, message: "required string array" });
    }
    if (cred.service !== undefined && typeof cred.service !== "string") {
      issues.push({ path: `${path}.service`, message: "must be a string when present" });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plugin: value as ValetPlugin };
}

function checkArray(
  value: unknown,
  field: string,
  issues: PluginValidationIssue[],
  each: (item: unknown, path: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: "must be an array when present" });
    return;
  }
  value.forEach((item, i) => each(item, `${field}[${i}]`));
}

function asRecord(
  value: unknown,
  path: string,
  issues: PluginValidationIssue[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  return value as Record<string, unknown>;
}
```

Note: the `resolveActions` check on `actions[]` entries anticipates Task 2's seam; it validates as an optional function even before the catalog consumes it.

- [ ] **Step 4: Export from `packages/engine/src/index.ts`** (append near the plugin-catalog export block):

```typescript
export {
  validateValetPlugin,
  type ValetPlugin,
  type CredentialDeclaration,
  type TriggerDef,
  type VerifiedEvent,
  type PluginValidationIssue,
} from "./valet-plugin.js";
```

- [ ] **Step 5: Run tests**: `pnpm --filter @valet/engine test -- valet-plugin` → PASS. Then full engine suite + `pnpm --filter @valet/engine exec tsc --noEmit` (or the package's typecheck script).

- [ ] **Step 6: Commit**: `feat(engine): ValetPlugin manifest, trigger/credential contracts, validation`

---

### Task 2: Dynamic actions seam + param validation in the plugin catalog (engine)

**Files:**
- Modify: `packages/engine/src/plugin-catalog.ts`
- Modify: `packages/engine/src/index.ts` (export `prepareActionArgs`)
- Test: `packages/engine/test/plugin-catalog.test.ts` (extend existing file)

**Interfaces:**
- Consumes: existing `Catalog`/`makeListTool`/`makeCallTool` internals; `CredentialProvider` from `./types.js`; `Value` from `typebox/value`.
- Produces:
  - `ActionPlugin.resolveActions?: (ctx: { credentials: CredentialProvider }) => Promise<PluginAction[]>` (public field, JSDoc contract: idempotent, MAY throw, called with plugin-scoped credentials).
  - `prepareActionArgs(schema: TSchema, params: Record<string, unknown> | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; error: string }` — applies `Value.Default` (on a structuredClone of params) then `Value.Check`; error text includes up to 3 `Value.Errors` paths. Exported from `@valet/engine` (Task 6's ActionInvoker reuses it).
  - `RESOLVE_TTL_MS = 300_000` (exported const, tests may need it).

**Behavior to implement:**

1. Add `resolveActions` to `ActionPlugin` with the JSDoc contract from decision 4.
2. `buildCatalog` result gains `dynamicPlugins: ActionPlugin[]` (those with `resolveActions`) and a mutable `resolved: Map<string, { entries: CatalogEntry[]; byId: Map<string, CatalogEntry>; fetchedAt: number }>` keyed by service. Add a `now: () => number` parameter to `pluginCatalogTools` options (`PluginCatalogOptions.clock?: () => number`, default `Date.now`) so TTL is testable.
3. New internal `async resolveDynamic(catalog, service, ctx)`: returns cached entry when `now() - fetchedAt < RESOLVE_TTL_MS`; otherwise calls `plugin.resolveActions({ credentials: scopedCredentialProvider(ctx, plugin.credentialService ?? plugin.service) })`, builds entries/byId the same way `buildCatalog` does, caches, returns. Throws propagate to the caller (callers decide warning vs error text).
4. `list_tools`: after filtering static entries, for each dynamic plugin whose service passes the `service` filter, `try { merge resolveDynamic entries (then apply the same query filter) } catch (err) { warnings.push({ service, reason: \`action discovery failed: ${message}\` }) }`. Credential warnings must also cover dynamic-only services.
5. `call_tool`: on `byId` miss, if `tool_id` contains `"."`, take the prefix before the first `"."`; if a dynamic plugin's service matches, `try { resolveDynamic then look up in its byId } catch → return { text: \`error resolving ${service} tools: ...\` }`. Still-unknown → existing unknown-tool_id text.
6. Param validation in `call_tool`, after the approval gate and before execute:

```typescript
const prepared = prepareActionArgs(entry.action.parameters, a.params);
if (!prepared.ok) {
  return { text: `invalid params for ${a.tool_id}: ${prepared.error}` };
}
// pass prepared.args (typed via Static cast as today) into execute
```

7. `prepareActionArgs` implementation (new exported function in plugin-catalog.ts):

```typescript
import { Value } from "typebox/value";

export function prepareActionArgs(
  schema: TSchema,
  params: Record<string, unknown> | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const withDefaults = Value.Default(schema, structuredClone(params ?? {}));
  if (Value.Check(schema, withDefaults)) {
    return { ok: true, args: withDefaults as Record<string, unknown> };
  }
  const errors = [...Value.Errors(schema, withDefaults)].slice(0, 3);
  const detail = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
  return { ok: false, error: detail || "params did not match the schema" };
}
```

**Tests to add** (extend `packages/engine/test/plugin-catalog.test.ts`; reuse its existing fixture helpers/ctx builder):

- `list_tools` merges resolveActions results with static actions and lists both, with correct `tool_id`s.
- `resolveActions` failure → `list_tools` returns the static tools plus a `warnings` entry `{ service, reason: /action discovery failed/ }`; does not throw.
- `resolveActions` is called once across two `list_tools` calls within the TTL, and again after advancing the injected clock past `RESOLVE_TTL_MS` (count invocations with a closure).
- `call_tool` on a dynamic-only tool_id resolves then executes.
- `call_tool` rejects params that fail the schema with `invalid params for` text and does NOT call execute.
- `call_tool` applies TypeBox `{ default: … }` annotations: schema `Type.Object({ n: Type.Optional(Type.Number({ default: 25 })) })`, call with `{}`, execute receives `{ n: 25 }`.
- `prepareActionArgs` unit: default application does not mutate the caller's params object.

- [ ] Steps: write failing tests → red → implement → green (`pnpm --filter @valet/engine test -- plugin-catalog`) → full engine suite + typecheck → commit `feat(engine): dynamic plugin actions seam + call_tool param validation`.

---

### Task 3: Durable encrypted `SqliteCredentialStore` (api)

**Files:**
- Create: `packages/api/src/lib/secret-crypto.ts`
- Create: `packages/api/src/plugins/credential-store.ts`
- Create: `packages/api/src/plugins/credential-store.test.ts`
- Modify: `packages/api/migrations/0000_talented_medusa.sql` (in place), `packages/api/src/schema/index.ts`, `packages/api/src/providers/node.ts`, `packages/api/src/integration/_setup.ts`

**Interfaces:**
- Consumes: engine `CredentialStore`, `CredentialOwner`, `StoredCredential`; the api's Drizzle db handle (follow how other stores in `packages/api` get theirs — e.g. `SqliteWorkflowStore`).
- Produces:
  - `encryptSecret(plaintext: string, key: Buffer): string` / `decryptSecret(ciphertext: string, key: Buffer): string` / `deriveSecretKey(passphrase: string): Buffer` from `src/lib/secret-crypto.ts`.
  - `new SqliteCredentialStore(db, key: Buffer)` implementing engine `CredentialStore` exactly (`get`, `save`, `delete`, `list`).
  - `providers.engineCredentials` becomes a `SqliteCredentialStore` in both `node.ts` and `_setup.ts` (bootTestApi derives a fixed test key, e.g. `deriveSecretKey("test-key")`).

- [ ] **Step 1: Schema.** Add to `0000_talented_medusa.sql` (and mirror in `src/schema/index.ts` Drizzle):

```sql
CREATE TABLE credentials (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  service TEXT NOT NULL,
  type TEXT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  api_key_enc TEXT,
  expires_at INTEGER,
  scopes TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, service)
);
```

`scopes`/`metadata` stored as JSON text. Plaintext secret columns must NOT exist.

- [ ] **Step 2: Failing tests** (`credential-store.test.ts`, use the same in-memory-sqlite + migrations bootstrap other api store tests use):

```typescript
// covers:
// - save then get round-trips a full StoredCredential (oauth2 with refresh, scopes, metadata)
// - get for a missing (owner, service) returns null
// - save overwrites (upsert) and updates updated_at
// - delete removes; list returns [{service, scopes?, connectedAt}] for the owner only (no leakage across owners)
// - secrets are encrypted at rest: raw SELECT of access_token_enc does NOT contain the plaintext token
// - decryptSecret(encryptSecret(x)) === x; tampered ciphertext throws
```

Write them as real vitest cases with concrete values (e.g. token `"tok-secret-123"`, assert `row.access_token_enc` is a string not containing `"tok-secret-123"`).

- [ ] **Step 3: Implement.** `secret-crypto.ts`: AES-256-GCM via `node:crypto`; `deriveSecretKey` = `createHash("sha256").update(passphrase).digest()`; ciphertext format `v1:{iv b64}:{authTag b64}:{ct b64}`; `decryptSecret` throws on bad format/auth failure. `credential-store.ts`: straightforward Drizzle upsert/select/delete keyed by `(owner.type, owner.id, service)`; `list` maps `created_at` → ISO `connectedAt`.

- [ ] **Step 4: Wire.** In `providers/node.ts`, replace `new InMemoryCredentialStore()` with `new SqliteCredentialStore(db, deriveSecretKey(opts.encryptionKey))` — thread `VALET_ENCRYPTION_KEY` from `main.ts` if not already on the opts (it is read there today; if it can be absent, default to `"valet-dev-key"` with a boot warning, matching the local-dev posture). Mirror in `_setup.ts`.

- [ ] **Step 5:** `rm ~/.valet/app.db`. Run `pnpm --filter @valet/api test -- credential-store`, then the api unit suite. Commit `feat(api): durable encrypted credential store`.

---

### Task 4: Loaders, assembler, and the v2 registry generator (api)

**Files:**
- Create: `packages/api/src/plugins/assemble.ts`, `packages/api/src/plugins/node-modules-loader.ts`, `packages/api/src/plugins/registry.gen.ts` (initially trivial), `scripts/generate-v2-registry.ts`
- Create: `packages/api/src/plugins/assemble.test.ts`, `packages/api/src/plugins/node-modules-loader.test.ts`, test fixtures under `packages/api/src/plugins/__fixtures__/`
- Modify: `Makefile` (`generate-registries` target), `packages/api/src/providers/node.ts`, `packages/api/src/integration/_setup.ts`

**Interfaces:**
- Consumes: `ValetPlugin`, `validateValetPlugin` from `@valet/engine` (Task 1).
- Produces:
  - `assemblePlugins(sources: ValetPlugin[][]): { plugins: ValetPlugin[]; actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> }` — flattens loader outputs in priority order (earlier array wins name dedupe), throws `Error` on a *cross-plugin* service or name collision (two different plugin names claiming the same action service), and builds the service index Task 6 uses.
  - `pluginSessionExtras(plugins: ValetPlugin[]): { tools: ToolDef[]; skills: SkillSource[]; roles: RoleSpec[] }` — `tools` is `pluginCatalogTools({ plugins: allActionPlugins })` when any action plugins exist, else `[]`; skills/roles concatenated.
  - `loadNodeModulesPlugins(opts: { searchPaths: string[]; allowlist?: string[]; denylist?: string[] }): Promise<{ plugins: ValetPlugin[]; quarantined: Array<{ pkg: string; reason: string }> }>`.
  - `bundledPlugins: ValetPlugin[]` from `registry.gen.ts` (generated; starts empty).
  - `NodeProviderOpts` gains `plugins?: ValetPlugin[]` override (tests) — default path: `assemblePlugins([bundledPlugins, nodeModulesResult.plugins])`.

**Key content:**

- [ ] **Step 1: `registry.gen.ts` seed** (checked in, regenerated by the script):

```typescript
// AUTO-GENERATED by scripts/generate-v2-registry.ts — do not edit by hand.
// Scans packages/plugin-*/plugin.yaml for `v2: true` (skipping `enabled: false`).
import type { ValetPlugin } from "@valet/engine";

export const bundledPlugins: ValetPlugin[] = [];
```

- [ ] **Step 2: `scripts/generate-v2-registry.ts`** (run with `pnpm tsx` or `bun` from repo root): scan `packages/plugin-*/plugin.yaml` (use the `yaml` package — api already depends on it; do NOT hand-roll a parser); include when `v2 === true` and `enabled !== false`; read the package's `package.json` `name`; emit static imports:

```typescript
import plugin0 from "@valet/plugin-github/plugin";
// …
export const bundledPlugins: ValetPlugin[] = [plugin0 /* … */];
```

Deterministic ordering (sort by package name). If an included package lacks the `./plugin` export or `valet.plugin` marker, fail the script with a clear message. Makefile: `generate-registries:` now runs ONLY this script (delete the worker generator invocation; leave the worker's checked-in generated files untouched).

- [ ] **Step 3: node_modules loader.** For each `searchPaths` entry: `readdir`, descend one level into `@scope/` dirs, read each `package.json`; packages with `valet?.plugin` (string) are candidates. Apply `allowlist`/`denylist` (exact package names; allowlist non-empty → only those). For each candidate: `await import(pathToFileURL(join(pkgDir, marker)).href)`; unwrap `default`; if function, call (await). `validateValetPlugin` the result. Any throw or validation failure → push `{ pkg, reason }` to `quarantined` and `console.error(\`[plugins] quarantined ${pkg}: ${reason}\`)`; never throw out of the loader.

- [ ] **Step 4: Tests.**
  - `assemble.test.ts`: dedupe by name with earlier-source priority; cross-plugin service collision throws with both plugin names in the message; `pluginSessionExtras` returns `[]` tools for zero action plugins and exactly `[list_tools, call_tool]` (by `name`) otherwise; skills/roles concatenation.
  - `node-modules-loader.test.ts`: build two fixture packages on disk under a tmp dir (`fs.mkdtemp`) — `good-plugin` (package.json with marker + a `plugin.mjs` default-exporting a valid manifest) and `bad-plugin` (marker points at a module that throws on import) — assert good loads, bad quarantines with reason, loader returns both results, and a denylisted good plugin is skipped. Use plain `.mjs` fixture files written by the test itself so no build step is needed.
  - Loader parity (spec requirement): a fixture manifest exported both via a registry-style static import and via the node_modules path produces deep-equal `{name, version, actions[].service}` summaries.

- [ ] **Step 5: Wire into `providers/node.ts`**: after `engineCredentials`, `const nm = await loadNodeModulesPlugins({ searchPaths: [<api pkg node_modules>, <repo root node_modules>], allowlist/denylist from VALET_PLUGINS })` where `VALET_PLUGINS` env format is `allow:pkg1,pkg2` / `deny:pkg1` / unset; then `const { plugins, actionPluginByService } = assemblePlugins([bundledPlugins, nm.plugins])`; expose both on the providers object. `_setup.ts`: `opts.plugins ?? []` straight into `assemblePlugins([[...]])` (no node_modules scan in tests).

- [ ] **Step 6:** Suites + typecheck green; `make generate-registries` runs clean (emits the empty registry). Commit `feat(api): plugin loaders, assembler, v2 registry generator`.

---

### Task 5: Session wiring — plugin tools/skills/roles in every EngineHost builder (api)

**Files:**
- Modify: `packages/api/src/engine/host.ts`, `packages/api/src/providers/node.ts`, `packages/api/src/integration/_setup.ts`
- Test: `packages/api/src/engine/host.plugins.test.ts` (new)

**Interfaces:**
- Consumes: `pluginSessionExtras` (Task 4); `EngineHostOpts`.
- Produces: `EngineHostOpts.plugins?: ValetPlugin[]`. All four builders (`buildSession`, `buildOrchestratorSession`, `buildChildSession`, `buildWorkflowSession`) compute `const extras = pluginSessionExtras(this.opts.plugins ?? [])` once (cache it on the host instance — the plugin set is boot-static) and set `tools: [...ownTools, ...extras.tools]`, `skills: extras.skills.length ? extras.skills : undefined`, `roles: extras.roles.length ? extras.roles : undefined`. Orchestrator keeps `buildMemoryTools()` FIRST in the array.

- [ ] **Step 1: Failing test** (`host.plugins.test.ts`, using `bootTestApi({ plugins: [fixturePlugin] })` where the fixture has one action plugin with a `demo.ping` low-risk action and one skill): create an orchestrator session via `providers.engineHost.orchestratorSessionFor(...)`, submit a prompt that the VirtualSandbox model path won't drive — instead, assert structurally: the session's live tool list includes `list_tools` and `call_tool` (find whatever accessor the engine exposes; if none, assert via a direct call of the catalog tool from the session options — check how existing host tests assert `buildMemoryTools` presence and mirror that pattern; if nothing exists, add a narrow test-visible accessor rather than casting privates, per CLAUDE.md rule 6).
- [ ] **Step 2:** Also assert a child session (`spawn` path or `buildChildSession` seam used by existing children tests) carries the plugin tools, and that with `plugins: []` nothing is added (tools arrays unchanged from today's snapshots).
- [ ] **Step 3:** Implement; thread `plugins` through both EngineHost constructions (`node.ts`, `_setup.ts` with `opts.plugins ?? []`).
- [ ] **Step 4:** Green + api suite + typecheck. Commit `feat(api): plugin catalog tools + skills/roles in all session builders`.

---

### Task 6: Real workflow `invokeAction` — headless ActionInvoker with durable dedup (api)

**Files:**
- Create: `packages/api/src/plugins/action-invoker.ts`, `packages/api/src/plugins/action-invoker.test.ts`
- Modify: `packages/api/migrations/0000_talented_medusa.sql` + `src/schema/index.ts` (add `action_invocations`), `packages/api/src/workflows/engine-deps.ts` (+ its test), `packages/api/src/providers/node.ts`, `packages/api/src/integration/_setup.ts`

**Interfaces:**
- Consumes: `actionPluginByService` map (Task 4), `SqliteCredentialStore` (Task 3), `prepareActionArgs` (Task 2), the `WorkflowInvokeActionRequest`/`WorkflowInvokeActionResult` contract in `@valet/workflow`'s `engine-deps.ts` (READ ITS JSDOC — it is normative: deterministic `invocationId`, duplicate id returns the original result).
- Produces: `buildActionInvoker(opts: { db; credentials: CredentialStore; actionPluginByService: Map<...> }): (req: WorkflowInvokeActionRequest) => Promise<WorkflowInvokeActionResult>`, wired as the `invokeAction` implementation in `buildWorkflowEngineDeps` (replacing the Phase-6 stub — update the stub's test accordingly).

**Behavior:**

1. Dedup first: `SELECT result FROM action_invocations WHERE invocation_id = ?` → parse and return verbatim.
2. Resolve the service's `ActionPlugin` from the map; if the action id isn't in its static `actions` and the plugin has `resolveActions`, resolve dynamically (with the owner-scoped credential provider built in step 3); unknown service/action → `{ ok: false, error: "unknown action: <service>.<action>" }` (recorded for dedup too — a deterministic failure must also be stable across retries).
3. Owner → `CredentialOwner` per decision 15; build a `CredentialProvider` over the store: `get(svc?) → store.get(owner, svc ?? credentialService)` mapped `StoredCredential → Credential` (`accessToken: stored.accessToken ?? stored.apiKey ?? ""`, empty → return null); `request` → rejects with `"credential requests are not supported in workflow action invocation"`.

```sql
CREATE TABLE action_invocations (
  invocation_id TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

4. Validate params via `prepareActionArgs`; failure → `{ ok:false, error }` (recorded).
5. Synthesize `PluginActionContext`: `userId`/`orgId` from the request's run context (the deps builder already resolves run context for `promptOrchestrator` — reuse `resolveRunContext`), `sessionId: \`wf:invoke:${invocationId}\``, `threadId: "invoke"`, `actionId`, `service`, `summary: req.summary`, `credentials` from step 3, `signal: AbortSignal.timeout(120_000)`, `requestDecision: async () => { throw new Error("approvals are not available in workflow tool nodes — model the gate as an approval node"); }`, `sandbox`: a stub object whose every method throws `"sandbox unavailable in workflow action invocation"` (implement the engine `Sandbox` interface with throwing methods — no `as` casts of `{}`), `threadRead`/`listThreads`/`setModel`: throwing stubs with clear messages.
6. Execute; catch throws → `{ ok:false, error: message }`. Map `PluginActionResult` → `{ ok: result.success, result: result.data, error: result.error }` (attachments dropped with a `V2-GAP:` comment — workflow results are JSON; revisit when workflow artifacts exist).
7. Record: `INSERT OR IGNORE INTO action_invocations` then re-`SELECT` and return the stored row's result (this makes concurrent duplicate invocations converge on one result).

**Tests:** fixture ActionPlugin with a counting `execute`; assert: happy path returns `{ok:true, result}`; same `invocationId` twice → execute called ONCE, identical result; unknown action → stable `{ok:false}` also deduped; param-validation failure path; missing credential → the action still executes and sees `credentials.get() === null` (actions own their missing-token error copy — matches the fleet's `Missing access token` bodies); update `engine-deps.test.ts`'s stub assertion to the new behavior (inject a fixture map via `_setup.ts` opts).

- [ ] Steps: schema edit → `rm ~/.valet/app.db` → failing tests → implement → green → api suite → commit `feat(api): headless action invoker with durable dedup for workflow tool nodes`.

---

### Task 7: plugin-github — manifest, credential declaration, triggers port (Wave 1 start)

**Files:**
- Create: `packages/plugin-github/src/plugin.ts`, `packages/plugin-github/src/triggers-v2.ts` → final name `src/triggers.ts` (REPLACES the legacy file), `packages/plugin-github/src/triggers.test.ts`
- Modify: `packages/plugin-github/plugin.yaml` (add `v2: true`), `packages/plugin-github/package.json` (add `"./plugin"` export + `"valet": { "plugin": "./dist/plugin.js" }` marker + `@valet/engine` dep), `packages/plugin-github/src/actions/index.ts`
- Delete: `packages/plugin-github/src/actions/provider.ts` (legacy OAuth provider — superseded by the credential declaration; OAuth flow lands with the auth pass)
- Untouched: `src/repo*.ts` (worker-only repo-provider concern, not part of the action/trigger surface), `src/actions/actions.ts` (ALREADY engine-native — do not modify), `src/actions/api.ts`, `parse-job-log.ts`
- Regenerate: `make generate-registries` (github enters `registry.gen.ts`); add `@valet/plugin-github: workspace:*` to `packages/api/package.json`

**Interfaces:**
- Consumes: `githubPlugin: ActionPlugin` (existing export from `src/actions/actions.ts`), `ValetPlugin`/`TriggerDef` from `@valet/engine`, the legacy `src/triggers.ts` logic (port source).
- Produces: default export `ValetPlugin` from `src/plugin.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { githubPlugin } from "./actions/actions.js";
import { githubTriggerDefs } from "./triggers.js";

const skillMd = readFileSync(fileURLToPath(new URL("../skills/github.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "github",
  version: "0.1.0",
  description: "GitHub integration for PRs, issues, repos, and webhooks",
  actions: [githubPlugin],
  triggers: githubTriggerDefs,
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "github")],
  credentials: [
    {
      type: "oauth2",
      scopes: ["repo", "read:org"],
      configKeys: ["accessToken"],
      connectLabel: "Connect GitHub (OAuth token or fine-grained PAT)",
    },
  ],
};

export default plugin;
```

(Verify the skill file's relative path and the legacy provider's actual scopes list; copy scopes from the legacy `githubProvider.oauthScopes` verbatim.)

**Triggers port rules:** read the legacy `TriggerSource` in `src/triggers.ts`. For each event type in its `listEventTypes()`, emit a `TriggerDef` with `id: \`github.${eventType}\``, `service: "github"`, shared `verify` = the legacy `verifySignature` HMAC-SHA256 logic over `X-Hub-Signature-256` (timing-safe compare; port the crypto code verbatim, adapting the input from `(headers, rawBody: string, secret)` to `({ headers, rawBody: Uint8Array }, secrets)` — secret key name: `secrets.webhookSecret`; header lookup case-insensitive) that also does the legacy `parseWebhook` normalization and returns `VerifiedEvent { eventType, deliveryId: X-GitHub-Delivery, payload }` (null when the event type doesn't match this def's family or the signature fails). `toSignal` per decision 21. Delete the legacy `TriggerSource` export.

**Tests:** fixture webhook payloads (one `pull_request`, one `issues`) with real computed HMACs — signature valid → `VerifiedEvent` with right eventType/deliveryId; tampered body → null; missing signature header → null; `toSignal` shape assertions (dispatchId = deliveryId, signalType, JSON body).

- [ ] Also update `src/actions/index.ts` to stop re-exporting deleted legacy symbols; `pnpm --filter @valet/plugin-github test` + build green; `make generate-registries`; api typecheck green with the new dep; commit `feat(plugin-github): v2 manifest, credential declaration, TriggerDef port`.

---

### Tasks 8–12: the static fleet ports (shared transform contract)

Tasks 8–12 all apply the SAME mechanical transform; each is one plugin (or one google-workspace half), one implementer, one review gate. **This section is part of each task's requirements.**

**Per-plugin deliverables:** engine-native `src/actions/actions.ts` (replacing the Zod one), `src/plugin.ts` manifest (same pattern as Task 7's, minus triggers unless the plugin has them — none of 8–12 do), `plugin.yaml v2: true`, `package.json` marker + `./plugin` export + swap `@valet/sdk` dep for `@valet/engine`, delete `src/actions/provider.ts`, mocked-fetch tests, `make generate-registries` + api dep, suite + typecheck green, one commit.

**The transform (each rule, applied action-by-action):**
1. `ActionDefinition` metadata → `PluginAction` fields verbatim: `id`, `name`, `description`, `riskLevel`. `params` (Zod) → `parameters` (TypeBox): `z.string()` → `Type.String()`, `.optional()` → `Type.Optional(...)`, `.default(x)` → `Type.Optional(Type.X({ default: x }))` (decision 6 — call_tool applies it), `.describe(s)` → `{ description: s }` options arg, `z.number().int().min(a).max(b)` → `Type.Integer({ minimum: a, maximum: b })`, `z.enum([...])` → `Type.Union([Type.Literal(...)])` or `Type.Enum`, `z.array(X)` → `Type.Array(X)`, `z.record(z.unknown())` → `Type.Record(Type.String(), Type.Unknown())`, `z.boolean()` → `Type.Boolean()`.
2. The central `switch (actionId)` dispatch dissolves: each case's body becomes that action's `execute(args, ctx)`. Use plugin-github's `actions.ts` curried `action(parameters)(rest)` helper pattern (copy the helper) to keep TS inference tractable.
3. **Bodies move line-for-line.** `const p = X.params.parse(params)` lines are DELETED (args arrive validated+defaulted); every subsequent `p.foo` read becomes `args.foo` (pure rename — if the body used a different binding name, keep the body verbatim by opening with `const p = args;`... prefer that: `const p = args;` preserves the body byte-identically).
4. Credentials: `const token = ctx.credentials.access_token || ''` → `const cred = await ctx.credentials.get(); const token = cred?.accessToken ?? "";`. Same for `bot_token`. The follow-on `if (!token) return { success:false, error: 'Missing access token' }` guards stay verbatim.
5. `ActionResult.images` → `PluginActionResult.attachments`: `{ data: base64, mimeType, description }` → `{ type: "image", data: Buffer.from(base64, "base64"), mimeType, name: description }` at the return boundary only.
6. `ctx.analytics` / `ctx.guardConfig` / `ctx.attribution` / `ctx.callerIdentity` per Global Constraints (`V2-GAP:` comments; `callerIdentity?.name` → `ctx.actor?.name` where it's a display-name use).
7. Export `const <service>Plugin: ActionPlugin = { service: "<service>", description, actions: [ …all… ] }`.

**Per-plugin tests:** for EACH action: one happy-path test stubbing `globalThis.fetch` (vitest `vi.stubGlobal`) asserting method/URL/headers/body and the mapped `PluginActionResult.data`; one error-path test per plugin module (e.g. 401/403 mapping) — plus keep any behavior the legacy code special-cased (pagination loops, status-specific error copy) covered where it exists.

**Credential declarations per task:**

| Task | Plugin | actions | declaration |
|---|---|---|---|
| 8 | plugin-gmail | 13 | `{ type: "oauth2", scopes: <copy from legacy provider>, configKeys: ["accessToken", "refreshToken"], connectLabel: "Connect Gmail" }` |
| 9 | plugin-google-calendar | 5 | same pattern, calendar scopes |
| 10 | plugin-google-workspace (drive + docs modules) | 15 + 26 | one declaration on the single workspace plugin (Task 10 adds it), workspace scopes |
| 11 | plugin-google-workspace (sheets module) | 37 | (declaration exists from Task 10) |
| 12 | plugin-slack | 11 | `{ type: "bot_token", configKeys: ["accessToken"], connectLabel: "Connect Slack (bot token)" }` |

**Task 10/11 split:** google-workspace is one package/one `ActionPlugin` (`service: "google-workspace"`? — NO: verify the legacy service ids; if drive/docs/sheets registered as separate services or one, PRESERVE the legacy action ids exactly, e.g. `drive.list_files`). Task 10 ports `drive-actions.ts` + `docs-actions.ts` + creates `src/plugin.ts` with the actions ported so far + the label-guard `V2-GAP` handling; Task 11 ports `sheets-actions.ts` and appends to the same plugin. Task 11's manifest work is only the append.

**Task 12 extras (slack):** delete `packages/plugin-slack/src/channels/` entirely (legacy transport; v2 transport lands with the Slack channel phase; the manifest ships actions+skill only). `owner_slack_user_id` reads → `cred?.metadata?.["owner_slack_user_id"]` narrowed to string, with `V2-GAP: identity-link injection not yet wired in v2 hosts` on the branch.

- [ ] Task 8: gmail — transform + tests + manifest + regen + commit `feat(plugin-gmail): port to engine-native v2 shapes`
- [ ] Task 9: google-calendar — same; commit `feat(plugin-google-calendar): port to engine-native v2 shapes`
- [ ] Task 10: google-workspace drive+docs + manifest; commit `feat(plugin-google-workspace): port drive+docs to v2, manifest`
- [ ] Task 11: google-workspace sheets; commit `feat(plugin-google-workspace): port sheets to v2`
- [ ] Task 12: slack actions + channels deletion; commit `feat(plugin-slack): port actions to v2, drop legacy channel transport`

---

### Task 13: MCP octet — v2 `mcpActionPlugin` helper + 8 manifests

**Files:**
- Create: `packages/sdk/src/mcp/action-plugin.ts`, `packages/sdk/src/mcp/action-plugin.test.ts`
- Create: `src/plugin.ts` in each of plugin-cloudflare, plugin-deepwiki, plugin-figma, plugin-linear, plugin-notion, plugin-sentry, plugin-stripe, plugin-typefully; update each `plugin.yaml` (`v2: true`; figma keeps `enabled: false`), `package.json` (marker, `./plugin` export, `@valet/engine` dep)
- Modify: `packages/sdk/src/mcp/index.ts` (export), delete each plugin's legacy `src/actions/` files
- Regenerate: `make generate-registries`; add api deps for the 7 enabled ones

**Interfaces:**
- Consumes: the existing `McpActionSource` internals (`packages/sdk/src/mcp/action-source.ts` — the MCP client call, `mapToolToAction`, auth header/`authQueryParam` handling) as the port source; `ActionPlugin`, `PluginAction`, `CredentialProvider` from `@valet/engine` (Task 2's `resolveActions` seam).
- Produces:

```typescript
export interface McpActionPluginOptions {
  mcpUrl: string;
  serviceName: string;
  defaultRiskLevel: RiskLevel;
  noAuth?: boolean;
  /** Send the credential as this URL query param instead of an Authorization header. */
  authQueryParam?: string;
  description?: string;
}
export function mcpActionPlugin(opts: McpActionPluginOptions): ActionPlugin;
```

Returns `{ service: opts.serviceName, description, actions: [], resolveActions }` where `resolveActions({ credentials })`:
1. `const cred = opts.noAuth ? null : await credentials.get();` — no credential and not `noAuth` → throw `Error(\`${serviceName}: no credential connected\`)` (surfaces as the list_tools warning).
2. Calls the MCP server's tool-list exactly as the legacy `listActions` did (lift the client invocation + `mapToolToAction` mapping verbatim, adapting output to `PluginAction`): `id: \`${serviceName}.${tool.name}\``, `name`/`description` from the tool, `riskLevel: defaultRiskLevel`, `parameters`: the tool's `inputSchema` as `TSchema` (JSON-Schema-shaped objects are structurally assignable to TypeBox's empty-interface `TSchema` — same note as `submission-node.ts`; if the server omits a schema use `Type.Record(Type.String(), Type.Unknown())`).
3. Each generated action's `execute(args, ctx)` re-reads the credential via `ctx.credentials.get()` and calls the MCP tool exactly as legacy `execute` did (verbatim call/auth/result-mapping logic; `authQueryParam` handling preserved).

**Per-plugin `plugin.ts`** (deepwiki example — the others differ only in options + declaration):

```typescript
import { mcpActionPlugin } from "@valet/sdk/mcp";
import type { ValetPlugin } from "@valet/engine";

const plugin: ValetPlugin = {
  name: "deepwiki",
  version: "0.1.0",
  description: "DeepWiki knowledge base (MCP)",
  actions: [
    mcpActionPlugin({ mcpUrl: "https://mcp.deepwiki.com/mcp", serviceName: "deepwiki", defaultRiskLevel: "low", noAuth: true }),
  ],
};
export default plugin;
```

Copy each plugin's exact legacy options (`mcpUrl`, `defaultRiskLevel`, `authQueryParam` for typefully) from its current `actions.ts`, then delete the legacy files. Credential declarations: `{ type: "oauth2", configKeys: ["accessToken"] }` for cloudflare/figma/linear/notion/sentry/stripe; `{ type: "api_key", configKeys: ["accessToken"], connectLabel: "Typefully API key" }` for typefully; none for deepwiki.

**Tests** (`action-plugin.test.ts`, mocked fetch/MCP transport): `resolveActions` maps a fixture MCP tool list to `PluginAction[]` with prefixed ids and passthrough schemas; missing credential throws the connect message; `noAuth` skips the credential read; a generated action's `execute` sends the Authorization header (and the query-param variant for `authQueryParam`); result mapping matches legacy (lift a fixture from any existing McpActionSource test if present).

- [ ] Green + regen + api typecheck; commit `feat(sdk,plugins): v2 mcpActionPlugin + MCP plugin manifests`.

---

### Task 14: Content manifests, tree cleanup, SDK legacy deletion, typecheck policy

**Files:**
- Create: `src/plugin.ts` + `package.json` (name `@valet/plugin-<x>`, marker, `./plugin` export, `@valet/engine` dep, minimal tsconfig/build matching other content plugins) for: plugin-browser, plugin-workflows, plugin-sandbox-tunnels, plugin-personas — each manifest is `{ name, version: "0.1.0", skills: [loadSkillFromMarkdown(...each skills/*.md...)] }` (personas: load `personas/*.md` via `loadRoleFromMarkdown` into `roles`). plugin-telegram: `src/plugin.ts` manifest stub `{ name: "telegram", version: "0.1.0", description: "Telegram channel (transport lands in Phase 7)" }`, delete `src/channels/`.
- Delete: `packages/plugin-1password/`, `packages/plugin-memory-compaction/` (git rm); `rm -rf` the untracked dead dirs (plugin-grafana, plugin-granola, plugin-pylon, plugin-socket, plugin-turnkey-docs, plugin-google-docs, plugin-google-drive, plugin-google-sheets).
- Delete: `packages/sdk/src/integrations/` (the Zod `ActionSource` surface) and `packages/sdk/src/channels/` (legacy channel contracts); update `packages/sdk/src/index.ts` + package.json exports; `src/mcp/action-source.ts` (legacy McpActionSource) is deleted too — its logic now lives in `action-plugin.ts`.
- Modify: root typecheck to exclude `packages/worker` (find the root script — turbo/pnpm recursive — and add the exclusion filter); CLAUDE.md: replace the `packages/worker/src/integrations/packages.ts` sanctioned-failure note with "packages/worker is excluded from root typecheck (frozen; pins pre-conversion commit `<record the pin sha: git log -1 --format=%h -- the last commit before Task 7>` for deploys)"; also update CLAUDE.md's "Adding a new plugin" section to describe the v2 flow (plugin.ts manifest, v2: true, generate-registries) and note the retired worker registry generation.
- Regenerate registries; add api deps for the four content plugins + telegram? (telegram has no content/actions → still include for the loader-visibility exit criterion? NO — a manifest with nothing in it adds noise; leave telegram OUT of the api deps/registry until Phase 7. Its manifest exists so Phase 7 only adds the transport.)

- [ ] Verify: `pnpm typecheck` (new exclusion) green everywhere else — this is the gate proving the in-place conversion left no dangling imports outside the frozen worker. Full api/engine/web/sdk/plugin suites green. `docs/specs/2026-07-13-plugin-system-v2-design.md`: append an "Implementation notes" section recording decisions 1, 2, 4, 9 (transports deferred; async verify; resolveActions seam; manual-token connect). Commit `chore(plugins,sdk): content manifests, legacy contract deletion, worker typecheck exclusion`.

---

### Task 15: Connect surface — plugin/credential routes + web integrations page

**Files:**
- Create: `packages/api/src/routes/plugins.ts`, `packages/api/src/routes/credentials.ts` (+ colocated `.test.ts` files following existing route-test patterns), mount both in the api app builder (follow how `routes/workflows.ts` is mounted)
- Create: `packages/web/src/routes/integrations.tsx`, `packages/web/src/components/integrations/` (list + connect form), `packages/web/src/api/integrations.ts` (query-key factory per web conventions); add the nav link wherever the web app's nav registers routes (check the existing sidebar/nav component)
- Test: web component tests per existing patterns

**Routes (all require auth; owner = current user):**
- `GET /api/plugins` → `{ plugins: [{ name, version, description, actionCount, services: [{ service, type, scopes?, connectLabel?, configKeys, connected: boolean }] }] }` — from `providers.plugins` manifests + `CredentialStore.list({type:"user", id})`. Plugins without declarations list with `services: []`. `actionCount` = static actions only (dynamic noted as `dynamic: true` on the service entry when `resolveActions` present).
- `GET /api/credentials` → `{ credentials: [{ service, type, scopes?, connectedAt }] }` (never returns secret material).
- `PUT /api/credentials/:service` body `{ type: "oauth2"|"api_key"|"bot_token"|"service_account", accessToken?: string, apiKey?: string, refreshToken?: string, metadata?: Record<string,unknown> }` — 400 unless exactly one of accessToken/apiKey present (or both for oauth2+refresh); saves via the store; 200 `{ ok: true }`.
- `DELETE /api/credentials/:service` → 200.

**Web page:** `/integrations`: card per plugin (name, description, action count), per-service row with connected badge or a "Connect" reveal-form (token textarea + type-appropriate label from `connectLabel`, save → PUT, disconnect button → DELETE with confirm). Spartan, matching the existing settings-page idiom (find the closest existing page — e.g. whatever `/workflows` index uses — and mirror its components). After connect, invalidate the plugins query.

**Route tests:** PUT then GET shows `connected: true` and never leaks the token; DELETE flips it back; PUT validation 400s; unauthenticated 401 (match existing route-test auth harness); GET /api/plugins reflects a fixture plugin injected via `bootTestApi({ plugins })`.

- [ ] Green (api + web suites) → commit `feat(api,web): integrations connect surface (manual token entry)`.

---

### Task 16: Exit-criteria integration test + dogfood

**Files:**
- Create: `packages/api/src/integration/plugins.e2e.test.ts`
- Modify (if needed): `packages/api/src/integration/_setup.ts` (nothing expected beyond Task 4's `plugins` opt)

**Automated exit checks (key-gated where the model is needed, mirroring `workflow-run.e2e.test.ts`'s gating pattern):**
1. **Orchestrator lists and calls ported actions with per-user credentials** (real Anthropic + fixture service): boot with the REAL bundled registry (`bundledPlugins`) + a fixture credential saved for `local-user` on a mocked-fetch-backed service — simplest: use a fixture ValetPlugin for the call itself, plus assert the real registry's plugins all pass `validateValetPlugin` and assemble without collision. Drive an orchestrator prompt "use list_tools then call demo.ping and tell me the result"; assert the tool_call parts show `list_tools` then `call_tool` completed and the settle text carries the fixture's response.
2. **node_modules drop-in**: write a fixture plugin package into a tmp dir at test time, boot `loadNodeModulesPlugins` over it, assert it loads; **broken plugin quarantines without killing boot**: sibling bad package quarantined, good one still loads (loader-level assertions — boot-level covered by Task 4's tests).
3. **invokeAction through a workflow tool node** (extends the Phase-5 e2e or standalone): a `tool` node against the fixture service completes with the action result in the node checkpoint; duplicate-dispatch (crash-restart) does not double-execute (assert via the counting fixture + `action_invocations` row count) — reuse Phase 5's restart harness patterns if cheap, else assert dedup at the invoker level and the node completion at the run level.
4. **Credential-unavailable UX**: `list_tools` output includes the `no credential connected` warning for a declared-but-unconnected service.

**Manual dogfood (coordinator, not subagent):** `make dev-local`; in the web UI: `/integrations` shows the fleet; paste a real GitHub token → connected; paste a real API key for one MCP service (typefully or deepwiki needs none — use deepwiki for zero-cred and github for real-cred); in chat ask the orchestrator to list github tools and fetch a real repo's details via `call_tool`; verify a high-risk action (e.g. `github.create_issue` on a scratch repo) raises an approval gate in the bell and completes after approval; confirm `/integrations` disconnect works. Record results in the ledger.

- [ ] Commit `test(api): plugin system exit-criteria e2e`.

---

## Self-Review Notes

- Spec coverage: manifest+entry convention (T1), fleet port w/ verbatim rule (T7–13), channels strategy (T12/T14 deletions, transports deferred — deviation recorded in T14's spec amendment), content mapping (T14), trigger contract + github parser port (T1/T7), credential declarations (T1, per-port), two loaders + assembler + collision + quarantine (T4), catalog/session integration (T5), Wave-2 dogfood (T16), roadmap resequencing (already done). Connect *flows* (OAuth) deliberately out (decision 9) — matches the spec's "platform (login) spec's territory".
- The spec's `transports?: ChannelTransportFactory[]` field is deferred (decision 1) because the type doesn't exist; Phase 7 adds it. The spec's sync `verify` is widened to allow Promise (decision 2). Both amendments are written back to the spec in Task 14.
- Type-consistency: `assemblePlugins`/`pluginSessionExtras`/`loadNodeModulesPlugins`/`bundledPlugins` (T4) are consumed by T5/T6/T15/T16 under those exact names; `prepareActionArgs` (T2) by T6; `validateValetPlugin` (T1) by T4/T16.
