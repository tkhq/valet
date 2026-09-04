# Model Selector Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface model size tiers, an approved-models allowlist, and reasoning levels across the API, engine, and web UI.

**Architecture:** The backend tier system (TKAI-285) already resolves tier tokens; this plan adds the org allowlist and reasoning settings as new services + thin Hono routes, threads two new preference cascades through `resolveModelForBuild`/`resolveReasoningForBuild` in `EngineHost`, adds a persisted reasoning knob to the engine (session + thread, mirroring the model pin), and rebuilds the web pickers tier-first.

**Tech Stack:** Hono, Drizzle (PGlite dev), pi-ai/pi-agent-core, Vite + React 19 + TanStack Query, vitest.

**Spec:** `docs/specs/2026-09-03-model-selector-overhaul-design.md` — read it before any task.

## Global Constraints

- Branch `conner/model-selector-overhaul`, base `dev-v2`. PRs target `dev-v2`.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` and `packages/store-postgres/migrations/pg/0000_engine.sql` IN PLACE. No numbered migrations.
- Every new app-table column needs a `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`. The new engine-table column needs a repair ALTER too, and NO `ENGINE_SCHEMA_VERSION` bump.
- After schema edits run `make dev-clean` in any worktree with dev data.
- Tier tokens: `xs, s, m, l, xl`. Labels: Extra Small, Small, Medium, Large, X-Large.
- Reasoning tokens (pi-ai `ThinkingLevel`), ordered: `minimal < low < medium < high < xhigh < max`. Unset = inherit.
- Type safety rules from CLAUDE.md: no `any`, no double-casts, no ts-ignore.
- Error messages name the corrective action (CLAUDE.md rule).
- Test commands: `pnpm --filter @valet/api test <filter>`, `pnpm --filter @valet/engine test <filter>`. NEVER put `--` before the filter (vitest drops it and runs everything).
- Commit per task, subject ≤72 chars, no AI co-author trailers.

---

### Task 1: Schema — six new columns + repairs

**Files:**
- Modify: `packages/api/src/schema/index.ts` (orgs ~line 70, users ~line 104, teams ~line 486, assistants ~line 520-551)
- Modify: `packages/api/migrations/pg/0000_app.sql`
- Modify: `packages/api/src/lib/drizzle.ts` (`SCHEMA_REPAIRS` array, pattern at lines 419-423)

**Interfaces:**
- Produces Drizzle columns: `orgs.approvedModels` (jsonb, nullable), `orgs.reasoningSettings` (jsonb, nullable), `users.defaultReasoning` (text, nullable), `teams.defaultReasoning` (text, nullable), `assistants.model` (text, nullable), `assistants.reasoning` (text, nullable).

- [ ] **Step 1: Add the Drizzle columns**

In `packages/api/src/schema/index.ts`, next to the existing fields:

```ts
// orgs, after modelTiers:
  /** Org allowlist of selectable model ids. Null = whole catalog approved.
   * Empty array is rejected at the API. Admins bypass the list. */
  approvedModels: jsonb("approved_models"),
  /** { default?: ThinkingLevel, max?: ThinkingLevel }. Null = no default,
   * no cap. */
  reasoningSettings: jsonb("reasoning_settings"),

// users, after defaultModel:
  /** Personal default reasoning level. Null = inherit. */
  defaultReasoning: text("default_reasoning"),

// teams, after defaultModel:
  /** Team default reasoning level. Null = inherit. */
  defaultReasoning: text("default_reasoning"),

// assistants, after behavior:
  /** Tier token or catalog model id. Null = inherit the cascade. */
  model: text("model"),
  /** Reasoning level. Null = inherit the cascade. */
  reasoning: text("reasoning"),
```

- [ ] **Step 2: Mirror in `0000_app.sql`**

Add matching columns to the `orgs`, `users`, `teams`, `assistants` CREATE TABLE statements: `"approved_models" jsonb`, `"reasoning_settings" jsonb`, `"default_reasoning" text`, `"default_reasoning" text`, `"model" text`, `"reasoning" text`.

- [ ] **Step 3: Add six SCHEMA_REPAIRS entries**

Copy the `orgs.model_tiers` pattern (drizzle.ts:419-423), one entry per column, e.g.:

```ts
{
  describe: "orgs.approved_models column",
  probe: { kind: "column", table: "orgs", column: "approved_models" },
  sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "approved_models" jsonb',
},
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck` → clean. Run: `pnpm --filter @valet/api test drizzle` → PASS (the repair probe self-test covers new entries).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql packages/api/src/lib/drizzle.ts
git commit -m "feat(api): schema for approved models, reasoning settings, assistant model"
```

---

### Task 2: Reasoning service

**Files:**
- Create: `packages/api/src/services/reasoning.ts`
- Test: `packages/api/src/services/reasoning.test.ts`

