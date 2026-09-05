# LLM Provider Keys + Custom Providers Design — BYO keys and org model catalog

**Date:** 2026-07-16
**Status:** Implemented
**Scope:** Org-level LLM provider configuration: BYO API keys for known providers (Anthropic/OpenAI/Google), custom OpenAI-compatible providers (base URL + key + models), an org-scoped model catalog, and the resolution bridge that threads provider/key/baseUrl into pi-ai per turn. Resolution: org key > deployment env fallback. (The ordered default-preferences list this scope line originally named is removed — see "Extension: org model preferences removed" below.)

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
5. **Ordered org model preferences (legacy parity).** `orgs` gains `modelPreferences: string[]` (namespaced ids, admin-ordered). Semantics: first entry = org default model for new sessions; the list defines picker ordering (catalog models not listed sort after, alphabetically). Precedence for a new session: explicit override > user `defaultModel` > org preference #1 > built-in default. Restore keeps the persisted session model always (existing constraint). **Removed 2026-09-03** — see "Extension: org model preferences removed" below.

6. **Failure semantics.** A turn whose model's provider is disabled/deleted or key-less fails fast with a clear engine error (surfaced like model-resolution errors today), and the session can be switched via the existing `PATCH /sessions/:id` model route; new sessions never resolve to inactive providers. Deleting a provider row revokes its credential and was refused while it was the org default (`modelPreferences[0]`) — that guard is gone with the preferences column it protected (see the Extension below).

7. **UI: settings → Organization → Models (admin-gated).**
   - Known providers: card per provider — key entry (write-only field, last-4 display), enabled toggle, env-fallback indicator ("using deployment key").
   - Custom providers: CRUD — name, baseUrl, key, model list editor + discovery probe, test button (1-token completion round-trip, result shown).
   - Model preferences: drag-ordered list built from the active catalog; first = default (badge). (Removed 2026-09-03 — the model tier editor replaced this section; see the extension below.)
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
- **Preferences write route (removed 2026-09-03).** `PUT /api/org/llm-providers/preferences` validated every submitted id against the *active* catalog set on every write (`catalogValidIds`). The route, its GET twin, and the delete-refused-while-default guard on `DELETE /:id`/`DELETE /:id/key` are all gone with `orgs.model_preferences` — see the Extension below.
- **New-session precedence has a 5th tier (superseded 2026-09-03).** `EngineHost.resolveModelForBuild`'s chain was `overrideId ?? userDefaultModel ?? firstActiveOrgPreference ?? this.opts.defaultModelId ?? "claude-haiku-4-5"` — the design doc's decision 5 omitted the `EngineHostOptions.defaultModelId` tier (used by `VALET_MODEL`/dogfood overrides). It defaulted to the same literal, so behavior for hosts that didn't set it was unchanged. The current chain is in the Extension below.
- **`orgPreferences` fall-through past inactive entries (removed 2026-09-03).** `EngineHost.orgPreferredModel` walked `orgs.modelPreferences` in order and returned the first entry whose provider was active, falling through to `defaultModelId`/the hardcoded default when every preference was inactive — satisfying decision 6/the exit criteria's "new sessions never resolve to inactive providers." The equivalent behavior for the current tier-map fallback is `resolveTier`'s own active-provider walk — see the Extension below.
- **Known latents, left deliberately unfixed this pass:**
  - **Role-model override keeps the base-spec key.** `applyRoleForTurn` switches `agent.state.model` via the engine's internal `resolveRoleModel`, not the host resolver; `turnApiKey` stays whatever the base spec resolved to. A role that overrides to a different provider than the turn's base model runs under the wrong key.
  - **Probe/test `baseUrl` is admin-trusted**, not validated against an allowlist (SSRF-shaped surface, mitigated only by the route being org-admin-gated) — flagged in a code comment at the call site, not hardened this pass.
- **Web: model-preference reordering used up/down buttons**, not drag-and-drop — no dnd dependency exists in the repo, and the brief didn't require adding one. The pane itself (`ModelPreferencesSection`) is deleted as of 2026-09-03; `ModelTiersSection` reuses the same up/down/remove row pattern for tier targets.

## Extension: OpenRouter as a known kind (2026-07-28)

