# Amazon Bedrock Provider Design — a known provider kind on the AWS credential chain

**Date:** 2026-10-29
**Status:** Implemented (Valet side); infra rollout tracked in tkhq/test-agents-infra
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
