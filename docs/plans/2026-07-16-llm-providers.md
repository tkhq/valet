# LLM Provider Keys + Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Org-level BYO LLM keys (Anthropic/OpenAI/Google), custom OpenAI-compatible providers, an org model catalog with ordered preferences, and a per-turn resolution bridge (org key > deployment env) threaded into pi-ai.

**Architecture:** Provider *config* rows live in a new `llm_providers` table; provider *secrets* live in the existing org-owned encrypted credential store under `llm:{providerRowId}`. A new engine seam `EngineOptions`-level `resolveModel?(spec) → { model, apiKey? } | null` (absent = byte-identical today) is consulted per turn; the api implements it catalog-aware and passes the key through pi-agent-core's `AgentOptions.getApiKey` hook. `GET /api/models` becomes the org catalog; web settings gain an admin Models page; pickers consume the catalog.

**Tech Stack:** TypeScript strict, Hono 4, Drizzle/Postgres (PGlite dev), pi-ai 0.73 (`getModel`/`getModels`/`getEnvApiKey`/`registerFauxProvider`), pi-agent-core (`AgentOptions.getApiKey`), vitest, React 19 + TanStack Query.

**Spec:** `docs/specs/2026-07-16-llm-providers-design.md` — "Decisions (locked)" binding; non-goals (per-user keys, spend limits, Azure/Bedrock/Vertex, mid-turn failover, traffic proxying) are real.

## Global Constraints

- Every shell command runs under Node 22: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`.
- **Engine contract touchpoint:** Task 1 (the `resolveModel` seam + `getApiKey` wiring) is a shared-contract change — REQUIRES adversarial review (opus). Absent resolver MUST be byte-identical to today (regression pinned; the `gatewayEndpoint?`/`release?` optional-seam precedents in `packages/engine/src/types.ts` are the template). The restore-no-clobber branch (`packages/api/src/engine/host.ts:651` — `if (existing?.model) return this.resolveModel(existing.model)`) must stay first and untouched in behavior.
- **Pre-1.0 migrations:** edit `packages/api/migrations/pg/0000_app.sql` in place + matching Drizzle tables in `packages/api/src/schema/index.ts`. NO numbered migrations. After editing: `rm -rf ~/.valet/pg`.
- **Secrets never leave the api:** no API response ever contains a stored key — routes return `hasKey: true` + `keyLast4` only. Credential service key convention: `llm:{providerRowId}`, `type: "api_key"`, org-owned (`{ type: "org", id: orgId }`).
- **Model identity:** namespaced `{providerKindOrRowId}/{modelId}` (e.g. `anthropic/claude-haiku-4-5`, `prov_abc123/qwen-coder`); bare ids remain valid and mean Anthropic. Env fallback per pi-ai's map via `getEnvApiKey(provider)` (`anthropic` also honors `ANTHROPIC_OAUTH_TOKEN`; google = `GEMINI_API_KEY`); custom providers have NO env fallback.
- Keys resolved **per turn** — no caching beyond the turn; rotation applies to the next turn without restart.
- Known provider kinds `"anthropic" | "openai" | "google"` are singletons per org; `baseUrl` required for `openai_compatible`, refused otherwise.
- PGlite: ONE instance per process (`bootTestApi`/`freshTestPgDb`). Known-allowed failing tests: only the 2 `messages.abort` cases.
- Type safety: no `any` (exception: the pre-existing `Model<any>` idiom in host.ts stays), no `as unknown as T`, no `@ts-ignore`. No Co-Authored-By trailers.
- Root `pnpm typecheck` does NOT cover `packages/web` — run `cd packages/web && pnpm typecheck` separately.
- Org-admin gating for new routes: follow `packages/api/src/routes/org.ts:54-61` `requireOrgAdmin` (DB-backed `isOrgAdmin`), not the JWT-role variant.

---

### Task 1: Engine seam — host model resolver + per-turn `getApiKey` [ADVERSARIAL REVIEW REQUIRED]

**Files:**
- Modify: `packages/engine/src/types.ts` (new `ResolvedModel`, resolver option field)
- Modify: `packages/engine/src/thread.ts` (`resolveTurnModel` path, `buildAgent` `getApiKey`, `Thread.setModel` validation)
- Modify: `packages/engine/src/session.ts` (`Session.setModel` validation through the resolver)
- Test: `packages/engine/test/model-resolver-seam.test.ts`

**Interfaces:**
- Produces (consumed by Task 5): `export interface ResolvedModel { model: Model<any>; apiKey?: string }` and an optional engine-level option `resolveModel?: (spec: string) => Promise<ResolvedModel | null>` placed on the SAME options object that carries `model`/`systemPrompt` today (the object `EngineHost` passes to `engine.createSession`/`engine.restoreSession` — find its type via `SessionOptions` in `packages/engine/src`; add the field there so every session builder can supply it).
- Behavior contract: absent resolver → engine uses its existing internal `resolveModelId` (`thread.ts:2706-2718`) and passes NO `getApiKey` to the Agent → pi-ai env fallback, byte-identical. Present resolver → (a) `Session.setModel`/`Thread.setModel` validate ids through it (unresolvable → throw, same error surface as today); (b) at turn start the thread resolves the effective model spec through it and holds `{ model, apiKey }` for that turn only; (c) `buildAgent` passes `getApiKey: async () => this.currentTurnApiKey` style plumbing so pi-agent-core stamps `StreamOptions.apiKey` (undefined → env fallback preserved).

- [ ] **Step 1: Write the failing seam test**

`packages/engine/test/model-resolver-seam.test.ts` — use the existing engine test harness patterns (look at a sibling test that boots a session with the in-memory store and a scripted/faux agent transport; `registerFauxProvider` from `@mariozechner/pi-ai` is available for a full turn):

```ts
import { describe, expect, it, vi } from "vitest";
import { registerFauxProvider, fauxText } from "@mariozechner/pi-ai";
// + the engine test harness imports used by sibling session tests