OpenRouter is the fourth known provider kind (`openrouter`), backed by pi-ai's
built-in openrouter registry (~274 models, `openai-completions` API, baseUrl
preset `https://openrouter.ai/api/v1`, env fallback `OPENROUTER_API_KEY` via
pi-ai's env-key map). Deviations from the other known kinds:

- **Curated catalog exposure, full-registry resolution.** The registry is too
  large for pickers, so the catalog surfaces only a selection: the provider
  row's `models` column (previously custom-only) holds the org's selection,
  seeded at row create with `OPENROUTER_DEFAULT_MODEL_IDS`
  (`services/openrouter.ts` — every id pinned against the registry by test).
  Zero-config boots (env key, no row) synthesize the curated defaults only.
  Selection entries are re-resolved against the registry per catalog build
  (pricing/context stay current; ids that fell out of the registry are
  skipped). RESOLUTION accepts any registry model regardless of selection —
  the usual live-vs-picker split.
- **Nested model ids.** Registry ids contain slashes
  (`deepseek/deepseek-v4-pro`), so namespaced specs nest
  (`openrouter/deepseek/deepseek-v4-pro`); `parseModelId`'s first-slash split
  keeps the canonical-id round-trip intact (pinned by test).
- **Admin picker route.** `GET /api/org/llm-providers/openrouter/models`
  (admin-gated, registered before `/:id` like `/preferences`) returns
  OpenRouter's LIVE `/api/v1/models` catalog merged over the pi-ai registry
  (live wins on collisions; degrades to registry-only with `live: false`
  when unreachable; `VALET_OPENROUTER_MODELS_URL` overrides the upstream
  URL for tests). This makes brand-new models pickable before any pi-ai
  bump. Non-registry selections are stored with their live metadata on the
  row, surface in the catalog from that stored entry, and RESOLVE via
  synthesis (openai-completions + openrouter baseUrl — same trust model as
  custom providers); un-selected non-registry ids stay unresolvable. The
  settings card hosts a selection editor (chips + filterable add-panel) on
  top of the standard known-kind key/toggle chrome.
- `models` is accepted on create/PATCH for `openrouter` rows in addition to
  `openai_compatible`; everything else (singleton rule, baseUrl refusal, key
  storage, env-fallback indicator, org-key-over-env precedence) is inherited
  unchanged from the known-kind machinery.

## Extension: team default model (2026-09-01, TKAI-255)

Teams gain a nullable `teams.default_model`, the team-tier analog of `users.default_model`. The new-session chain in `EngineHost.resolveModelForBuild` became (2026-09-01):

`overrideId ?? userDefaultModel ?? teamDefaultModel ?? firstActiveOrgPreference ?? this.opts.defaultModelId ?? "claude-haiku-4-5"`

**Superseded 2026-09-03** — `firstActiveOrgPreference` and the hardcoded literal are both gone; see "Extension: org model preferences removed" below for the current chain.

- **The team tier applies to team-owned sessions only.** A personal session never reads any team's preference: a user can belong to several teams, and none of them owns that session. The owning team reaches the resolver as `SessionMeta.ownerTeamId` (from the app row's `owner_type`/`owner_id` via `loadSessionMeta`, including the orchestrator's hand-built meta sources), as the principal for team assistant sessions, and as `opts.owner` for child and workflow builds.
- **User beats team, but only on sessions that user starts.** The org sets the default; the team overrides the org; the member overrides both for their own sessions. A SHARED principal-owned session (a team or org assistant, a team-owned child or workflow run) skips the user tier entirely: its resolved model persists (restore-no-clobber), so the first member to touch it would otherwise freeze their personal preference onto every other member.
- **Like the org tier, the team tier walks past inactive providers.** A team default is imposed on members who did not pick it and cannot clear it, so a default whose provider was later disabled falls through to the cascade's next tier instead of failing every member's build (originally the org preference list per decision 6; now the `"s"` tier fallback — see the Extension below). Only the user's own explicit default resolves straight through and fails loudly.
- **Write path:** `PATCH /api/teams/:id { defaultModel }`, whitelist-strict like `PATCH /api/me`, validated via the shared `validateDefaultModelId` (`services/model-catalog.ts`), gated by `canAdministerTeam`. Not origin-gated: an IDP mirror's membership belongs to the identity provider, but `default_model` is Valet-local state no sync writes.
- **Restore is unchanged:** the persisted session model always wins (restore-no-clobber).
- **Ownership stays per-field.** `SessionMeta.ownerTeamId` feeds the model cascade ONLY. The engine principal for a team-owned `buildSession` session remains `{ type: "user" }` (pre-existing), so credentials and skills stay user-scoped; do not read `ownerTeamId` as the session's principal.

## Extension: runtime model registry (2026-09-02, TKAI-327)

The model list used to come from `getModels`/`getModel` on
`@earendil-works/pi-ai/compat`, which read a catalog baked into the published
pi-ai tarball. A new model stayed invisible until pi cut a release and Valet
bumped the dependency. Both functions are marked `@deprecated Static catalog
read`, and `/compat` says it is temporary.

`services/model-registry.ts` now fetches the catalog at runtime and keeps the
bundled catalog as the floor.

- **One code path.** `buildOrgCatalog` reads `registryModels(kind)` and
  `resolveModelSpec` reads `registryModelById(kind, id)`. Both answer from the
  same collection, so a model cannot appear in the picker and then fail at turn
  start. `services/openrouter.ts`'s registry read moved to the same source.
  Model-id namespacing is unchanged.
- **The fallback is structural.** The registry is a pi-ai `createProvider`
  whose static `models` is the bundled compile-time catalog and whose
  `fetchModels` is the upstream fetch. pi-ai overlays the fetched list onto
  the baseline by id, so a fetch that fails, times out, or returns malformed
  data leaves the bundled list serving. A failed check returns the STORED
  catalog rather than an empty list, because `createProvider` persists what
  `fetchModels` resolves to and an empty return would erase a good cache.
  The served list degrades stored, then bundled, and never to nothing.
- **The cache is Postgres.** `PgModelsStore` implements pi-ai's `ModelsStore`
  over `model_registry_cache` (one row per pi-ai provider id, deployment-wide,
  not org-scoped). The catalog and its validators survive a restart and are
  shared by every api replica, so the second replica to check sends the first
  one's `etag`. A write that carries no validators keeps the stored ones:
  pi-ai persists `{ models, checkedAt }` itself after `fetchModels` returns,
  and clearing the columns there would make every later check unconditional.
  Rows are validated on read as well as on write, and a row older than 30 days
  is ignored so a dead catalog cannot serve forever.
- **Refresh.** Boot restores from the cache with no network access, then
  refreshes in the background; a timer re-checks every 6 hours. The check
  sends `If-None-Match`/`If-Modified-Since`, so an unchanged catalog costs a
  304. A 304 re-stamps `checkedAt`, which distinguishes "verified fresh" from
  "never checked".
- **Off by default.** `VALET_MODEL_REGISTRY_URL` names the upstream base; each
  provider is read from `{base}/{providerId}.json`. Unset means no fetch and
  the bundled catalog, which is the behavior before this change. The
  zero-config path is unaffected: an org with no `llm_providers` rows and only
  `ANTHROPIC_API_KEY` still sees the Anthropic list.
- **Visibility.** `GET /api/models/registry-status` reports per provider the
  model count, `checkedAt`, whether the bundled fallback is in use, and the
  last error. The catalog degrades silently by design, so this route is how an
  operator sees a stuck check. The admin LLM-providers UI does not render it
  yet — deferred to keep this change reviewable.

## Extension: manual bundled overlay (2026-09-05)

Valet uses pi-ai and pi-agent-core 0.85.0. This release bundles
`claude-fable-5-1`. The `MANUAL_BUNDLED_MODELS` table adds models that pi
has committed but has not released. Pi bundled entries win by id. Each manual
entry must match pi's generated catalog. A canary test fails when a later pi
release bundles the id, which signals that the manual entry must be removed.
The first entry is `gpt-6-astra` from unreleased pi commit `17de82d7`.

## Extension: org model preferences removed (2026-09-03, model-selector-overhaul follow-up)

Model size tiers (`docs/specs/2026-09-03-model-selector-overhaul-design.md`,
TKAI-285) replace `orgs.model_preferences` as the org's fallback. This
removes every piece this doc described for it:

- `orgs.model_preferences`, `getOrgModelPreferences`/`setOrgModelPreferences`,
  `GET`/`PUT /api/org/llm-providers/preferences`, `ModelPreferencesSection`
  (web), and the delete-refused-while-default guard on `DELETE
  /api/org/llm-providers/:id` and `.../:id/key`.
- The catalog no longer preference-sorts. `buildOrgCatalog` returns entries
  in construction order (active before inactive); the "not listed sort
  after, alphabetically" rule in decision 5 no longer applies.

The new-session model chain (`EngineHost.resolveModelForBuild`) is:

`existing?.model ?? overrideId ?? assistantDefault ?? childDefault ??
userDefault ?? teamDefault ?? opts.defaultModelId ?? "s"`

The final fallback is the tier token `"s"`, not a hardcoded model id.
`resolveModelSpec` resolves it through the org's tier map exactly like an
explicit tier pick, and `resolveTier` is the walk-past-inactive-entries
logic that `orgPreferredModel` used to do — an org remap of its `s` tier
reaches every session that bottoms out at this fallback. When every one of
a tier's targets is inactive, the host raises a corrective error naming
the fix (`no active provider for tier "s" — enable a provider for one of
its targets in Settings → Organization → Models`) instead of falling
through further — there is no fallback beyond the tier itself.

## Non-goals

- Per-user LLM keys (org + deployment env only this pass).
- Provider-level spend limits/quotas (usage spec shows spend; enforcement is future).
- Azure OpenAI / Bedrock / Vertex specific auth flows (pi-ai supports them; each has bespoke credential shapes — add per demand as new `kind`s).
- Automatic model failover mid-turn.
- Proxying/rewriting model traffic through the api (turns call providers directly from the api process as today).
- Migrating legacy D1 service-config keys (pre-1.0).
