# Amazon Bedrock Provider Design — a known provider kind on the AWS credential chain

**Date:** 2026-10-29
**Status:** Implemented (Valet side, #1101); infra applied (test-agents-infra #237). Extension below (discovery + curation) implemented on the Valet side; IAM widening in test-agents-infra.
**Scope:** Add Amazon Bedrock as a known LLM provider kind in Valet, equal in standing to Anthropic, OpenAI, and Google. Authenticate through the AWS credential chain (IAM role on the api pod) or an org-level Bedrock API key. Expose Anthropic models on Bedrock in the org catalog with registry pricing. Deploy to agents-dev with an IRSA role and a one-line chart addition. Extends `2026-07-16-llm-providers-design.md`.

## Intent

Run Valet's agent loop on Claude models billed through the company AWS account, with no GPU operations and no new API key to hold. This is the chosen alternative to the KServe GPU path (test-agents-infra #65, valet #777), which stays open as an experimentation lane.

## Context

- The engine already depends on `@earendil-works/pi-ai@1.0.3`, which ships provider id `amazon-bedrock` (api `bedrock-converse-stream`) with 185 catalogued chat models, per-model `cost`, and a bundled `@aws-sdk/client-bedrock-runtime`. The lockfile already contains it. No new dependency.
- pi-ai's Bedrock auth order: explicit `apiKey` (sent as a Bedrock bearer token) → `AWS_BEARER_TOKEN_BEDROCK` → `AWS_PROFILE` → static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` → container credentials → IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`). When any ambient source exists, `getEnvApiKey("amazon-bedrock")` returns the marker string `"<authenticated>"`, not a key.
- Valet's known kinds (`anthropic`, `openai`, `google`, `openrouter`) are literally pi-ai provider ids. The kind string is passed to `createProvider`, `bundledModels`, `registryModels`, and `getEnvApiKey` unchanged, and the engine's `resolveModelId` calls `bundledModel(namespace, id)` directly.
- The agents-dev account already lists the current Anthropic lineup on Bedrock (Haiku 4.5, Sonnet 4.5/4.6/5/5.5, Opus 4.x/5/5.5, Fable 5/5.1) plus `us.` and `global.` cross-region inference profiles.
- The agents-dev cluster already uses IRSA for EBS CSI, cluster-autoscaler, and External Secrets (`modules/infra/irsa.tf`, `modules/infra/secrets.tf`). Valet deploys through Flux from `flux/agents-dev/values.yaml`.

## Decisions

1. **Kind name is `amazon-bedrock`, the pi-ai provider id.** Model ids are `amazon-bedrock/<bedrock-model-id>`, for example `amazon-bedrock/us.anthropic.claude-sonnet-5-5`. This follows the existing convention (kind == pi-ai id), so every registry, env, and engine lookup works with no id mapping. UI label: "Amazon Bedrock". `parseModelId` splits on the first slash, so dots and colons in Bedrock ids are safe.

2. **Credentials: AWS chain first, org bearer token optional. No new columns.**
   - With no org credential, the resolver passes `apiKey: undefined` to pi-ai, which falls through to the AWS SDK default chain. On agents-dev that is the pod's IRSA role.
   - An admin may store a Bedrock API key (bearer token) on the org row through the existing key route. It is stored as today's `api_key` credential and passed as pi-ai `apiKey`, which pi-ai sends as a bearer token.
   - The resolver must treat the `"<authenticated>"` marker as "deployment credentials available" and emit `apiKey: undefined`, never the marker string. The `NoCredentialsError` check for this kind is "no org key and marker absent".
   - Static AWS access key pairs per org are out of scope. The bearer token covers BYO.

3. **Region is deployment-level.** On EKS the pod identity webhook injects `AWS_REGION` and `AWS_DEFAULT_REGION` next to the IRSA token when the ServiceAccount carries the role annotation, so no chart env plumbing is needed. pi-ai reads `AWS_REGION`. When a region is configured pi-ai ignores the catalog `baseUrl`, so only profiles routable from that region work. No per-row region in this pass.

4. **Catalog is curated to US inference profiles for Anthropic.** `buildOrgCatalog` lists only registry models whose id matches `^us\.anthropic\.` for this kind. Verified 2026-10-29 from the agents-dev account: bare `anthropic.*` ids for Claude 4.x and 5.x are rejected with "on-demand throughput isn't supported" and need an inference profile; `eu.`/`apac.`/`jp.`/`au.`/`in.` profiles are unreachable from a `us-east-1` pod under decision 3; `global.*` routes to any commercial region and is excluded until a data-residency decision says otherwise. That leaves about 15 usable entries. Pricing comes from pi-ai registry `cost` fields. Turn cost is computed by pi-ai from `model.cost`, so usage and spend work without new pricing rows. Widening the filter is a one-line change.

5. **Activation follows the known-kind rules, zero-config.** With no row, the catalog synthesizes the kind when the marker is present (the same zero-config path Anthropic uses with `ANTHROPIC_API_KEY`), so IRSA plus the new image activates Bedrock with no instance-config entry and no UI step. With a row, active means enabled and (org key or marker). The Settings card shows the existing deployment badge with copy "using deployment AWS credentials". No `llmProviders` entry is added to agents-dev instance config: an entry with an unknown kind fails api boot on any image older than this change, which would couple the Flux merge to the promotion.

6. **Chart.** Add `serviceAccount.annotations` (map, rendered on the ServiceAccount, default empty). Chart version `0.10.25` → `0.10.26`.

7. **Infra (test-agents-infra).** New IRSA role `agents-dev-valet-bedrock` for `valet:valet-api`, built with the same `iam-role-for-service-accounts-eks` module as External Secrets. Policy: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/anthropic.*` and on `arn:aws:bedrock:*:<account>:inference-profile/*`. Flux values set the role-arn annotation and bump the chart version. Rollout order: (1) Valet PR merges to dev-v2 and promote-dev pins the new image; (2) chart `0.10.26` is published; (3) human applies `environments/dev/infra` to create the role; (4) the Flux PR (chart bump + annotation + validator guard) merges by hand, since promote-dev never auto-merges chart bumps. The role ARN is deterministic, so the Flux change can be authored before the apply. Model access and a live Converse call were verified from the account on 2026-10-29; per-model quotas were not read and throttling should be watched after cutover.

8. **Out of scope.**
   - The `/proxy/*` recording gateway and `valet proxy` harnesses. They speak the Anthropic and OpenAI wire with API keys. Bedrock needs SigV4 there. Separate follow-up if wanted.
   - Bedrock-only deployments. `main.ts` still requires `ANTHROPIC_API_KEY` at boot, and auto-title, memory, and thread-recap call Anthropic directly. agents-dev keeps its Anthropic key.
   - Non-Anthropic Bedrock models and `global.*` profiles in the picker (decision 4 makes this a filter change).
   - Per-org AWS regions or access keys.
   - Moving agents-dev tiers or default models onto Bedrock. That is an admin action in Models settings after this ships, and it changes which quotas sessions hit.

## Files that change (Valet)

Kind lists: `packages/api/src/config/instance-config.ts` (type, Set, error text), `packages/api/src/schema/index.ts` (Drizzle enum; `kind` is plain text in SQL, so no migration), `packages/api/src/wire/types.ts`, `packages/api/src/services/llm-providers.ts`, `packages/api/src/routes/llm-providers.ts` (error strings), `packages/web/src/components/settings/llm-providers-section.tsx` (kind, label, key-field copy).

Known-kind sets: `packages/api/src/services/model-registry.ts` (`REGISTRY_PROVIDERS`), `model-resolution.ts` (`KnownKind`, marker handling), `model-catalog.ts` (`KNOWN_KINDS`, label, Anthropic filter), `model-tiers.ts` (`ENV_FALLBACK_KINDS`), `packages/api/src/engine/host.ts` (`firstActivePreference` namespace list).

Labels: `packages/shared/src/provider-failure.ts` gains `'amazon-bedrock'`.

Tests: add AWS env names to `SCRUBBED_ENV_VARS` in `packages/api/vitest.setup.ts`; extend `instance-config.test.ts`, `config-reconcile.test.ts`, `routes/llm-providers.test.ts`, `model-catalog.test.ts`, `model-tiers.test.ts`, `engine/host.model-resolution.test.ts`, and the web settings tests. A resolver test asserts the marker becomes `undefined` and that a stored org key is passed through.

Chart: `deploy/chart/valet/templates/serviceaccount.yaml`, `values.yaml`; chart version bump.

Spec: this file, plus a short cross-reference in `2026-07-16-llm-providers-design.md` under its non-goals list.

## Exit criteria

On agents-dev with the IRSA role applied and Flux values merged: the Models settings page shows an Amazon Bedrock card marked "using deployment AWS credentials" with no key stored. The picker lists `us.anthropic.*` models with prices and nothing else from Bedrock. A new session on `amazon-bedrock/us.anthropic.claude-sonnet-5-5` completes a turn; usage shows tokens and cost. `POST /api/org/llm-providers/:id/test` succeeds for the Bedrock row (known-kind cards have no Test button in the UI). Removing the IRSA annotation and restarting makes the card inactive and new sessions on it fail with the existing no-credentials error. Storing a Bedrock bearer token on the card makes it active again without the role. In local dev with no AWS environment, unit tests see Bedrock as inactive.

## Left to the builder

- Exact placement of the Anthropic-family filter (catalog service versus a registry overlay).
- IAM policy resource wording for inference profiles, verified against a real `InvokeModelWithResponseStream` call from the pod.
- Order of the two PRs (chart and Valet code can ship together; infra follows).

## Extension 2026-10-30: account-driven discovery and admin curation

### Why

Decision 4 hardcoded a `us.anthropic.*` filter. Two things changed on 2026-10-29: the agents-dev account turned out to gate Anthropic models behind a one-time use-case form, and the models we want first are open-weight ones (Qwen, DeepSeek, Mistral, Kimi, gpt-oss, Llama, GLM, MiniMax). A static filter cannot track what an account can invoke. Bedrock gets the OpenRouter pattern instead: discover what the account offers, let admins pick what the org sees.

### Decisions

9. **Discovery comes from the account, not a static list.** A new service calls `ListFoundationModels` (text output) and `ListInferenceProfiles` with the api's AWS credentials and derives the invokable id for each ACTIVE, streaming, text-in model: the bare `modelId` when `ON_DEMAND` is supported, otherwise the `SYSTEM_DEFINED` inference profile whose `models[]` names the model and whose prefix matches the pod's geography (`us.` for `us-*` regions). `global.*` profiles are never derived. A `GetUseCaseForModelAccess` call decides whether `anthropic.*` ids appear: a `ResourceNotFoundException` hides them until the form is on file. Results merge with pi-ai's `amazon-bedrock` registry for name, context window, and pricing; ids the registry lacks keep the Bedrock `modelName` and no pricing, so they are pickable and run through synthesis (decision 12). A successful lookup is cached in-process for one hour per region; concurrent misses share one lookup; the AWS client has a 3-second request timeout and 2 attempts. On any error the service degrades to a filtered registry list (bare ids and this geography's profiles, never `global.*`, never Anthropic) with `live: false`, holds that answer for two minutes, and logs one warning. A use-case answer other than success or `ResourceNotFoundException` also hides Anthropic for only two minutes and is logged.

10. **The catalog uses the curated branch.** `amazon-bedrock` leaves the full-registry known-kind path. With a row, the row's `models` selection is the catalog, registry-enriched; an empty selection means the default set, so rows created before Bedrock accepted a selection do not go blank. With no row and ambient credentials, the catalog is `BEDROCK_DEFAULT_MODEL_IDS` (a short open-weight default set) intersected with live discovery when discovery succeeded. With neither, nothing. `BEDROCK_CATALOG_FILTER` is removed.

11. **Admins curate on the Bedrock card.** `kindAcceptsModels` includes `amazon-bedrock`; create seeds the default set; `GET /api/org/llm-providers/amazon-bedrock/models` returns discovery for the picker. The web `OpenrouterModelsEditor` becomes a kind-parameterized `CuratedModelsEditor` with per-kind copy. "Customize models" creates the row from the zero-config state, as it does for OpenRouter.

12. **Selections the registry does not know still resolve.** `synthesizeCuratedModel` covers `amazon-bedrock` rows with `api: "bedrock-converse-stream"`, `provider: "amazon-bedrock"`, the stored name, context window (default 128k), pricing (default 0), and a baseUrl copied from any bundled Bedrock model (pi-ai ignores it when `AWS_REGION` is set).

13. **IAM widens for discovery and open models.** The IRSA policy adds `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles`, and `bedrock:GetUseCaseForModelAccess` on `*`, and invoke moves from `foundation-model/anthropic.*` to `foundation-model/*`. Inference-profile invoke is unchanged.

14. **New dependency.** `@aws-sdk/client-bedrock` pinned to `3.1127.0`, the same family as pi-ai's bundled runtime client, so smithy and credential packages dedupe.

### Out of scope

- A Bedrock twin of `openrouterRegistryIds` that widens workflow validation past the selection. Validation follows the catalog.
- Org bearer tokens for control-plane discovery. Discovery uses the AWS chain; a bearer-only org still gets the registry fallback and the admin picks from it.
- Refreshing discovery on demand from the UI. The one-hour cache is enough.

### Exit criteria

On agents-dev after the IAM change: the Bedrock card's "Add models" picker lists what the account can invoke, with no `anthropic.*` until the form is submitted and no `global.*`. Selecting `qwen.qwen3-coder-next` and starting a session on it completes a turn with cost. With discovery blocked (IAM denied), the picker falls back to the registry and shows the "couldn't reach" notice. Zero-config with no row lists the default set filtered to what discovery found.

## Extension 2026-10-30 (b): value-tier defaults and visible list prices

### Why

Discovery on agents-dev returned 67 invokable models. Comparing their US-profile list prices against Anthropic and OpenAI showed that the frontier-size open models split sharply: Kimi K3 ($3.30 in / $16.50 out per 1M tokens) costs about what Opus 5.5 does for a lower benchmark standing, while DeepSeek V3.2 ($0.62 / $1.85), Mistral Large 3 ($0.50 / $1.50) and GLM-5.3 ($1.85 / $5.81) sit at a similar standing for three to ten times less. The default set should steer towards that tier, and admins choosing models should see the price they are choosing.

### Decisions

15. **Defaults lead with the value tier.** `BEDROCK_DEFAULT_MODEL_IDS` adds `mistral.mistral-large-3-675b-instruct` and `us.zai.glm-5.3` and orders the list by tier: DeepSeek V3.2, Mistral Large 3 and GLM-5.3 first, then the cheaper coding and utility models already there. Nothing is removed; the picker lets admins prune.

16. **pi-ai moves to 1.4.0.** GLM-5.3 reached the `amazon-bedrock` registry after 1.0.3, and a default the registry lacks is silently dropped by `curatedBedrockModels()`. The bump is workspace-wide (api, engine, sandbox-docker). pi-ai 1.4.0 anchors function tools declared after the first system message as `additional_tools` input items for OpenAI Responses rather than in the top-level `tools` field; the engine's native-image bridge filters hidden tools at the transcript level, so behaviour is unchanged and only its tests' placement assertions move to the whole request body. The same registry retires `deepseek/deepseek-r1` from OpenRouter; the OpenRouter default set replaces it with `deepseek/deepseek-v4-flash`, the current low-cost DeepSeek entry.

17. **The picker shows list price.** `CuratedModelsEditor` renders `pricing` from the catalog as "$0.62 in / $1.85 out per 1M tokens" on each picker row and as "$0.62 / $1.85" on each selected chip (long form in the chip's tooltip). Prices come from the same `LlmProviderModel.pricing` the catalog already carries (pi-ai registry for Bedrock, the live catalog for OpenRouter); a model with no known price shows none rather than $0. Sub-cent rates keep a third decimal. This applies to both curated kinds.

### Exit criteria

A fresh Bedrock row seeds ten models with DeepSeek V3.2, Mistral Large 3 and GLM-5.3 first, each with a price. The picker and the chips on agents-dev show per-million prices for registry-known models and none for the account's unregistered ones. The engine, api and web suites pass on pi-ai 1.4.0.