describe("host model resolver seam", () => {
  it("absent resolver: sessions build and turns run exactly as today (byte-identical pin)", async () => {
    // boot a session WITHOUT resolveModel, run one faux turn, assert it completes
    // and that the Agent received NO getApiKey (spy on Agent options via the faux
    // stream: StreamOptions.apiKey must be undefined).
  });

  it("present resolver: turn model + apiKey come from the resolver, per turn", async () => {
    const resolver = vi.fn(async (spec: string) => ({ model: fauxModel, apiKey: `key-${resolver.mock.calls.length}` }));
    // run two turns; assert resolver called at least once per turn (freshness)
    // and the faux stream observed apiKey "key-1" then a later value — i.e. no
    // cross-turn caching of the key.
  });

  it("setModel validates through the resolver when present", async () => {
    // resolver returns null for "nope/nope" → session.setModel("nope/nope") throws;
    // resolver returns a model for "prov_x/m1" → setModel succeeds and persists the string.
  });
});
```

Write real assertions against the faux provider's observed `StreamOptions` — `expect(seenApiKeys).toEqual([...])`, not `toBeDefined()`.

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test -- model-resolver-seam`
Expected: FAIL (field doesn't exist / test can't compile — for the type-only part verify RED with a temp `tsc --noEmit`, vitest does not typecheck).

- [ ] **Step 3: Implement**