**Interfaces:**
- Produces:
  - `REASONING_LEVELS = ["minimal","low","medium","high","xhigh","max"] as const`, `type ReasoningLevel`, `REASONING_SET: ReadonlySet<string>`
  - `compareReasoning(a: ReasoningLevel, b: ReasoningLevel): number` (order index diff)
  - `clampToMax(level: ReasoningLevel, max: ReasoningLevel | undefined): ReasoningLevel`
  - `interface OrgReasoningSettings { default?: ReasoningLevel; max?: ReasoningLevel }`
  - `getOrgReasoningSettings(db: AppQueryable, orgId: string): Promise<OrgReasoningSettings>` (null/invalid column → `{}`)
  - `setOrgReasoningSettings(db: AppQueryable, orgId: string, s: OrgReasoningSettings): Promise<void>`
  - `assertReasoningSelectable(db: AppQueryable, orgId: string, level: string): Promise<string | null>` — returns an error message string, or null when OK. Unknown token → `"Unknown reasoning level \"<x>\". Valid levels: minimal, low, medium, high, xhigh, max."`; above cap → `"Reasoning level \"<x>\" exceeds the org max (\"<max>\"). Ask an org admin to raise the cap in Settings → Organization → Models."`

Model the file on `packages/api/src/services/model-tiers.ts` (read it first — same imports, same jsonb read/merge style, `orgs.reasoningSettings` column).

- [ ] **Step 1: Write failing tests** (`reasoning.test.ts`, fixture pattern copied from `model-tiers.test.ts` — `freshTestPgDb`, insert org row):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs } from "../schema/index.js";
import {
  REASONING_LEVELS, compareReasoning, clampToMax,
  getOrgReasoningSettings, setOrgReasoningSettings, assertReasoningSelectable,
} from "./reasoning.js";

const orgId = "org-reasoning";

