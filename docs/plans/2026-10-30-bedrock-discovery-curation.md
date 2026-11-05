# Bedrock Discovery and Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `us.anthropic.*` Bedrock catalog filter with account-driven discovery plus the same admin-curated model picker OpenRouter has.

**Architecture:** A `bedrock-discovery` service (injectable AWS client, 1h cache) derives invokable model ids from `ListFoundationModels` and `ListInferenceProfiles`, hides Anthropic until `GetUseCaseForModelAccess` succeeds, and merges with pi-ai's registry. The catalog moves `amazon-bedrock` from the full-registry known-kind path to the curated branch, generalized from OpenRouter's. A new admin route serves discovery to a kind-parameterized web picker. Resolution synthesizes selections the registry lacks. Infra widens the IRSA policy.

**Tech Stack:** TypeScript, vitest, Hono, Drizzle, React; `@aws-sdk/client-bedrock@3.1127.0` (new); OpenTofu for IAM.

**Spec:** `docs/specs/2026-10-29-bedrock-provider-design.md`, section "Extension 2026-10-30".

## Global Constraints

- `amazon-bedrock` stays the kind string. Ids stay `amazon-bedrock/<bedrock-id>`.
- Discovery never derives `global.*` profiles. Anthropic ids appear only when `GetUseCaseForModelAccess` succeeds.
- Discovery failure degrades to the registry list with `live: false`; it never throws into a request.
- New dependency pinned exactly: `"@aws-sdk/client-bedrock": "3.1127.0"` in `packages/api/package.json`.
- OpenRouter behavior and copy are unchanged; the existing test "Escape dismisses the OpenRouter model picker" keeps passing with the aria-label "Filter OpenRouter models".
- Commit rules as before: ≤72-char subjects, `Changelog:` body line, PR ≤300 words.

## Review Focus

1. A model with `inferenceTypesSupported: ["INFERENCE_PROFILE"]` and no `us.` profile in the account: must be omitted, not listed under its bare id. Pinned in Task 1.
2. `GetUseCaseForModelAccess` fails with a non-404 error (throttle, denied): Anthropic should be hidden (fail closed on the form), not shown. Pinned in Task 1.
3. Admin selects a discovered id the registry lacks, then starts a session on it: must resolve via synthesis with `api: "bedrock-converse-stream"`. Pinned in Task 4.
4. Zero-config (no row) with discovery failing: default set must still list (registry-trusted), not go empty. Pinned in Task 3.
5. A persisted `amazon-bedrock/us.anthropic.claude-sonnet-5-5` session when Anthropic is hidden by the form: still resolves (registry), fails at Bedrock with its own message. Pinned in Task 4 (resolution accepts registry ids regardless of catalog).

---

### Task 1: Discovery service