- `types.ts`: add `ResolvedModel`; add the optional `resolveModel?` field to the session options interface with a doc comment mirroring the `gatewayEndpoint?` precedent ("absent === current internal resolution — existing paths unchanged").
- `thread.ts`: at the point the turn's model is fixed (today `resolveTurnModel()`, thread.ts:962-969), when the session options carry a resolver: resolve the effective spec string (`this.modelOverride ?? <the session's persisted model string>`) through it, store `{ model, apiKey }` on the turn (a private field cleared at turn end), fall back to the existing sync path when the resolver is absent. `resolveTurnModel` may become async — its call sites are inside the async turn machinery; keep the sync path intact for the absent case.
- `buildAgent` (thread.ts:1888-1900): add `getApiKey: (provider) => this.turnApiKey` plumbing ONLY when a resolver is present (absent → construct the Agent exactly as today; pin by not passing the option at all).
- `session.ts` `setModel` (574-593) and `thread.ts` `Thread.setModel` (931-957): when resolver present, validate via `await resolver(spec)` → null means throw the same "unresolvable model" error shape as the current `resolveModelId` failure; absent → current behavior.

- [ ] **Step 4: Run engine suite (byte-identical pin)**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test && pnpm typecheck`
Expected: all pass; every pre-existing suite green with zero changes = the absent-resolver pin.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src packages/engine/test/model-resolver-seam.test.ts
git commit -m "feat(engine): host model-resolver seam + per-turn getApiKey"
```

---

### Task 2: Schema — `llm_providers` table + `orgs.modelPreferences`

**Files:**
- Modify: `packages/api/src/schema/index.ts` (new table + orgs column)
- Modify: `packages/api/migrations/pg/0000_app.sql` (in place)
- Modify: `packages/api/src/services/org.ts` (preferences get/set, mirroring `getOrgFeatures`/`setOrgFeatures`)
- Test: `packages/api/src/services/org.test.ts` (extend), a small schema round-trip in an existing pg-schema test file

**Interfaces:**
- Produces (Tasks 3-5): Drizzle table `llmProviders` with columns `{ id: text PK ("prov_" + uuid), orgId: text notNull, kind: text enum ["anthropic","openai","google","openai_compatible"] notNull, name: text notNull, baseUrl: text (nullable), enabled: boolean notNull default true, models: jsonb notNull default [] (custom providers only: [{ id, name, contextWindow?, pricing? }]), createdAt: bigint ms }` + unique index on `(orgId, kind)` WHERE kind != 'openai_compatible' (known kinds are per-org singletons — implement as a partial unique index in the SQL and enforce in the service layer too since Drizzle can't express partial uniques portably; the service-layer check is the one tests pin). `orgs.modelPreferences: jsonb notNull default []` (string[] of namespaced ids).
- Produces: `getOrgModelPreferences(db, orgId): Promise<string[]>`, `setOrgModelPreferences(db, orgId, prefs: string[]): Promise<void>` in `services/org.ts`.

- [ ] **Step 1: Failing tests** — extend `org.test.ts`: preferences default `[]`, set/get round-trip, non-array rejected (ValidationError). Add an insert/select round-trip for `llmProviders` incl. jsonb `models` shape in the pg-schema test.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/api test -- org` → FAIL.
- [ ] **Step 3: Implement** — schema per the shapes above (`jsonb("model_preferences").notNull().default([])` mirroring `features` at schema/index.ts:35-42); matching `CREATE TABLE "llm_providers"` + `ALTER`-equivalent inline edits in `0000_app.sql`; the partial unique index `CREATE UNIQUE INDEX llm_providers_org_kind_singleton ON llm_providers (org_id, kind) WHERE kind <> 'openai_compatible';`; service helpers with `JSON.parse`/`JSON.stringify` handling per the file's jsonb convention. Then `rm -rf ~/.valet/pg`.
- [ ] **Step 4: Run** — `pnpm --filter @valet/api test -- org && pnpm --filter @valet/api test -- pg-schema && pnpm typecheck` → green.
- [ ] **Step 5: Commit** — `git add packages/api/src packages/api/migrations/pg/0000_app.sql && git commit -m "feat(api): llm_providers table + org model preferences"`

---

### Task 3: Provider CRUD + key management routes

**Files:**
- Create: `packages/api/src/routes/llm-providers.ts`
- Create: `packages/api/src/services/llm-providers.ts` (row CRUD + singleton enforcement + key summary)
- Modify: `packages/api/src/app.ts` (mount under `/api/org/llm-providers`)
- Modify: `packages/api/src/wire/types.ts` (request/response shapes)
- Test: `packages/api/src/routes/llm-providers.test.ts`

