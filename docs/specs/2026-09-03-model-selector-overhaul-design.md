# Model selector overhaul: tiers, approved models, reasoning levels

Date: 2026-09-03
Status: approved design, pre-implementation
Base: dev-v2 (requires #521 model size tiers and #524 tier vocabulary)

## Summary

The backend has model size tiers (`xs`, `s`, `m`, `l`, `xl`, TKAI-285) and a
per-org tier map, but no UI exposes them. This change adds:

1. A tier-first model picker in the chat UI and in every model combobox.
2. An org admin UI for the tier map on the org models settings page.
3. An org-level approved-models allowlist (new) with a soft gate.
4. A per-assistant model setting (new column) and a tier-first upgrade of the
   personal default-model control.
5. Reasoning levels (pi-ai `ThinkingLevel`) as a first-class setting at every
   surface that has a model setting, plus an org default and max cap.

## Decisions (locked with Conner, 2026-09-03)

- Tiers are aliases. Sessions, threads, assistants, and defaults store the
  tier token. The server resolves the token to a concrete model at run time,
  so an org remap reaches existing sessions.
- The UI shows all five tiers with labels. It does not hide `xs`.
- Both assistant surfaces get model settings: the per-assistant editor gains
  a model field, and the personal `/settings/assistant` default-model control
  becomes tier-first.
- Approved models is a new allowlist with a soft gate: an unset list approves
  the whole catalog; when set, it constrains members but not org admins.
- Tier map targets must be approved models when the allowlist is set.
- Reasoning level is settable everywhere the model is settable.
- Orgs get a default reasoning level and a max cap. The cap applies to
  everyone, including admins. Admins raise the cap when they need more.

## Current state (dev-v2)

### Tiers (merged, backend only)

- `packages/api/src/services/model-tiers.ts` — `TIER_TOKENS`,
  `DEFAULT_TIER_MAP` (xs/s → Haiku, m → Sonnet, l/xl → Opus),
  `getOrgTierMap`, `setOrgTierMap`, `resolveTier`.
- `orgs.model_tiers` jsonb (null = defaults) + `SCHEMA_REPAIRS` entry.
- `GET /api/org/model-tiers` (member) / `PATCH` (admin) in
  `packages/api/src/routes/model-tiers.ts`. No wire types; the route
  hand-rolls JSON.
- `resolveModelSpec` intercepts tier tokens and persists the token as
  `canonicalId`. `catalogValidIds` accepts tier tokens. Child sessions
  default to tier `s` via `childDefault` in `resolveModelForBuild`.
- Nothing in `packages/web` references tiers.

### Model selection surfaces (web)

- Chat picker: `packages/web/src/components/session/model-picker.tsx`.
  Groups by provider, curates Anthropic ids, submits catalog ids only.
  Persists per thread (`PATCH /api/sessions/:id/threads/:threadId`) or per
  session (`PATCH /api/sessions/:id`).
- Org models page: `packages/web/src/routes/settings.organization.models.tsx`
  renders `LlmProvidersSection` + `ModelPreferencesSection`
  (ordered fallback chain stored in `orgs.model_preferences`).
- Personal default: `/settings/assistant` binds `ModelCombobox` to
  `users.default_model` via `PATCH /api/me`.
- Team default: `teams.default_model` via `usePatchTeam`.
- Per-assistant editor (`/assistants/$assistantId`): no model setting;
  `assistants` has no model column.

### Model resolution cascade

`resolveModelForBuild` (`packages/api/src/engine/host.ts`):
`existing?.model → overrideId → childDefault → userDefault → teamDefault →
orgPreferredModel → opts.defaultModelId → "claude-haiku-4-5"`.

### Reasoning (engine seam exists, product surface does not)

- pi-ai: `ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" |
  "max"`; per-model `thinkingLevelMap`; helpers
  `getSupportedThinkingLevels` / `clampThinkingLevel`.
- Engine: `CreateSessionOptions.sampling.reasoning` flows into every stream
  call (`packages/engine/src/thread.ts` `buildAgent`). Only the eval harness
  sets it (TKAI-352).
- pi-agent-core: mutable `AgentState.thinkingLevel` (adds `"off"`), never
  touched by the engine.
- `ModelInfo.reasoning: boolean` (capability bit) is served by
  `GET /api/models` and unused. The catalog drops `thinkingLevelMap`.
- No wire field, DB column, route param, or web UI for reasoning effort.

## Design

### 1. Vocabulary and labels

Tier display labels are fixed: `xs` Extra Small, `s` Small, `m` Medium,
`l` Large, `xl` X-Large. A new `packages/web/src/lib/model-tiers.ts` exports
the ordered tier list, labels, and short badges. Every tier control shows the
label plus the resolved model name, for example "Large — Claude Opus 4.7".

Reasoning levels use pi-ai's six tokens ordered
`minimal < low < medium < high < xhigh < max`. A new
`packages/web/src/lib/reasoning.ts` exports the order and labels. "Default"
in the UI means unset (inherit the cascade).

Naming collision: `packages/web/src/lib/models.ts` has a UI-only
`tier: "fast" | "balanced" | "powerful"` badge field. Rename it to
`speedClass` so "tier" means only the size tier.

### 2. Schema

Pre-1.0 rule: edit `packages/api/migrations/pg/0000_app.sql` and the Drizzle
schema in place, and add a matching `SCHEMA_REPAIRS` entry per column.

- `orgs.approved_models` jsonb, nullable. Null = unset = whole catalog
  approved. An empty array is rejected at the API (400) so an org cannot
  lock everyone out.
- `orgs.reasoning_settings` jsonb, nullable:
  `{ "default"?: ThinkingLevel, "max"?: ThinkingLevel }`. Null = no org
  default, no cap.
- `assistants.model` text, nullable. Holds a tier token or a catalog id.
- `assistants.reasoning` text, nullable.
- `users.default_reasoning` text, nullable.
- `teams.default_reasoning` text, nullable.

After the edit, every worktree with dev data needs `make dev-clean`.

### 3. Wire types and API routes

New wire types in `packages/api/src/wire/types.ts` (also closes the merged
gap where the tier route has no wire types):

- `TierMap`, `GetModelTiersResponse`, `PatchModelTiersRequest`.
- `GetApprovedModelsResponse { approved: string[] | null }`,
  `PutApprovedModelsRequest { approved: string[] | null }`.
- `OrgReasoningSettings { default?: string; max?: string }` with
  `GET`/`PATCH` request/response types.
- `reasoning?: string | null` added beside `model` on `PatchSessionRequest`,
  `PatchThreadRequest`, `PatchMeRequest`, `PatchTeamRequest`,
  `PatchAssistantRequest`; echoed on `SessionData`, thread reads,
  `MeResponse`, `TeamSummary`, `AssistantSummary`.
- `ModelInfo` gains `approved: boolean` and `thinkingLevels?: string[]`
  (from pi-ai `thinkingLevelMap`, mapped in `model-catalog.ts`).

Routes:

- `GET /api/org/approved-models` (member) / `PUT` (org admin). Every id must
  pass `catalogValidIds`. Mirrors the model-tiers route.
- `GET /api/org/reasoning` (member) / `PATCH` (org admin). Values must be
  known levels; `default` must not exceed `max` when both are set.
- `PATCH /api/org/model-tiers` additionally requires each target spec to be
  approved when the allowlist is set.

### 4. Enforcement

New helper `assertModelSelectable(db, orgId, isOrgAdmin, spec)` in
`packages/api/src/services/model-catalog.ts` (or a sibling module):

1. Tier tokens always pass.
2. Org admins always pass.
3. A null allowlist always passes.
4. Otherwise the spec must be in `orgs.approved_models`, or the route
   returns 400 with: "Model <id> is not in the org's approved list. Ask an
   org admin to approve it in Settings → Organization → Models."

Applied at every model-accepting write: session model, thread model,
`PatchMe.defaultModel`, team `defaultModel`, assistant `model`.

Reasoning cap helper `assertReasoningSelectable(db, orgId, level)`: the
level must be a known token and must not exceed `orgs.reasoning_settings.max`
when set. The cap applies to everyone. Error text names the cap and the
settings page.

Existing sessions pinned to a now-unapproved model keep running. There is no
run-time refusal and no auto-repair; the pin only becomes unselectable.

### 5. Resolution cascades

Model (in `resolveModelForBuild`): insert `assistantDefault` after
`overrideId` and before `childDefault`:

`existing?.model → overrideId → assistantDefault → childDefault →
userDefault → teamDefault → orgPreferredModel → opts.defaultModelId →
fallback`.

Sessions built for an assistant pass `assistants.model` as
`assistantDefault`. The value may be a tier token; `resolveModelSpec`
already handles the token and persists it as the canonical id.

Reasoning (new, parallel, resolved in `host.ts` at session build):

`session/thread override → assistantDefault → userDefault → teamDefault →
orgDefault → unset`.

The resolved level is clamped to `orgs.reasoning_settings.max` and then fed
to `engine.createSession({ sampling: { reasoning } })`. The engine clamps to
the model's supported levels with pi-ai `clampThinkingLevel` before it
streams, so a tier remap to a weaker model degrades instead of failing.

### 6. Engine changes (reasoning only)

- `thread.setReasoning(level | null)` mirroring `thread.setModel`: writes
  the pi-agent-core `AgentState.thinkingLevel`, persists in thread state,
  and survives reload. Follow the tool-call persistence round trip rules
  (engine write → wire → REST → frontend) and add regression tests at each
  hop.
- `PATCH /api/sessions/:id/threads/:threadId` accepts `reasoning` and calls
  `thread.setReasoning`. `PATCH /api/sessions/:id` accepts `reasoning` for
  the session default (stored in session options sampling).
- No change to `switch_model` or `task` builtin tools (out of scope, below).

### 7. Web UI

Org models page (`settings.organization.models.tsx`) gains sections:

- **Model tiers** (admin-editable): five rows, one per tier, each an ordered
  target list (primary + fallbacks) that reuses the `ModelPreferencesSection`
  row pattern. Backed by new client methods + hooks for
  `/api/org/model-tiers`.
- **Approved models**: a "Restrict members to approved models" switch. On
  enable, seed the list from the current curated set. Below the switch, a
  catalog checklist. Backed by `/api/org/approved-models`.
- **Reasoning**: default level select + max cap select. Backed by
  `/api/org/reasoning`.

Chat picker (`model-picker.tsx`):

- A "Size" group pinned first: five labeled tiers, resolved model name as
  subtitle. Selecting a tier submits the token (for example `"l"`).
- A "Models" group after: the long tail. Members see approved models only;
  admins see the full catalog. Current curated/show-more/search behavior
  stays.
- A compact reasoning row below the list (one popover, two knobs). Levels a
  model does not support are disabled; levels above the org cap are hidden.
- The header chip renders the tier label, and appends the level when it is
  not default, for example "Large · high".

`ModelCombobox` gains the same tier-first "Size" group and an optional
reasoning control, then is used at:

- Per-assistant editor (`/assistants/$assistantId`): new "Model" and
  "Reasoning" field rows, clearable back to inherit, via
  `PatchAssistantRequest`.
- Personal `/settings/assistant`: existing default-model row becomes
  tier-first; a default-reasoning row is added; hint copy updated.
- Team defaults on the org teams page: same pair.

### 8. Testing

- API unit tests: enforcement matrix (member/admin × list set/unset ×
  tier/approved/unapproved), empty-allowlist 400, tier-map targets must be
  approved, reasoning cap (including default > max rejection), cascade
  order with `assistantDefault` for both model and reasoning, wire round
  trips.
- Engine tests: `setReasoning` persistence round trip (`happy-path`,
  `in-memory-store`, `store-postgres` suites).
- Web: `make e2e E2E_ARGS="--only web-build"` after wire changes.
- Full `make e2e` scorecard before the work is called done.

## Out of scope

- An effort parameter on the `switch_model` / `task` builtin tools
  (agent-driven effort changes). Follow-up.
- A hard gate on unapproved models at run time. Existing pins keep running
  by design (alert, don't auto-repair).
- Collapsing the backend to four tiers. The five-token vocabulary stands.

## Deviations

None yet. Record implementation deviations here.