**Files:**
- Create: `packages/api/src/services/bedrock-discovery.ts`
- Create: `packages/api/src/services/bedrock-discovery.test.ts`
- Modify: `packages/api/package.json` (dependency), `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  - `export const BEDROCK_DEFAULT_MODEL_IDS: readonly string[]` = `["qwen.qwen3-coder-next", "deepseek.v3.2", "mistral.devstral-2-123b", "moonshotai.kimi-k2.5", "openai.gpt-oss-120b-1:0", "us.meta.llama4-maverick-17b-instruct-v1:0", "zai.glm-4.7", "minimax.minimax-m2.5"]`
  - `export function bedrockRegistry(): Map<string, Model<Api>>` (registryModels("amazon-bedrock") by id)
  - `export function curatedBedrockModels(): LlmProviderModel[]` (defaults resolved through the registry; unknown ids dropped)
  - `export type BedrockDiscoveryClient = { send(cmd: unknown): Promise<unknown> }`
  - `export function parseBedrockDiscovery(input: { foundationModels: unknown; inferenceProfiles: unknown; geoPrefix: string; anthropicAllowed: boolean }): { id: string; name: string }[]` (pure)
  - `export async function discoverBedrockModels(opts?: { client?: BedrockDiscoveryClient; region?: string; now?: () => number }): Promise<{ models: LlmProviderModel[]; live: boolean }>` (cached 1h per region; merges discovery with registry metadata)
  - `export function resetBedrockDiscoveryCache(): void`
  - `export function geoPrefixForRegion(region: string): string` (`us-*`→`us.`, `eu-*`→`eu.`, `ap-*`→`apac.`, `ca-*`→`ca.`, `sa-*`→`sa.`, else `us.`)

- [ ] **Step 1: Add the dependency**

Run: `cd packages/api && pnpm add @aws-sdk/client-bedrock@3.1127.0` then `pnpm install --frozen-lockfile` at root must still pass (commit the lockfile).
Expected: lockfile gains one direct dep; `ls node_modules/.pnpm | grep client-bedrock@` shows 3.1127.0.

- [ ] **Step 2: Write the failing tests**

Fixtures: hand-written `ListFoundationModelsCommandOutput`-shaped and `ListInferenceProfilesCommandOutput`-shaped objects with: an ON_DEMAND text model (`qwen.qwen3-coder-next`), a profile-only model with a `us.` profile (`meta.llama4-maverick-17b-instruct-v1:0` + `us.meta...`), a profile-only model with ONLY a `global.` profile (must be omitted), an Anthropic model with both bare and `us.` ids, an image-output model (omitted), a LEGACY lifecycle model (omitted), a model with `responseStreamingSupported: false` (omitted).

```ts
describe("parseBedrockDiscovery", () => {
  it("lists on-demand models by bare id and profile-only models by their geo profile", ...);  // qwen bare, us.meta present, bare meta absent
  it("omits models whose only profile is global", ...);
  it("omits anthropic ids unless anthropicAllowed", ...);
  it("omits non-text, non-streaming, and non-ACTIVE models", ...);
});
describe("discoverBedrockModels", () => {
  it("merges discovery with registry metadata and keeps unknown ids with bedrock names and no pricing", ...); // fake client send() dispatches on cmd.constructor.name
  it("hides anthropic when GetUseCaseForModelAccess rejects with ResourceNotFoundException", ...);
  it("hides anthropic when GetUseCaseForModelAccess fails for any other reason", ...);
  it("caches for an hour per region", ...);   // send called once across two calls; now() advanced 3601s → called again
  it("degrades to the registry list with live:false when the client throws", ...);
});
it("every default id exists in the pi-ai amazon-bedrock registry", () => { for (const id of BEDROCK_DEFAULT_MODEL_IDS) expect(bedrockRegistry().has(id)).toBe(true); });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @valet/api test bedrock-discovery`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

Mirror `services/openrouter.ts`. Dispatch the fake-able client by command class: `ListFoundationModelsCommand({ byOutputModality: "TEXT" })`, `ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" })` (paginate on `nextToken`), `GetUseCaseForModelAccessCommand({})`. Default client: `new BedrockClient({ region })` with `region = opts.region ?? process.env.AWS_REGION ?? "us-east-1"`. Cache: module Map keyed by region → `{ at, result }`, TTL 3_600_000 ms. Merge: for each discovered id, `registry.get(id)` → `toProviderModel`-equivalent; else `{ id, name: bedrock modelName }`. Sort by id.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @valet/api test bedrock-discovery` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

`feat(api): Bedrock model discovery service` with Changelog line "Valet discovers which Bedrock models the AWS account can invoke."

---

### Task 2: Discovery route, curation gate, seeding

**Files:**
- Modify: `packages/api/src/routes/llm-providers.ts:97-99,146-153,198-215,267-275`
- Modify: `packages/api/src/wire/types.ts:4995-4998`
- Test: `packages/api/src/routes/llm-providers.test.ts`

**Interfaces:**
- Produces: `GET /api/org/llm-providers/amazon-bedrock/models` → `ProviderModelCatalogResponse { models: LlmProviderModelWire[]; live: boolean }` (new generic name; `OpenrouterRegistryResponse` becomes a type alias of it). `kindAcceptsModels("amazon-bedrock") === true`. POST with `kind: "amazon-bedrock"` and no `models` seeds `curatedBedrockModels()`. Error strings name both curated kinds.

- [ ] **Step 1: Write failing tests** (mirror the openrouter describe at ~959 and the create tests at ~210-245): 403 for non-admin; returns discovery from an injected fake (export a test seam: `setBedrockDiscoveryClientForTests(client)` in the service, or stub `discoverBedrockModels` via `vi.mock`); create seeds defaults; PATCH `models` accepted on a Bedrock row; error string for models on an anthropic row mentions amazon-bedrock.
- [ ] **Step 2: Run, expect FAIL** (404 on the route; 400 on PATCH).
- [ ] **Step 3: Implement.** Add `defaultModelsFor(kind)` helper used by create. Register the route before `/:id`.
- [ ] **Step 4: Run + typecheck, expect PASS.**
- [ ] **Step 5: Commit** `feat(api): Bedrock discovery route and curated model selection`.

---

### Task 3: Catalog curated branch

**Files:**
- Modify: `packages/api/src/services/model-catalog.ts:72-96,144-160,186-230`
- Test: `packages/api/src/services/model-catalog.test.ts` (replace the `amazon-bedrock` describe)

**Interfaces:**
- Produces: `amazon-bedrock` removed from `KnownCatalogKind`/`KNOWN_KINDS`/`KNOWN_KIND_LABEL`; `BEDROCK_CATALOG_FILTER` and `registryModelsForCatalog` removed. New internal `curatedKindEntries({ kind, rows, registry, defaults, envPresent, label })` used for both openrouter and amazon-bedrock. Bedrock zero-config default = `curatedBedrockModels()` filtered to `discoverBedrockModels()` ids when that call returns `live: true`.