**Interfaces:**
- Consumes: Task 2 table + `c.var.providers.engineCredentials` (`CredentialStore`, org owner `{ type: "org", id: orgId }`, service `llm:{rowId}`); `requireOrgAdmin` pattern from `routes/org.ts:54-61`.
- Produces (Tasks 4-7): REST surface —
  - `GET /api/org/llm-providers` → `{ providers: LlmProviderSummary[] }` where `LlmProviderSummary = { id, kind, name, baseUrl?, enabled, models, hasKey: boolean, keyLast4?: string, envFallback: boolean, createdAt }` (`envFallback` = no org key AND `getEnvApiKey(kind)` present; import `getEnvApiKey` from `@mariozechner/pi-ai`). Admin-gated (members use the catalog, not this).
  - `POST /api/org/llm-providers` `{ kind, name, baseUrl?, models? }` → 201 summary. 400: `baseUrl` missing for `openai_compatible` or present for known kinds; 409: known-kind singleton exists.
  - `PATCH /api/org/llm-providers/:id` `{ name?, baseUrl?, enabled?, models? }` → summary. Same baseUrl validation.
  - `PUT /api/org/llm-providers/:id/key` `{ apiKey: string }` → `{ hasKey: true, keyLast4 }`. Stores `{ type: "api_key", apiKey }`; response NEVER echoes the key. `keyLast4` = last 4 chars, stored in credential `metadata: { last4 }` so GET can show it without decrypt-and-slice on every list (or decrypt-and-slice — pick one and test the no-leak shape either way).
  - `DELETE /api/org/llm-providers/:id/key` → 204 (revoke key only).
  - `DELETE /api/org/llm-providers/:id` → 204; revokes credential first; 409 `{ error: "provider is the org default model's provider" }` while any `modelPreferences[0]` model is namespaced to this row/kind.
- All routes 403 `{ error: "org admin required" }` for non-admins; provider rows are org-scoped (`orgId = user.orgId` always; cross-org ids → 404).

- [ ] **Step 1: Failing route tests** via `bootTestApi`: CRUD lifecycle; singleton 409; baseUrl validation both directions; key PUT → list shows `hasKey: true` + last4 and the response body contains neither the key nor any credential fields (assert `JSON.stringify(body)` does not contain the key string — the no-leak shape test); non-admin 403 for every route; cross-org 404; delete revokes credential (assert `engineCredentials.get` returns null after) and delete-refused-while-default 409; `envFallback` flag flips with a stubbed env var.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** service + routes per the shapes above.
- [ ] **Step 4: Run** — `pnpm --filter @valet/api test -- llm-providers && pnpm typecheck` → green.
- [ ] **Step 5: Commit** — `feat(api): org LLM provider CRUD + encrypted key management`

---

### Task 4: Org model catalog — service + `/api/models` rewrite + validation move

**Files:**
- Create: `packages/api/src/services/model-catalog.ts`
- Modify: `packages/api/src/routes/models.ts` (org-aware catalog)
- Modify: `packages/api/src/routes/me.ts` (KNOWN_MODEL_IDS → catalog validation)
- Modify: `packages/api/src/wire/types.ts` (`ModelInfo` gains `{ id /* namespaced */, name, contextWindow?, reasoning?, providerId, providerKind, providerName, active: boolean, pricing? }`; `ListModelsResponse` unchanged shape)
- Test: `packages/api/src/services/model-catalog.test.ts`, extend `routes/models` + `me` tests

