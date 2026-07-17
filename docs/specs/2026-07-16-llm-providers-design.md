# LLM Provider Keys + Custom Providers Design — BYO keys and org model catalog

**Date:** 2026-07-16
**Status:** Implemented
**Scope:** Org-level LLM provider configuration: BYO API keys for known providers (Anthropic/OpenAI/Google), custom OpenAI-compatible providers (base URL + key + models), an org-scoped model catalog with ordered default preferences, and the resolution bridge that threads provider/key/baseUrl into pi-ai per turn. Resolution: org key > deployment env fallback.

## Context

- Valet's model plumbing is **Anthropic-only, env-only** today: `resolveModel` hardcodes `getModel("anthropic", id)` (`packages/api/src/engine/host.ts:582-587`), `/api/models` reads pi-ai's static Anthropic registry, and `thread.ts` constructs the pi-agent-core `Agent` with no `apiKey`/`baseUrl` — pi-ai falls back to `ANTHROPIC_API_KEY` env.
- **pi-ai already supports everything we need:** providers for anthropic/openai/google and openai-compatible surfaces, `Model.baseUrl`, per-call `options.apiKey`, custom headers. Valet just never passes them.
- The org-owned encrypted credential store is live (AES-256-GCM via `VALET_ENCRYPTION_KEY`; `CredentialOwner { type: "org" }` first-class) — the natural vault; nothing connects it to model construction yet.
- Legacy parity targets on `main`: `LLMKeysSection`, `CustomProvidersSection`, `OrgModelPreferencesSection`.

## Decisions (locked)

1. **Data model.** Provider *config* and provider *secret* are stored separately:
   - `llm_providers` table (api schema, into `0000`): `{ id, orgId, kind: "anthropic" | "openai" | "google" | "openai_compatible", name, baseUrl? (required for openai_compatible, refused otherwise), enabled, models (JSON — custom providers only: [{ id, name, contextWindow?, pricing? }]), createdAt }`. One row per provider per org; the three known kinds are singletons per org.
   - The API key lives in the **existing org-owned credential store** under service `llm:{providerRowId}` as an `api_key` credential — encrypted at rest, never returned by any API (routes return `hasKey: true` + last-4 only).
2. **Model identity: namespaced ids, bare-id back-compat.** Internally models are `{providerKind-or-rowId}/{modelId}` (e.g. `anthropic/claude-haiku-4-5`, `prov_abc123/qwen-coder`). **Bare ids remain valid and mean Anthropic** — every persisted session/user model keeps working (restore-no-clobber untouched). `KNOWN_MODEL_IDS`-style validation moves to the org catalog.