- [ ] **Step 1: Write failing tests**: zero-config with `AWS_PROFILE` and a fake discovery (inject via the test seam) lists exactly defaults ∩ discovered; zero-config with discovery failing lists all defaults; row with selection lists exactly the selection registry-enriched; disabled row inactive; no `anthropic.` ids appear unless selected; existing openrouter tests unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, keeping the openrouter branch's exact semantics.
- [ ] **Step 4: Run `model-catalog.test model-tiers.test` + typecheck, expect PASS.** Note `model-tiers.ts` `ENV_FALLBACK_KINDS` keeps `amazon-bedrock` (tiers rule unchanged).
- [ ] **Step 5: Commit** `feat(api): curated Bedrock catalog from account discovery`.

---

### Task 4: Resolution synthesis

**Files:**
- Modify: `packages/api/src/services/model-resolution.ts:150-172,268-273`
- Test: `packages/api/src/engine/host.model-resolution.test.ts`

**Interfaces:**
- Produces: `synthesizeCuratedModel(kind: "openrouter" | "amazon-bedrock", row, modelId)` replacing `synthesizeOpenrouterModel`; for Bedrock: `api: "bedrock-converse-stream"`, `provider: "amazon-bedrock"`, `baseUrl` = any bundled Bedrock model's baseUrl.

- [ ] **Step 1: Failing test**: a Bedrock row whose `models` includes `{ id: "vendor.brand-new-model", name: "Brand New" }` resolves with `model.api === "bedrock-converse-stream"`, `provider === "amazon-bedrock"`, `canonicalId === "amazon-bedrock/vendor.brand-new-model"`; an unselected unknown id returns null; a registry id (`us.anthropic.claude-sonnet-5-5`) still resolves from the registry regardless of selection.
- [ ] **Step 2: Run, expect FAIL** (null).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `host.model-resolution` + typecheck, expect PASS.**
- [ ] **Step 5: Commit** `feat(api): resolve curated Bedrock selections the registry lacks`.

---

### Task 5: Web picker

**Files:**
- Modify: `packages/web/src/api/client.ts:1384`, `packages/web/src/api/settings.ts:101,208-218`
- Modify: `packages/web/src/components/settings/llm-providers-section.tsx:202-222,237-350`
- Test: `packages/web/src/routes/-settings.organization.models.test.tsx`

**Interfaces:**
- Produces: `api.providerModelCatalog(kind)` → `GET /org/llm-providers/${kind}/models`; `useProviderModelCatalog(kind, { enabled })` with key `["settings","providerModelCatalog",kind]`; `useOpenrouterRegistry` kept as a thin wrapper so existing mocks work. `CuratedModelsEditor({ provider, kind })` with per-kind copy: openrouter unchanged; amazon-bedrock aria-label "Filter Amazon Bedrock models", placeholder "Search models available in your AWS account", live:false notice "Couldn't reach Amazon Bedrock; showing the bundled registry". Mounted for both kinds.

- [ ] **Step 1: Failing test** "Escape dismisses the Amazon Bedrock model picker" mirroring the OpenRouter one, with the catalog hook mocked for `amazon-bedrock`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `settings.organization.models` + typecheck, expect PASS; the OpenRouter Escape test still passes.**
- [ ] **Step 5: Commit** `feat(web): curated model picker on the Amazon Bedrock card`.

---

### Task 6: Spec status, PR

- [ ] Flip the extension's status line in the spec; run full api/web suites; record counts and name pre-existing failures (known: skill-files, skill-collector, orchestrator-*, composer-drafts, integration-oauth flake).
- [ ] PR against dev-v2, ≤300 words: Problem (static filter, account gate, open models), Fix (discovery + curation, synthesis, new dep), Validation, Rollout (infra PR widens IAM first or picker shows registry fallback until then).

---

### Task 7: Infra IAM widening (tkhq/test-agents-infra)

**Files:**
- Modify: `modules/infra/bedrock.tf`

- [ ] Policy: invoke resources → `arn:aws:bedrock:*::foundation-model/*` plus the existing inference-profile ARN; add a second statement `BedrockDiscovery` with `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles`, `bedrock:GetUseCaseForModelAccess` on `*`.
- [ ] `tofu plan`: expect 0 add, 1 change (policy document), 0 destroy. Apply. Post-apply plan clean.
- [ ] PR ≤300 words; merge. No Flux change, no pod restart needed (IAM is evaluated per call).
- [ ] Verify from the pod: `node -e` with `@aws-sdk/client-bedrock` `ListFoundationModelsCommand` returns models; then the picker on agents-dev lists them.