**Interfaces:**
- Consumes: Tasks 2-3 (rows + key summaries), pi-ai `getModels(kind)` for known kinds, `getEnvApiKey`.
- Produces (Tasks 5, 7, 8): `buildOrgCatalog(db, credentials, orgId): Promise<CatalogEntry[]>` where `CatalogEntry = ModelInfo & { resolvable: boolean }`; ordering = `modelPreferences` order first, then remaining actives alphabetically; entries for keyless/disabled providers carry `active: false` and are EXCLUDED from `ListModelsResponse.models` (spec: "listed as configured-but-inactive and their models excluded from pickers" — the settings UI reads providers from Task 3's route, so `/api/models` returns actives only). Bare Anthropic back-compat: known-Anthropic entries also match bare ids for validation purposes — expose `catalogValidIds(entries): Set<string>` that includes BOTH `anthropic/x` and bare `x` for anthropic entries.
- `me.ts:27`'s `KNOWN_MODEL_IDS` is deleted; `PATCH /api/me` validates `defaultModel` against `catalogValidIds` (env-only boot with no org rows must still validate bare Anthropic ids — the catalog synthesizes a default Anthropic entry from the pi-ai registry whenever `getEnvApiKey("anthropic")` resolves, even with zero provider rows; pin this "zero-config = today" case).

- [ ] **Step 1: Failing tests** — union composition (known enabled+keyed, known enabled+env-fallback, known disabled → excluded, custom with declared models, custom keyless → excluded); preference ordering incl. unlisted-alphabetical tail; zero-config env-only boot returns the Anthropic registry (today's behavior pin, compare against `getModels("anthropic")` ids); response-shape no-secret assertion; `PATCH /api/me` accepts bare + namespaced active ids, 400s inactive/unknown.
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Run** `pnpm --filter @valet/api test -- model-catalog && pnpm --filter @valet/api test -- models && pnpm --filter @valet/api test -- me && pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(api): org model catalog replaces static /api/models`

---

### Task 5: Resolution bridge — catalog-aware `resolveModel` + org-preference default + engine wiring

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`resolveModel` → catalog-aware async `{ model, apiKey? }`; `resolveModelForBuild` precedence; pass `resolveModel` seam into every `engine.createSession`/`restoreSession` options object — all 4 builder sites host.ts:198/362/704/791)
- Modify: `packages/api/src/routes/sessions.ts:189-224` (PATCH model — errors already surface via setModel throw; confirm namespaced ids flow)
- Test: `packages/api/src/engine/host.model-resolution.test.ts`

**Interfaces:**
- Consumes: Task 1 seam (`ResolvedModel`), Task 4 catalog, Task 3 credentials, pi-ai `getModel`/`getEnvApiKey`.
- Produces: the api-side resolver — `parse namespace → provider row (bare id = anthropic) → known kind: getModel(kind, modelId) + key = org credential (llm:{rowId}) ?? getEnvApiKey(kind); openai_compatible: synthesize Model<"openai-completions"> { id: modelId, name (from row.models entry), api: "openai-completions", provider: row.id, baseUrl: row.baseUrl, reasoning: false, input: ["text"], cost: pricing ?? zeros, contextWindow: entry.contextWindow ?? 128000, maxTokens: 8192 } + key = org credential ONLY (no env fallback, missing → throw "provider {name} has no API key")`. Disabled/deleted provider or inactive model → throw with a clear message (fails the turn like model-resolution errors today). New-session precedence: `overrideId ?? userDefaultModel ?? orgPreferences[0] ?? "claude-haiku-4-5"`. Restore branch stays first and verbatim.

- [ ] **Step 1: Failing tests** — namespace parsing + bare back-compat; org-key-over-env per kind (stub env, seed credential, assert which key the resolver returns); custom synthesis exact-shape (assert baseUrl/provider/api fields); no-env-fallback-for-custom throw; disabled-provider throw; per-turn freshness (rotate the stored credential between two resolutions → second resolution returns the new key — no cache); new-session precedence matrix (4 tiers); restore-no-clobber with a namespaced persisted model (seed session row with `prov_x/m1`, restore, assert resolver got `prov_x/m1` and no clobber).
- [ ] **Step 2: Verify failure. Step 3: Implement** (make `resolveModel`/`resolveModelForBuild` async-aware; wire the seam field into all four options objects; delete the hardcoded anthropic-only body at host.ts:598-609 in favor of the bridge, keeping `Model<any>` at the boundary with the same documented cast idiom).
- [ ] **Step 4: Run** — `pnpm --filter @valet/api test && pnpm typecheck` (full api suite — this touches every session build path; only the 2 known abort failures allowed).
- [ ] **Step 5: Commit** — `feat(api): catalog-aware model resolution — org keys over env, custom providers`

---

### Task 6: Discovery probe + provider test button (api)

**Files:**
- Modify: `packages/api/src/routes/llm-providers.ts` (+2 routes), `packages/api/src/services/llm-providers.ts`
- Test: extend `packages/api/src/routes/llm-providers.test.ts` (fixture `/v1/models` server via `@hono/node-server` on port 0; faux provider for the test button)

**Interfaces:**
- `POST /api/org/llm-providers/:id/probe` (admin, custom providers only → 400 for known kinds): GETs `{baseUrl}/models` (OpenAI-compatible: baseUrl already ends in `/v1`) with the stored key as `Authorization: Bearer`; returns `{ models: [{ id }] }` from the response's `data[].id`; upstream failure → 502 `{ error: <verbatim upstream text/status> }` (spec: raw errors are correct for this admin tool).
- `POST /api/org/llm-providers/:id/test` `{ modelId }`: runs a 1-token completion through the same resolution bridge (Task 5's synthesis + key path — import the service, do NOT reimplement) against the provider; returns `{ ok: true, latencyMs }` or `{ ok: false, error }` with 200 (result display, not transport error). Tests use `registerFauxProvider` + a fixture HTTP server; no live network.

- [ ] Steps: failing tests → implement → `pnpm --filter @valet/api test -- llm-providers && pnpm typecheck` → commit `feat(api): custom-provider model discovery probe + test button`.

---

### Task 7: Web — Organization → Models settings page

**Files:**
- Create: `packages/web/src/routes/settings.organization.models.tsx`
- Create: `packages/web/src/components/settings/llm-providers-section.tsx` (known-provider cards + custom CRUD + probe/test)
- Create: `packages/web/src/components/settings/model-preferences-section.tsx` (ordered list, up/down buttons — NO new drag-and-drop dependency; the repo has none and buttons are sufficient)
- Modify: `packages/web/src/components/settings/settings-rail.tsx` (`ORGANIZATION_ITEMS` + `{ to: "/settings/organization/models", label: "Models" }`)
- Modify: `packages/web/src/api/` (hooks for the Task 3/6 routes + org preferences PATCH — follow the existing `settings.ts` hook/query-key patterns)
- Test: `packages/web/src/routes/-settings.organization.models.test.tsx`

**Interfaces:**
- Consumes: Task 3/6 REST + a new `PATCH /api/org` preferences write — check `routes/org.ts` for the existing org PATCH surface; if none fits, add `PUT /api/org/model-preferences { preferences: string[] }` to Task 3's router (admin-gated, validates ids against the catalog, 400 unknown/inactive ids) and note the addition in the task report.
- Page renders inside the existing `OrgRouteGuard` (settings.organization.tsx layout) — no per-page admin re-check.
- Known-provider cards: write-only key input (never prefilled; placeholder `••••${keyLast4}` when `hasKey`), Save → PUT key; enabled toggle → PATCH; "using deployment key" badge when `envFallback && !hasKey`. Custom cards: name/baseUrl/key/models editor (id+name rows), "Fetch models" → probe → checkbox merge, "Test" → test route → inline ok/error verbatim. Preferences: ordered rows from active catalog, first row badged "default", up/down + remove; unlisted actives listed below with "add".

- [ ] Steps: failing component tests (key field never echoes a value; probe merge renders checkboxes; preferences reorder posts the new array; member (non-admin guard) — covered by layout, assert rail hides group without admin) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): org Models settings — provider keys, custom providers, preferences`.

---

### Task 8: Web — pickers consume the catalog

**Files:**
- Modify: `packages/web/src/api/settings.ts` (`useModels` staleTime Infinity → 60s + invalidate on Task 7 mutations)
- Modify: `packages/web/src/components/settings/model-combobox.tsx` (registry ids → catalog entries incl. custom; keep curated `MODEL_CATALOG` labels for known Anthropic ids, fall back to catalog `name`)
- Modify: `packages/web/src/components/session/model-picker.tsx` (currently renders ONLY the static `MODEL_CATALOG` from `lib/models.ts` — switch to `useModels()` data, ordered as returned (catalog is preference-ordered), keeping the curated tier labels for ids that match)
- Test: extend the components' tests

**Interfaces:** consumes Task 4's `ModelInfo` (namespaced `id`, `name`, `providerKind`). New-session/default pickers submit the namespaced id verbatim (bare ids only ever come from pre-existing persisted data, never new UI writes).

- [ ] Steps: failing tests (custom model appears in both pickers; ordering follows response order; stale MODEL_CATALOG-only entries that aren't in the catalog no longer selectable in model-picker) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): model pickers consume the org catalog`.

---

### Task 9: Exit-criteria e2e + docs sync

**Files:**
- Create: `packages/api/src/integration/llm-providers.e2e.test.ts` (key-gated)
- Modify: `docs/specs/2026-07-16-llm-providers-design.md` (Status → Implemented + Deviations), `docs/handoff-2026-07-15-engine-v2.md` (queue table), `CLAUDE.md` if a durable gotcha emerged
- Test: the e2e itself + full battery

**Interfaces:** none new.

- [ ] **Step 1: e2e (fixture-first)** — with `bootTestApi` + faux provider: admin adds org Anthropic key → turn uses it (assert observed `StreamOptions.apiKey` = org key, not env); rotate key → next turn sees the new one without reboot; custom provider full loop (create, probe against fixture, enable, set default, new session resolves to it, turn completes via faux); disable → existing session's next turn errors clearly, PATCH model recovers, new sessions fall back to preference order; non-admin 403 on settings routes; no response body anywhere contains the stored key (sweep the recorded bodies).
- [ ] **Step 2: Live e2e** gated on `OPENAI_API_KEY`: one real OpenAI turn through an org key (skip cleanly without the env var).
- [ ] **Step 3: Full battery** — `pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test` (only the 2 known abort failures allowed).
- [ ] **Step 4: Docs** — spec Status flip + Deviations (record at minimum: the engine seam is NEW, not a widening — the spec's premise that a host resolveModel seam existed was inaccurate; `getApiKey` hook chosen over per-call options; `/api/models` excludes inactive rather than flagging them; preferences write route placement).
- [ ] **Step 5: Commit** — `docs(specs): llm providers implemented` (+ separate commits per earlier steps as natural).

---

## Self-review notes (already applied)

- **Spec coverage:** decision 1 → T2/T3; 2 → T4/T5 (bare-id back-compat pinned in both); 3 → T4+T6; 4 → T1/T5; 5 → T2 (storage) + T5 (precedence) + T7 (UI); 6 → T3 (delete refusal/revocation) + T5 (fail-fast) + T6 (verbatim probe errors); 7 → T7/T8; 8 → explicitly out of scope here (telemetry reads pricing later). Exit criteria → T9.
- **Engine touchpoint** is T1 only, adversarially reviewed, absent=byte-identical pinned — the spec's "widens resolveModel" premise corrected to "introduces the seam" (no host resolver exists today; engine resolves internally via `thread.ts:2706` `resolveModelId`, which already handles `provider/id` and bare ids — reuse it as the absent-resolver path, don't duplicate).
- **Known softness (flagged for implementers):** pi-agent-core's `getApiKey(provider)` receives only the provider string — for custom providers the synthesized `Model.provider` is the row id, so the hook can disambiguate; T1's turn-scoped `{model, apiKey}` holder makes the hook trivially correct without re-resolving. `Model.baseUrl` is REQUIRED in pi-ai's type — synthesis must always set it; known kinds get it from the registry. The web `model-picker.tsx` does not currently hit `/api/models` at all — T8 is a behavior change for it, test accordingly. `useModels` staleTime Infinity must not survive T7's mutations.
- **Type consistency:** `ResolvedModel { model, apiKey? }` (T1) = what T5 produces; `LlmProviderSummary` (T3) = what T7 consumes; `ModelInfo` namespaced ids (T4) = what T5 validates and T7/T8 render; service key `llm:{rowId}` used in T3/T5/T6.