describe("reasoning", () => {
  let db: AppDb;
  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  it("orders levels minimal < low < medium < high < xhigh < max", () => {
    expect(compareReasoning("minimal", "max")).toBeLessThan(0);
    expect(compareReasoning("high", "low")).toBeGreaterThan(0);
    expect(compareReasoning("medium", "medium")).toBe(0);
  });

  it("clamps to max", () => {
    expect(clampToMax("max", "medium")).toBe("medium");
    expect(clampToMax("low", "medium")).toBe("low");
    expect(clampToMax("high", undefined)).toBe("high");
  });

  it("returns {} when no settings stored", async () => {
    expect(await getOrgReasoningSettings(db, orgId)).toEqual({});
  });

  it("round-trips settings", async () => {
    await setOrgReasoningSettings(db, orgId, { default: "medium", max: "high" });
    expect(await getOrgReasoningSettings(db, orgId)).toEqual({ default: "medium", max: "high" });
  });

  it("rejects unknown level tokens", async () => {
    const err = await assertReasoningSelectable(db, orgId, "ultra");
    expect(err).toMatch(/Unknown reasoning level/);
  });

  it("rejects levels above the org max, for everyone", async () => {
    await setOrgReasoningSettings(db, orgId, { max: "medium" });
    expect(await assertReasoningSelectable(db, orgId, "xhigh")).toMatch(/exceeds the org max/);
    expect(await assertReasoningSelectable(db, orgId, "medium")).toBeNull();
  });

  it("accepts any known level when no cap is set", async () => {
    expect(await assertReasoningSelectable(db, orgId, "max")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test reasoning` → FAIL (module not found).
- [ ] **Step 3: Implement `services/reasoning.ts`** — order via `REASONING_LEVELS.indexOf`; jsonb read validates `default`/`max` against `REASONING_SET` and drops invalid entries.
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit** — `feat(api): reasoning level vocabulary, org settings, cap check`

---

### Task 3: Approved-models service

**Files:**
- Create: `packages/api/src/services/approved-models.ts`
- Test: `packages/api/src/services/approved-models.test.ts`

**Interfaces:**
- Produces:
  - `getApprovedModels(db: AppQueryable, orgId: string): Promise<string[] | null>` (null = unset)
  - `setApprovedModels(db: AppQueryable, orgId: string, approved: string[] | null): Promise<void>`
  - `assertModelSelectable(db: AppQueryable, orgId: string, isOrgAdmin: boolean, spec: string): Promise<string | null>` — null when OK, else `"Model \"<id>\" is not in the org's approved list. Ask an org admin to approve it in Settings → Organization → Models."`
  - `isApproved(approved: string[] | null, spec: string): boolean` (pure; tier tokens always true; null list always true)
- Consumes: `TIER_SET` from `./model-tiers.js` (Task 0, merged).

- [ ] **Step 1: Failing tests** (same fixture pattern as Task 2):

```ts
it("null list approves everything", async () => {
  expect(await assertModelSelectable(db, orgId, false, "anthropic/claude-opus-4-7")).toBeNull();
});
it("tier tokens always pass", async () => {
  await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
  expect(await assertModelSelectable(db, orgId, false, "l")).toBeNull();
  expect(await assertModelSelectable(db, orgId, false, "XL")).toBeNull(); // case-insensitive like resolveModelSpec
});
it("admins always pass", async () => {
  await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
  expect(await assertModelSelectable(db, orgId, true, "openai/gpt-4.1")).toBeNull();
});
it("members are held to the list", async () => {
  await setApprovedModels(db, orgId, ["anthropic/claude-haiku-4-5"]);
  expect(await assertModelSelectable(db, orgId, false, "openai/gpt-4.1")).toMatch(/approved list/);
  expect(await assertModelSelectable(db, orgId, false, "anthropic/claude-haiku-4-5")).toBeNull();
});
it("round-trips and clears", async () => {
  await setApprovedModels(db, orgId, ["a/b"]);
  expect(await getApprovedModels(db, orgId)).toEqual(["a/b"]);
  await setApprovedModels(db, orgId, null);
  expect(await getApprovedModels(db, orgId)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Tier check: `TIER_SET.has(spec.trim().toLowerCase())`.
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Commit** — `feat(api): approved-models allowlist service with soft gate`

---

### Task 4: Wire types

**Files:**
- Modify: `packages/api/src/wire/types.ts`

**Interfaces (produces — exact names later tasks use):**

```ts
export type WireTierMap = Record<"xs" | "s" | "m" | "l" | "xl", string[]>;
export type GetModelTiersResponse = WireTierMap;
export type PatchModelTiersRequest = Partial<WireTierMap>;

export interface GetApprovedModelsResponse { approved: string[] | null }
export interface PutApprovedModelsRequest { approved: string[] | null }
export type PutApprovedModelsResponse = GetApprovedModelsResponse;

export interface OrgReasoningSettings { default?: string; max?: string }
export type GetOrgReasoningResponse = OrgReasoningSettings;
export type PatchOrgReasoningRequest = {
  default?: string | null;   // null clears
  max?: string | null;
};
export type PatchOrgReasoningResponse = OrgReasoningSettings;
```

Plus field additions:
- `ModelInfo`: `approved: boolean;` and `thinkingLevels?: string[];`
- `PatchSessionRequest`, `PatchThreadRequest`: `reasoning?: string | null;`
- `PatchMeRequest`: `defaultReasoning?: string | null;` — `MeResponse`: `defaultReasoning: string | null;`
- `PatchTeamRequest`: `defaultReasoning?: string | null;` — `TeamSummary`: `defaultReasoning?: string | null;`
- `PatchAssistantRequest`: `model?: string | null; reasoning?: string | null;` — `AssistantSummary`: `model?: string | null; reasoning?: string | null;`
- `SessionData` wire read (`SessionResponse`/session summary carrying `model`): sibling `reasoning?: string | null;`; thread read type gains `reasoning?: string | null;` beside `model`.

Follow each type's existing doc-comment style. Every new field gets a one-line doc comment.

- [ ] **Step 1: Add the types/fields.** No test of its own; the compiler is the test.
- [ ] **Step 2: Run `pnpm typecheck`** — expect FAILURES only where routes must now populate required fields (`ModelInfo.approved`). If `approved: boolean` breaks `model-catalog.ts`, set `approved: true` there as a temporary literal (Task 7 replaces it).
- [ ] **Step 3: `pnpm typecheck` clean. Commit** — `feat(api): wire types for tiers, approved models, reasoning`

---

### Task 5: Org routes — approved-models + reasoning

**Files:**
- Create: `packages/api/src/routes/approved-models.ts`
- Create: `packages/api/src/routes/org-reasoning.ts`
- Modify: `packages/api/src/app.ts` (mount beside `app.route("/api/org/model-tiers", ...)`)
- Test: `packages/api/src/services/approved-models.test.ts` (extend), `packages/api/src/services/reasoning.test.ts` (extend)

**Interfaces:**
- Produces routes: `GET/PUT /api/org/approved-models`, `GET/PATCH /api/org/reasoning`.
- Consumes: `requireOrgAdmin` (`routes/_org-admin.ts`), Task 2/3 services, `buildOrgCatalog`/`catalogValidIds` (`services/model-catalog.ts`).

Model both files on `routes/model-tiers.ts` (thin route, validated services). Rules:

- `PUT approved-models`: admin-gated. Body `{ approved: string[] | null }`. `[]` → 400 `"Approved list cannot be empty. To approve the whole catalog, clear the restriction instead."`. Every id must pass `catalogValidIds` → else 400 naming the id and `GET /api/models`. Null clears. Responds with the stored value.
- `PATCH reasoning`: admin-gated. `default`/`max` must be in `REASONING_SET` (or null to clear). After merge, if both set and `compareReasoning(default, max) > 0` → 400 `"Default reasoning level cannot exceed the max."`. GET returns the effective settings (any member).

- [ ] **Step 1: Extend service tests with route-level validation helpers** if you extract any (e.g. a `validateApprovedModelsBody` pure function); route bodies stay uncovered like `model-tiers.ts` (precedent).
- [ ] **Step 2: Implement routes + mount in `app.ts`:**

```ts
app.route("/api/org/approved-models", approvedModelsRouter);
app.route("/api/org/reasoning", orgReasoningRouter);
```

- [ ] **Step 3: `pnpm typecheck` + `pnpm --filter @valet/api test "reasoning|approved"` → PASS.**
- [ ] **Step 4: Commit** — `feat(api): approved-models and org reasoning routes`

---

### Task 6: Tier route — approved-target constraint + wire types

**Files:**
- Modify: `packages/api/src/routes/model-tiers.ts`
- Test: `packages/api/src/services/model-tiers.test.ts` (extend)

**Interfaces:**
- Consumes: `getApprovedModels`, `isApproved` (Task 3); `PatchModelTiersRequest`/`GetModelTiersResponse` (Task 4).

- [ ] **Step 1: Failing test** in `model-tiers.test.ts` — extract the spec-validation loop from the PATCH handler into an exported pure function so it's testable (CLAUDE.md rule: no private-method poking):

```ts
// in routes/model-tiers.ts:
export function tierTargetsNotApproved(merged: TierMap, approved: string[] | null): string | null {
  if (approved === null) return null;
  for (const tier of TIER_TOKENS) {
    for (const spec of merged[tier]) {
      if (!isApproved(approved, spec)) {
        return `Model "${spec}" in tier "${tier}" is not approved. Approve it first in Settings → Organization → Models.`;
      }
    }
  }
  return null;
}
```

Test: merged map with an unapproved spec returns the message; null list returns null; approved specs return null.

- [ ] **Step 2: Fail, implement, pass.** In the PATCH handler, after catalog validation: `const approvalErr = tierTargetsNotApproved(merged, await getApprovedModels(db, user.orgId)); if (approvalErr) return c.json({ error: approvalErr }, 400);`. Type the handler's request/response with the Task 4 wire types.
- [ ] **Step 3: Commit** — `feat(api): tier targets must be approved models`

---

### Task 7: Catalog — `approved` + `thinkingLevels`

**Files:**
- Modify: `packages/api/src/services/model-catalog.ts` (entry construction at ~lines 86, 191)
- Test: `packages/api/src/services/model-catalog.test.ts` (or the suite that covers `buildOrgCatalog` — find with `grep -rl buildOrgCatalog packages/api/src --include='*.test.ts'`)

**Interfaces:**
- Produces: every `ModelInfo` from `buildOrgCatalog` carries `approved` (computed via `isApproved(await getApprovedModels(db, orgId), entry.id)`) and `thinkingLevels` (from pi-ai registry `thinkingLevelMap`: the keys whose value is not null, excluding `"off"`; `undefined` when the model has `reasoning: false` or no map).

- [ ] **Step 1: Failing tests:** catalog with an approved list marks members correctly; a registry model with a `thinkingLevelMap` exposes its supported levels; synthesized models expose `thinkingLevels: undefined`.
- [ ] **Step 2: Implement.** `registryModels(kind)` rows are pi-ai `Model` objects — read `m.thinkingLevelMap`. Replace any Task 4 temporary `approved: true` literal.
- [ ] **Step 3: Tests pass; also run `pnpm --filter @valet/api test model-resolution` (guards the env-key trap — run via `make e2e E2E_ARGS="--only <api-unit-suite>"` if `ANTHROPIC_API_KEY` is exported in your shell; see memory note).**
- [ ] **Step 4: Commit** — `feat(api): catalog exposes approved flag and thinking levels`

---

### Task 8: Enforcement at every model/reasoning write

**Files:**
- Modify: `packages/api/src/routes/sessions.ts` (PATCH session, model validation ~line 429-442 pattern)
- Modify: `packages/api/src/routes/messages.ts` (PATCH thread, ~line 355-420)
- Modify: `packages/api/src/routes/me.ts` (or wherever `PATCH /api/me` handles `defaultModel` — find with `grep -rn "defaultModel" packages/api/src/routes`)
- Modify: `packages/api/src/routes/teams.ts` (PATCH team `defaultModel`)
- Test: extend `approved-models.test.ts` / route-adjacent suites for any extracted helper

**Interfaces:**
- Consumes: `assertModelSelectable` (Task 3), `assertReasoningSelectable` (Task 2).
- Produces: 400s with the services' error strings at each write site.

Each handler already resolves the caller; compute `isOrgAdmin` the way `requireOrgAdmin` does (read `_org-admin.ts` and reuse its check, or export a boolean-returning variant `isOrgAdminUser(c)` from `_org-admin.ts`).

- [ ] **Step 1:** For each route: where the body's `model` (or `defaultModel`) is validated today, add `const err = await assertModelSelectable(db, orgId, isAdmin, spec); if (err) return c.json({ error: err }, 400);`. Where `reasoning`/`defaultReasoning` is non-null, add the reasoning check. Null always passes (clearing is always allowed).
- [ ] **Step 2:** `pnpm typecheck`; `pnpm --filter @valet/api test "sessions|messages|teams"` → PASS (existing suites must stay green).
- [ ] **Step 3: Commit** — `feat(api): enforce approved models and reasoning cap at write sites`

Note: this task only VALIDATES `reasoning` on session/thread PATCH — storing/applying it is Task 10/11. If wiring order makes a dangling validated-but-ignored field awkward, reject unknown-field usage is NOT needed; the field is simply validated and passed through to the handlers Task 11 adds.

---

### Task 9: Assistant model/reasoning + `assistantDefault` cascade slot

**Files:**
- Modify: `packages/api/src/routes/assistants.ts` (PATCH handler ~line 135; summary serializer)
- Modify: `packages/api/src/engine/host.ts` (`resolveModelForBuild` :2922-2937, `assistantSessionFor` :2170-2173)
- Test: `packages/api/src/engine/host.model-resolution.test.ts` (extend — it already covers the cascade), assistants route suite if one exists

**Interfaces:**
- Consumes: `assistants.model`/`assistants.reasoning` columns (Task 1), `assertModelSelectable`/`assertReasoningSelectable` (Tasks 2-3).
- Produces: `resolveModelForBuild` `prefs` gains `assistantDefault?: string`; cascade order becomes:

```ts
const id =
  prefs.overrideId ??
  prefs.assistantDefault ??
  prefs.childDefault ??
  (prefs.userId ? await this.userDefaultModel(prefs.userId) : undefined) ??
  (prefs.ownerTeamId ? await this.teamDefaultModel(orgId, prefs.ownerTeamId) : undefined) ??
  (await this.orgPreferredModel(orgId)) ??
  this.opts.defaultModelId ??
  "claude-haiku-4-5";
```

- [ ] **Step 1: Failing cascade test** in `host.model-resolution.test.ts`: with `assistantDefault: "l"` and a user default set, the assistant default wins; with `overrideId` set, the override wins.
- [ ] **Step 2: Implement cascade slot.** Update the doc comment above `resolveModelForBuild` (it enumerates the order).
- [ ] **Step 3: Pass `assistantDefault` from `assistantSessionFor`:** the assistant row is already loaded there — add `assistantDefault: assistant.model ?? undefined` to the `resolveModelForBuild` call at :2170. The value may be a tier token; `resolveModelSpec` already handles it.
- [ ] **Step 4: PATCH assistant route:** accept `model`/`reasoning` (validated via the Task 2/3 helpers, admin flag from the caller's role), persist, echo on `AssistantSummary`. Null clears.
- [ ] **Step 5: Tests pass. Commit** — `feat(api): per-assistant model with assistantDefault cascade slot`

---

### Task 10: Engine — persisted reasoning (session + thread)

The riskiest task; it is the tool-call-persistence round trip's sibling. Read CLAUDE.md "Tool-call persistence round trip" first, and read `thread.setModel` (`packages/engine/src/thread.ts:1732`) + `SessionData.model` handling end to end before writing code.

**Files:**
- Modify: `packages/engine/src/types.ts` (`SessionData`, `CreateSessionOptions` docs, `ThreadData` if the model pin lives there)
- Modify: `packages/engine/src/session.ts` (mirror `setModel` → `setReasoning`), `packages/engine/src/thread.ts` (thread-scoped `setReasoning` + apply in `buildAgent`'s `streamFn` ~line 3881)
- Modify: `packages/store-postgres/migrations/pg/0000_engine.sql` (sessions + threads tables: `"reasoning" text`), `packages/store-postgres/src/helpers.ts` (row interfaces + `rawTo*Row`)
- Modify: `packages/engine/src/in-memory-store.ts` (or wherever the in-memory `SessionStore` lives — find with `grep -rl "InMemory" packages/engine/src`)
- Modify: `packages/api/src/lib/drizzle.ts` — repair ALTERs for the engine columns (`ALTER TABLE "engine_sessions" ...` — check the actual engine table names in `0000_engine.sql`). Do NOT bump `ENGINE_SCHEMA_VERSION`.
- Test: engine suites `happy-path`, `in-memory-store`; `packages/store-postgres` suite

**Interfaces:**
- Produces:
  - `SessionData.reasoning?: string` (persisted; restore-no-clobber like `model`)
  - `session.setReasoning(level: string | null): Promise<void>` — persists on the session row
  - `thread.setReasoning(level: string | null): Promise<void>` and `thread.reasoning(): string | undefined` — thread pin, persisted like the thread model pin
  - Effective level per stream call: `options?.reasoning ?? threadPin ?? session.options.sampling?.reasoning`, clamped with pi-ai `clampThinkingLevel(model, level)` before passing to the stream.
- Consumes: `ThinkingLevel` from `@earendil-works/pi-ai`.

- [ ] **Step 1: Failing engine test** (in the suite that covers `setModel` persistence — find with `grep -rn "setModel" packages/engine/src/*.test.ts packages/engine/test 2>/dev/null`): set a thread reasoning pin, reload the session from the store, assert `thread.reasoning()` survives; same for the session-level value via `SessionData`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** exactly parallel to the model pin. Where `setModel` validates the spec, `setReasoning` validates the token against a local `const REASONING_LEVELS` (engine must not import from `@valet/api`; keep the engine barrel browser-safe — no node builtins).
- [ ] **Step 4: Store round trip:** `0000_engine.sql` columns, `helpers.ts` row mappers, in-memory store parity. Run `pnpm --filter @valet/engine test happy-path`, `pnpm --filter @valet/engine test in-memory-store`, `pnpm --filter @valet/store-postgres test` → PASS.
- [ ] **Step 5: Repair ALTERs** in `drizzle.ts` (engine tables, no version bump — see memory: bumping wipes thread history).
- [ ] **Step 6: `make dev-clean`, `pnpm typecheck`. Commit** — `feat(engine): persisted reasoning level on sessions and threads`

---

### Task 11: Host reasoning cascade + PATCH plumbing

**Files:**
- Modify: `packages/api/src/engine/host.ts` (new `resolveReasoningForBuild`; call it beside every `resolveModelForBuild` call site: :902, :2170, :3031, :3221; pass `sampling: { reasoning }` into the engine session options)
- Modify: `packages/api/src/routes/sessions.ts` (PATCH session `reasoning` → `session.setReasoning`), `packages/api/src/routes/messages.ts` (PATCH thread `reasoning` → `thread.setReasoning`; echo `reasoning` in thread reads beside `model`)
- Modify: `packages/api/src/engine/bridge.ts` / `routes/messages.ts` read paths only if thread reads serialize there — mirror wherever `thread.modelId()` is read back
- Test: `packages/api/src/engine/host.model-resolution.test.ts` (extend with reasoning cascade cases)

**Interfaces:**
- Produces:

```ts
private async resolveReasoningForBuild(
  existing: SessionData | null,
  orgId: string,
  prefs: { userId?: string; ownerTeamId?: string; assistantDefault?: string },
): Promise<string | undefined>
```

Order: `existing?.reasoning → prefs.assistantDefault → userDefaultReasoning(userId) → teamDefaultReasoning(orgId, teamId) → orgReasoningSettings.default → undefined`, then clamp the result to `orgReasoningSettings.max` with `clampToMax`. Restore-no-clobber: `existing?.reasoning` wins outright, same rationale as the model (see the :2898 doc comment).

- Consumes: Task 2 service, Task 10 engine surface, `users.defaultReasoning`/`teams.defaultReasoning` columns.

- [ ] **Step 1: Failing tests:** assistant default beats user default; org default applies when nothing else set; a resolved `xhigh` under `max: "medium"` clamps to `medium`; restore keeps the persisted value.
- [ ] **Step 2: Implement** `userDefaultReasoning`/`teamDefaultReasoning` private helpers (mirror `userDefaultModel` :2865 / `teamDefaultModel` :2886) and wire `sampling: { reasoning }` into each session build. `assistantSessionFor` passes `assistantDefault: assistant.reasoning ?? undefined`.
- [ ] **Step 3: PATCH handlers:** `reasoning` present → validated (Task 8) → `setReasoning(value)` (null clears). Thread reads echo the pin. Follow the four-hop persistence checklist (engine write → wire → REST → frontend extract) — the frontend hop lands in Task 14.
- [ ] **Step 4: Suites:** `pnpm --filter @valet/api test host.model-resolution` + engine suites from Task 10 stay green.
- [ ] **Step 5: Commit** — `feat(api): reasoning cascade and PATCH plumbing`

---

### Task 12: Web foundation — libs, client, hooks

**Files:**
- Create: `packages/web/src/lib/model-tiers.ts`, `packages/web/src/lib/reasoning.ts`
- Modify: `packages/web/src/lib/models.ts` (rename `tier` → `speedClass`; update `model-combobox.tsx:171-175` `tierBadgeVariant` usage)
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/api/settings.ts` (+ its `qkSettings` key map)
- Test: `packages/web/src/lib/model-tiers.test.ts` (vitest, colocated like existing web tests)

**Interfaces (produces):**

```ts
// lib/model-tiers.ts
export const SIZE_TIERS = ["xs", "s", "m", "l", "xl"] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];
export const TIER_LABELS: Record<SizeTier, string> = {
  xs: "Extra Small", s: "Small", m: "Medium", l: "Large", xl: "X-Large",
};
export function isSizeTier(id: string | null | undefined): id is SizeTier;
export function tierLabel(id: string): string; // label, or the id unchanged

// lib/reasoning.ts
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max",
};
export function levelsUpTo(max: string | undefined): ReasoningLevel[]; // cap-filtered list

// api/client.ts additions
getModelTiers: () => request<GetModelTiersResponse>("GET", "/org/model-tiers"),
patchModelTiers: (body: PatchModelTiersRequest) => request<GetModelTiersResponse>("PATCH", "/org/model-tiers", body),
getApprovedModels: () => request<GetApprovedModelsResponse>("GET", "/org/approved-models"),
putApprovedModels: (body: PutApprovedModelsRequest) => request<PutApprovedModelsResponse>("PUT", "/org/approved-models", body),
getOrgReasoning: () => request<GetOrgReasoningResponse>("GET", "/org/reasoning"),
patchOrgReasoning: (body: PatchOrgReasoningRequest) => request<PatchOrgReasoningResponse>("PATCH", "/org/reasoning", body),

// api/settings.ts hooks (pattern: useLlmProviderPreferences / usePutLlmProviderPreferences, settings.ts:196-391)
useModelTiers(), usePatchModelTiers()      // invalidates tiers + models keys
useApprovedModels(), usePutApprovedModels() // invalidates approved + models keys
useOrgReasoning(), usePatchOrgReasoning()
```

- [ ] **Step 1: Failing lib tests** (tier label lookup, `isSizeTier` narrowing, `levelsUpTo("medium")` → `["minimal","low","medium"]`).
- [ ] **Step 2: Implement libs, client methods, hooks, query keys.** `speedClass` rename is mechanical — `grep -rn "\.tier\b" packages/web/src` and fix all sites.
- [ ] **Step 3:** `pnpm --filter @valet/web test model-tiers` → PASS; `pnpm typecheck` clean (note: typecheck skips web test files — memory note — so also run the web test suite).
- [ ] **Step 4: Commit** — `feat(web): tier/reasoning vocab, client methods, hooks`

---

### Task 13: Org settings — tier map, approved models, reasoning sections

**Files:**
- Create: `packages/web/src/components/settings/model-tiers-section.tsx`
- Create: `packages/web/src/components/settings/approved-models-section.tsx`
- Create: `packages/web/src/components/settings/reasoning-section.tsx`
- Modify: `packages/web/src/routes/settings.organization.models.tsx` (render the three new sections after `ModelPreferencesSection`)

**Interfaces:**
- Consumes: Task 12 hooks; row/list UI patterns from `model-preferences-section.tsx` (read it fully first); `useModels()` for the catalog; `TIER_LABELS`, `REASONING_LABELS`.
- Admin gating: follow how `ModelPreferencesSection` disables edits for non-admins (same `useMe()` role check the page already uses).

Behavior:
- **ModelTiersSection:** one row per tier in `SIZE_TIERS` order: label + the tier's ordered target list. Reuse the up/down/remove + `AddModelTypeahead` row pattern from `model-preferences-section.tsx` per tier. Every edit issues `usePatchModelTiers().mutate({ [tier]: newList })`. Show the resolved-first target's catalog name beside the label.
- **ApprovedModelsSection:** a switch "Restrict members to approved models". Off = `approved: null`. Turning on seeds the list with the curated ids present in the catalog (`models.filter(m => curatedForCatalogId(m.id)).map(m => m.id)`). Below, a checkbox list of the full catalog grouped by provider; checking/unchecking issues `usePutApprovedModels()`. Unchecking the last item is blocked in the UI (the API 400s an empty list); show the API error text on failure.
- **ReasoningSection:** two labeled selects (Default, Max) over `REASONING_LEVELS` plus an "Inherit"/"No cap" empty option; `usePatchOrgReasoning().mutate({ default: v || null })`. Default options above the chosen max render disabled.
- All mount-time state derived from query data follows the CLAUDE.md `useState`+`useEffect` sync rule (or better: render directly from query data, mutate on change, no local copy).

- [ ] **Step 1: Implement the three sections + page wiring.**
- [ ] **Step 2: Manual check:** `make dev-local` (check ports per CLAUDE.md first), open `/settings/organization/models`, exercise all three sections; confirm PATCH round trips in the network tab.
- [ ] **Step 3:** `make e2e E2E_ARGS="--only web-build"` → PASS.
- [ ] **Step 4: Commit** — `feat(web): org sections for tiers, approved models, reasoning`

---

### Task 14: Chat model picker — tier-first + reasoning row

**Files:**
- Modify: `packages/web/src/components/session/model-picker.tsx`
- Modify: `packages/web/src/components/session/session-header.tsx` (:435-447 — pass/persist `reasoning`, render the chip)
- Modify: `packages/web/src/api/queries.ts` (`useSetThreadModel` :318 / `useSetSessionModel` :230 — sibling mutations or widened payloads for `reasoning`)
- Test: extend the picker's colocated test if one exists (`ls packages/web/src/components/session/*.test.*`), else add `model-picker.test.tsx` covering the pure helpers

**Interfaces:**
- `ModelPickerProps` gains: `currentReasoning?: string; onSelectReasoning?: (level: string | null) => void;`
- Consumes: `useModelTiers()` (tier → resolved spec for subtitles), `useMe()` (admin flag), `TIER_LABELS`, `levelsUpTo`, `useOrgReasoning()`, `ModelInfo.approved` + `thinkingLevels`.

Behavior (spec §7):
- A "Size" group renders first (before provider groups): five rows in tier order. Row: `TIER_LABELS[tier]` + subtitle = catalog name of the tier's first target (`labelFor(spec, models)`), selected state when `currentId === tier`. Click → `onSelect(tier)` (submits the bare token). Rows join the same `flat` keyboard-nav list.
- The "Models" long tail: members (`!isAdmin`) see `models.filter(m => m.approved)`; admins see all. Curated collapse, show-more, and search behavior stay exactly as-is (:97-114).
- A reasoning row in the sticky footer area (above the count line): segmented buttons for `["default", ...levelsUpTo(orgMax)]`; "default" → `onSelectReasoning(null)`. When `currentId` is a concrete model, levels missing from its `thinkingLevels` render disabled; when `currentId` is a tier, gate on the tier's first target's `thinkingLevels`.
- Trigger label: `isSizeTier(currentId) ? TIER_LABELS[currentId] : labelFor(...)`, and append ` · <level>` when `currentReasoning` is set.
- `session-header.tsx`: thread-scoped reasoning persists via `api.patchThread(sessionId, threadId, { reasoning })`, session-scoped via `api.patchSession(sessionId, { reasoning })` — mirror the existing model branches at :437-447. Display precedence mirrors model: `activeThread ? (activeThread.reasoning ?? session.reasoning) : session.reasoning`.

- [ ] **Step 1: Failing test** for the new pure helper (extract `visibleModels(models, isAdmin)` and `tierSubtitle(tier, tierMap, models)` as exported functions; test approved filtering and tier subtitle resolution).
- [ ] **Step 2: Implement.** Keep keyboard nav uniform: tiers are entries 0-4 of `flat`.
- [ ] **Step 3:** web tests + `make e2e E2E_ARGS="--only web-build"` → PASS. Manual check in `make dev-local`: pick "Large", confirm the PATCH body is `{"model":"l"}` and the chip reads "Large"; set reasoning high, reload the page, confirm both survive (the four-hop round trip).
- [ ] **Step 4: Commit** — `feat(web): tier-first model picker with reasoning row`

---

### Task 15: ModelCombobox surfaces — assistant editor, personal, team

**Files:**
- Modify: `packages/web/src/components/settings/model-combobox.tsx` (tier group first; reasoning is a SEPARATE control, not embedded)
- Create: `packages/web/src/components/settings/reasoning-select.tsx` (small labeled select: Inherit + `levelsUpTo(orgMax)`)
- Modify: `packages/web/src/routes/assistants.$assistantId.tsx` (add "Model" + "Reasoning" field rows → `usePatchAssistant`-equivalent mutation with `{ model }` / `{ reasoning }`, null to clear)
- Modify: `packages/web/src/routes/settings.assistant.tsx` (:46-56 default-model row — combobox now tier-first; add a default-reasoning row → `usePatchMe().mutate({ defaultReasoning })`; update hint copy)
- Modify: the team-defaults editor on `/settings/organization/teams` (find the `defaultModel` control via `grep -rn "defaultModel" packages/web/src/components/settings packages/web/src/routes` — add the reasoning select beside it, `usePatchTeam` with `defaultReasoning`)

**Interfaces:**
- Consumes: everything from Tasks 12; `PatchAssistantRequest.model/reasoning`, `PatchMeRequest.defaultReasoning`, `PatchTeamRequest.defaultReasoning` (Task 4).
- ModelCombobox: prepend a "Size" option group (label + resolved-target subtitle, same data as Task 14) above `curatedMatches`; selecting submits the token. `emptyLabel` behavior unchanged.

- [ ] **Step 1: Implement combobox group + `ReasoningSelect`.**
- [ ] **Step 2: Wire the three surfaces.** Clearing selects null (inherit). Optimistic updates only where the surface already does them (`usePatchTeam` pattern, settings.ts:403-426).
- [ ] **Step 3:** `make e2e E2E_ARGS="--only web-build"`; manual pass over all three pages in `make dev-local`.
- [ ] **Step 4: Commit** — `feat(web): tier-first combobox; assistant/personal/team reasoning`

---

### Task 16: Full validation + PR

- [ ] **Step 1:** `pnpm typecheck` clean.
- [ ] **Step 2:** Targeted suites: `pnpm --filter @valet/engine test happy-path`, `pnpm --filter @valet/engine test in-memory-store`, `pnpm --filter @valet/store-postgres test`, `pnpm --filter @valet/api test`.
- [ ] **Step 3:** Commit `registry.gen.ts` if anything regenerated it (memory: the drift suite clobbers uncommitted copies mid-run).
- [ ] **Step 4:** `make e2e 2>&1 | tee /tmp/e2e-model-selector.log` — full scorecard, never piped through tail/head/grep. Re-run any red Docker row in isolation (`--only <suite>`) before treating it as real. Name why any remaining red row is environmental (see memory notes: test-pg local row, sandbox-k8s rows).
- [ ] **Step 5:** Update `docs/specs/2026-09-03-model-selector-overhaul-design.md` Deviations section with anything that diverged.
- [ ] **Step 6:** PR to `dev-v2`. Description per PR lint: ≤300 words, no em/en dashes, no marketing words, filled Validation section. `say` before `git push` (YubiKey). No session links in the PR body.

---

## Self-review notes

- Spec coverage: §1 vocab → Tasks 12; §2 schema → Tasks 1, 10; §3 wire/API → Tasks 4-7; §4 enforcement → Tasks 3, 8; §5 cascades → Tasks 9, 11; §6 engine → Task 10; §7 UI → Tasks 13-15; §8 testing → per-task + Task 16.
- Engine reasoning persistence (Task 10) is deliberately sequenced before host plumbing (Task 11) and the UI reload check (Task 14 Step 3) closes the four-hop round trip.
- `ModelInfo.approved` is temporarily hardcoded `true` in Task 4 Step 2 and replaced in Task 7 — flagged in both tasks.