3. **The org model catalog replaces the static `/api/models`.** Returned catalog = union of: pi-ai registry models for each *enabled* known provider (with contextWindow/pricing from the registry) + custom providers' declared models. Custom-provider model entry is manual, with a **discovery probe** ("fetch models") that calls the provider's `/v1/models` and offers the result as checkboxes — a convenience, not a dependency (some gateways don't implement it). Providers with no resolvable key (no org key AND no deployment env var) are listed as configured-but-inactive and their models excluded from pickers.

4. **Resolution bridge (the core seam).** `resolveModel` becomes catalog-aware: parse namespace → look up provider row → build the pi-ai `Model` (registry lookup for known kinds; synthesized `Model` with `baseUrl` for openai_compatible) → resolve the key: **org credential first, deployment env second** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` per pi-ai's env map; custom providers have no env fallback). The engine's model-resolution seam widens from `resolveModel(id) → Model` to `resolveModel(id) → { model, apiKey? }` (additive for the host-provided resolver; the engine's internal fallback returns no key, preserving env behavior), and `thread.ts` passes the key through as pi-ai's per-call `options.apiKey`. Keys are resolved **per turn** (no caching beyond the request) so a rotated key applies immediately.
5. **Ordered org model preferences (legacy parity).** `orgs` gains `modelPreferences: string[]` (namespaced ids, admin-ordered). Semantics: first entry = org default model for new sessions; the list defines picker ordering (catalog models not listed sort after, alphabetically). Precedence for a new session: explicit override > user `defaultModel` > org preference #1 > built-in default. Restore keeps the persisted session model always (existing constraint).

6. **Failure semantics.** A turn whose model's provider is disabled/deleted or key-less fails fast with a clear engine error (surfaced like model-resolution errors today), and the session can be switched via the existing `PATCH /sessions/:id` model route; new sessions never resolve to inactive providers. Deleting a provider row revokes its credential and is refused while it's the org default (`modelPreferences[0]`). Custom-provider probe failures surface verbatim in the settings UI (this is an admin tool; raw errors are correct).

7. **UI: settings → Organization → Models (admin-gated).**
   - Known providers: card per provider — key entry (write-only field, last-4 display), enabled toggle, env-fallback indicator ("using deployment key").
   - Custom providers: CRUD — name, baseUrl, key, model list editor + discovery probe, test button (1-token completion round-trip, result shown).
   - Model preferences: drag-ordered list built from the active catalog; first = default (badge).
   - User settings `defaultModel` picker and the session model switcher consume the org catalog unchanged (they already hit `/api/models`).

8. **Interactions with other in-flight specs.** Usage/telemetry's cost math reads pricing from this catalog (custom-provider `pricing` optional → cost absent, tokens-only, per that spec's rule). The policy engine is orthogonal (LLM calls are not plugin actions). Nothing here touches sandbox specs.

## Exit criteria (the dogfood)

With only deployment env `ANTHROPIC_API_KEY`: everything behaves as today (env-fallback indicator visible). Admin adds an org Anthropic key → turns use it (verified by revoking the env var in a dev boot and confirming turns still run) and key rotation applies to the next turn without restart. Admin adds a custom OpenAI-compatible provider (a local proxy/ollama-style endpoint), probes models, enables one, sets it as org default → a new session starts on it and completes a turn; usage telemetry records the turn with tokens (cost absent). Disabling that provider → new sessions fall back to preference order, the existing session errors clearly on next turn and recovers after a model switch. A member (non-admin) sees the catalog in pickers but cannot reach the Models settings; no API response ever contains a stored key.

## Testing

- **Resolution unit:** namespace parsing + bare-id back-compat, org-key-over-env precedence per provider kind, custom-provider `Model` synthesis (baseUrl, no env fallback), inactive-provider exclusion, per-turn key freshness.
- **Catalog route:** union composition, enabled/keyed filtering, preference ordering, no-secret-leakage assertion (response-shape test).
- **Engine seam:** `Agent` construction receives the resolved key/baseUrl (fake pi-ai transport asserting what arrives); restore-no-clobber pinned with a namespaced persisted model.
- **CRUD/integration:** provider lifecycle incl. delete-refused-while-default, credential revocation on delete, probe against a fixture `/v1/models`, test-button round-trip against a faux provider (pi-ai's `faux` provider is available for exactly this).
- **Live e2e** gated on `OPENAI_API_KEY`: one real OpenAI turn through an org key.

## Deviations (as implemented, plan `docs/plans/2026-07-16-llm-providers.md`, 9 tasks)

- **The engine seam is NEW, not a widening.** This doc's decision 4 described `resolveModel` as an existing seam that "widens" — there was no host-provided model resolver before this arc. `thread.ts` resolved models purely internally via `resolveModelId` (already namespace/bare-id aware). Task 1 introduced an *optional* `resolveModel?: (spec) => Promise<ResolvedModel | null>` on the session-options object; the internal `resolveModelId` path is reused unchanged as the absent-resolver fallback (pinned byte-identical). Key delivery to pi-agent-core is via `AgentOptions.getApiKey(provider)` (a per-turn closure over `this.turnApiKey`), not a per-call `apiKey` parameter — pi-agent-core has no such parameter on the Agent construction path.
- **Canonical-id echo form.** The resolver echoes the caller's namespace form: a bare spec (`claude-haiku-4-5`) stays bare, a namespaced spec (`anthropic/claude-haiku-4-5`, `openai/gpt-4.1`, `{rowId}/{modelId}`) stays namespaced. OpenAI/Google/custom models are only ever reachable namespaced (no bare form exists for them). Because the engine persists the returned `model.id` and feeds it back into the resolver on every subsequent turn, this makes resolution idempotent on its own output by construction — `resolve(resolve(spec).model.id)` yields the same provider and key, pinned by a dedicated round-trip test per kind.
- **Compaction's summarizer honors the turn key.** `Thread.summarize()` (`packages/engine/src/thread.ts`) gained `apiKey: this.turnApiKey` at its `completeSimple` call site — a sanctioned engine edit beyond Task 1's original scope, needed because compaction runs *inside* a claimed turn and would otherwise silently fall back to the deployment env key even for a BYO-only custom provider.
- **`/api/models` excludes inactive entries rather than flagging them.** `buildOrgCatalog` returns the full set (active + inactive, for admin/debug visibility); the public `/api/models` route filters to `active` only before responding — a disabled provider or a keyless known-kind never appears in a picker, it isn't shown-but-disabled. Every catalog entry's `id` (including Anthropic) is namespaced (`anthropic/claude-haiku-4-5`); the bare form is validation/persistence-only back-compat (`catalogValidIds` accepts both, session/user `defaultModel` fields may still hold the bare form).
- **Preferences write route:** `PUT /api/org/llm-providers/preferences` (under the provider CRUD router), not a field on `PATCH /api/org`. It validates every submitted id against the *active* catalog set on every write (`catalogValidIds`) — an id that names a disabled provider or an inactive custom model is rejected with 400, even if it was valid when originally set.
- **New-session precedence has a 5th tier.** `EngineHost.resolveModelForBuild`'s chain is `overrideId ?? userDefaultModel ?? firstActiveOrgPreference ?? this.opts.defaultModelId ?? "claude-haiku-4-5"` — the design doc's decision 5 omitted the `EngineHostOptions.defaultModelId` tier (used by `VALET_MODEL`/dogfood overrides). It defaults to the same literal, so behavior for hosts that don't set it is unchanged.
- **`orgPreferences` fall-through past inactive entries (new-session tier only).** `EngineHost.orgPreferredModel` walks `orgs.modelPreferences` in order and returns the first entry whose provider is active (known-kind namespace with no row, or a row with `enabled: true`); it returns `undefined` — falling through to `defaultModelId`/the hardcoded default — when every preference is inactive. This satisfies decision 6/the exit criteria's "new sessions never resolve to inactive providers": disabling the provider behind `orgPreferences[0]` now falls back to `orgPreferences[1]`, etc., instead of throwing. The check is a single `listLlmProviders` query (`enabled` only, no per-preference credential probe), so it adds no N+1 relative to the resolution the build already does. This tier is new-session only: `overrideId` and the user's explicit `defaultModel` still resolve straight through and throw on a disabled provider (an explicit pick should fail loudly), and restore never consults preferences at all — a session persisted on a model whose provider is later disabled still throws on restore/next turn, per spec.
- **Known latents, left deliberately unfixed this pass:**
  - **Role-model override keeps the base-spec key.** `applyRoleForTurn` switches `agent.state.model` via the engine's internal `resolveRoleModel`, not the host resolver; `turnApiKey` stays whatever the base spec resolved to. A role that overrides to a different provider than the turn's base model runs under the wrong key.
  - **Probe/test `baseUrl` is admin-trusted**, not validated against an allowlist (SSRF-shaped surface, mitigated only by the route being org-admin-gated) — flagged in a code comment at the call site, not hardened this pass.
- **Web: model-preference reordering uses up/down buttons**, not drag-and-drop — no dnd dependency exists in the repo, and the brief didn't require adding one.

## Non-goals

- Per-user LLM keys (org + deployment env only this pass).
- Provider-level spend limits/quotas (usage spec shows spend; enforcement is future).
- Azure OpenAI / Bedrock / Vertex specific auth flows (pi-ai supports them; each has bespoke credential shapes — add per demand as new `kind`s).
- Automatic model failover mid-turn.
- Proxying/rewriting model traffic through the api (turns call providers directly from the api process as today).
- Migrating legacy D1 service-config keys (pre-1.0).
