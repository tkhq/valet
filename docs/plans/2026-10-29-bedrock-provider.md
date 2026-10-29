# Amazon Bedrock Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `amazon-bedrock` a known LLM provider kind in Valet that authenticates through the AWS credential chain or an org bearer token, lists Anthropic models on Bedrock with registry pricing, and deploys to agents-dev with an IRSA role.

**Architecture:** Bedrock joins the known-kind sets that already drive anthropic/openai/google/openrouter. The kind string equals pi-ai's provider id, so registry, env, and engine lookups need no mapping. The only new logic is in the resolver: pi-ai signals ambient AWS credentials with the marker string `"<authenticated>"`, which must become `apiKey: undefined` so the SDK default chain runs. Infra adds an IRSA role and Flux values in tkhq/test-agents-infra.

**Tech Stack:** TypeScript, pnpm workspace, vitest, Hono, Drizzle, React; `@earendil-works/pi-ai@1.0.3` (`amazon-bedrock` provider, bundled `@aws-sdk/client-bedrock-runtime`); Helm chart `deploy/chart/valet`; OpenTofu with `terraform-aws-modules/iam//modules/iam-role-for-service-accounts-eks`; Flux.

**Spec:** `docs/specs/2026-10-29-bedrock-provider-design.md`

## Global Constraints

- Kind string is exactly `amazon-bedrock`. Model ids are `amazon-bedrock/<bedrock-model-id>`.
- No new npm dependency. No SQL migration (`llm_providers.kind` is plain text).
- Resolver never sends the string `"<authenticated>"` as an API key.
- Catalog for this kind lists only ids matching `^us\.anthropic\.`.
- UI label "Amazon Bedrock". Badge copy when running on ambient AWS credentials: "using deployment AWS credentials".
- Commit subjects ≤72 chars, no AI co-author trailers, each commit body has a `Changelog:` line (CI guard). PR descriptions ≤300 words (`scripts/docs/pr_description_lint.py`).
- Repo rule: spec updates ship in the same commit as the subsystem change.
- Tests run with `pnpm --filter @valet/api test <filter>` (no `--` before the filter). Build workspace dist first with `pnpm typecheck` on a fresh worktree.

## Review Focus

1. A developer with `AWS_PROFILE` set runs unit tests: Bedrock must look inactive. Pinned by Task 1 (env scrub).
2. An org stores a Bedrock bearer token AND the pod has IRSA: the org token must win. Pinned by Task 2.
3. A blank stored key with ambient AWS credentials: must fall through to the chain, not throw. Pinned by Task 2.
4. A Bedrock row exists but is disabled while ambient credentials exist: picker must hide its models. Pinned by Task 3.
5. A persisted session names a bare `amazon-bedrock/anthropic.claude-sonnet-5-5` (no `us.` prefix): Bedrock rejects it as inference-profile-only. The catalog never offers it (Task 3 filter), and the resolver still resolves it so the turn fails with Bedrock's own message rather than a Valet one. Pinned by Task 3 (filter test asserts no bare ids).

---

### Task 1: Register the kind everywhere it is enumerated

**Files:**
- Modify: `packages/api/src/config/instance-config.ts:107,155-160,510`
- Modify: `packages/api/src/schema/index.ts:1765-1767`
- Modify: `packages/api/src/wire/types.ts:4928`
- Modify: `packages/api/src/services/llm-providers.ts:23-29`
- Modify: `packages/api/vitest.setup.ts:19-25`
- Modify: `packages/shared/src/provider-failure.ts:56`
- Test: `packages/api/src/config/instance-config.test.ts`, `packages/api/src/services/llm-providers.test.ts` (create if absent)

**Interfaces:**
- Produces: `LlmProviderKind` and `LlmProviderKindWire` include `"amazon-bedrock"`; `isLlmProviderKind("amazon-bedrock") === true`; `isKnownProviderKind("amazon-bedrock") === true`; `providerNamespace(row)` returns `"amazon-bedrock"` for such a row; `providerLabel("amazon-bedrock") === "Amazon Bedrock"`.

- [ ] **Step 1: Write the failing tests**

In `instance-config.test.ts`, next to the existing openrouter kind test:

```ts
it("accepts llmProviders kind amazon-bedrock", () => {
  const cfg = parseInstanceConfig({ llmProviders: [{ kind: "amazon-bedrock", enabled: true }] }, "test");
  expect(cfg.llmProviders?.[0]?.kind).toBe("amazon-bedrock");
});
it("lists amazon-bedrock in the allowed-kinds error", () => {
  expect(() => parseInstanceConfig({ llmProviders: [{ kind: "nope" }] }, "test")).toThrow(/amazon-bedrock/);
});
```

In the services test:

```ts
it("treats amazon-bedrock as a known kind with the kind as its namespace", () => {
  expect(isLlmProviderKind("amazon-bedrock")).toBe(true);
  expect(isKnownProviderKind("amazon-bedrock")).toBe(true);
  expect(providerNamespace({ kind: "amazon-bedrock", id: "prov_x" } as LlmProviderRow)).toBe("amazon-bedrock");
});
```

In `packages/shared` tests for provider-failure (create `provider-failure.test.ts` if absent):

```ts
expect(providerLabel("amazon-bedrock")).toBe("Amazon Bedrock");
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test instance-config llm-providers` and `pnpm --filter @valet/shared test provider-failure`
Expected: FAIL on type error or `expected true, got false`.

- [ ] **Step 3: Add `"amazon-bedrock"` to every list**

Type union and `LLM_PROVIDER_KINDS` Set and the allowed-values error string in `instance-config.ts`; Drizzle `enum` in `schema/index.ts`; `LlmProviderKindWire`; `KNOWN_KINDS` and `isLlmProviderKind` in `services/llm-providers.ts`; `'amazon-bedrock': 'Amazon Bedrock'` in `provider-failure.ts` (keep the existing `bedrock` key). Add to `SCRUBBED_ENV_VARS`: `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`.

- [ ] **Step 4: Run tests and typecheck**

Run: the two test commands above, then `pnpm typecheck`
Expected: PASS. Typecheck will surface any exhaustive switch over the kind union; fix each by adding the new case (no behavior yet).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): register amazon-bedrock as an llm provider kind" -m "Changelog: Amazon Bedrock is accepted as a provider kind in instance config and the providers API."
```

---

### Task 2: Resolve Bedrock models through the AWS credential chain

**Files:**
- Modify: `packages/api/src/services/model-registry.ts:69` (`REGISTRY_PROVIDERS`)
- Modify: `packages/api/src/services/model-resolution.ts:67-71,241-290`
- Test: `packages/api/src/engine/host.model-resolution.test.ts`

**Interfaces:**
- Consumes: Task 1 kind lists.
- Produces: `resolveModelSpec` returns `{ model, apiKey: undefined, canonicalId }` for `amazon-bedrock/<id>` when ambient AWS credentials exist and no org key is stored; returns `apiKey: <token>` when an org key is stored; throws `NoCredentialsError` when neither exists. New exported helper in `model-resolution.ts`:
  `export function envCredentialFor(kind: KnownKind): { present: boolean; apiKey: string | undefined }` — wraps `getEnvApiKey`, mapping the marker `"<authenticated>"` to `{ present: true, apiKey: undefined }`.

- [ ] **Step 1: Write the failing tests**

Follow the existing test fixture style in `host.model-resolution.test.ts` (it stubs `getEnvApiKey` via env vars; use `AWS_BEARER_TOKEN_BEDROCK` or `AWS_PROFILE` to make pi-ai return the marker).

```ts
describe("amazon-bedrock resolution", () => {
  const spec = "amazon-bedrock/us.anthropic.claude-sonnet-5-5";
  it("uses the AWS default chain when only ambient credentials exist", async () => {
    process.env.AWS_PROFILE = "dev";
    const r = await resolveModelSpec(deps, orgId, spec);
    expect(r?.model.provider).toBe("amazon-bedrock");
    expect(r?.apiKey).toBeUndefined();
  });
  it("passes a stored org bearer token as apiKey ahead of ambient credentials", async () => {
    process.env.AWS_PROFILE = "dev";
    await storeOrgKey(rowId, "bedrock-token-123");
    const r = await resolveModelSpec(deps, orgId, spec);
    expect(r?.apiKey).toBe("bedrock-token-123");
  });
  it("treats a blank stored key as absent and falls through to the chain", async () => {
    process.env.AWS_PROFILE = "dev";
    await storeOrgKey(rowId, "   ");
    const r = await resolveModelSpec(deps, orgId, spec);
    expect(r?.apiKey).toBeUndefined();
  });
  it("throws NoCredentialsError with no org key and no AWS environment", async () => {
    await expect(resolveModelSpec(deps, orgId, spec)).rejects.toBeInstanceOf(NoCredentialsError);
  });
  it("does not count AWS_REGION alone as a credential", async () => {
    process.env.AWS_REGION = "us-east-1";
    await expect(resolveModelSpec(deps, orgId, spec)).rejects.toBeInstanceOf(NoCredentialsError);
  });
  it("never emits the <authenticated> marker as an apiKey", async () => {
    process.env.AWS_PROFILE = "dev";
    const r = await resolveModelSpec(deps, orgId, spec);
    expect(r?.apiKey).not.toBe("<authenticated>");
  });
});
```

Cover both branches: with a provider row (enabled) and with no row (zero-config).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test host.model-resolution`
Expected: FAIL. With no row, `isKnownKindNamespace` is false so it throws `ModelUnavailableError`; with a row, `apiKey` equals the marker.

- [ ] **Step 3: Implement**

Add `"amazon-bedrock"` to `REGISTRY_PROVIDERS`, `KnownKind`, and `isKnownKindNamespace`. Add `envCredentialFor(kind)`. In both the row branch and the no-row branch replace `?? getEnvApiKey(kind)` / `=== undefined` with: `const org = await orgKey(...)` (row branch only); `const env = envCredentialFor(kind)`; if `org === undefined && !env.present` throw `NoCredentialsError`; else return `apiKey: org ?? env.apiKey`. The other known kinds are unchanged because for them `envCredentialFor` returns `{ present: Boolean(key), apiKey: key }`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @valet/api test host.model-resolution model-registry` then `pnpm typecheck`
Expected: PASS, all existing resolution tests still green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): resolve amazon-bedrock models via the AWS credential chain" -m "Changelog: Bedrock models resolve with the pod's AWS role or an org bearer token."
```

---

### Task 3: Catalog, tiers, and activation

**Files:**
- Modify: `packages/api/src/services/model-catalog.ts:72-80,91-118,144-160`
- Modify: `packages/api/src/services/model-tiers.ts:100`
- Modify: `packages/api/src/engine/host.ts:3910`
- Modify: `packages/api/src/routes/llm-providers.ts` (`toSummary` `envFallback` at ~122)
- Test: `packages/api/src/services/model-catalog.test.ts`, `packages/api/src/services/model-tiers.test.ts`, `packages/api/src/routes/llm-providers.test.ts`

**Interfaces:**
- Consumes: Task 2 `envCredentialFor`.
- Produces: `buildOrgCatalog` includes entries with `providerKind: "amazon-bedrock"`, ids `amazon-bedrock/<id>`, only Anthropic-family ids, `pricing` from registry cost. `GET /api/org/llm-providers` summary for a Bedrock row has `envFallback: true` when ambient credentials exist. New constant in `model-catalog.ts`: `export const BEDROCK_CATALOG_FILTER = /^us\.anthropic\./;`

- [ ] **Step 1: Write the failing tests**

```ts
it("lists only Anthropic-family Bedrock models with registry pricing when ambient AWS credentials exist", async () => {
  process.env.AWS_PROFILE = "dev";
  const entries = (await buildOrgCatalog(db, credentials, orgId)).filter((e) => e.providerKind === "amazon-bedrock");
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) {
    expect(e.id.startsWith("amazon-bedrock/")).toBe(true);
    expect(e.id.slice("amazon-bedrock/".length)).toMatch(BEDROCK_CATALOG_FILTER);
    expect(e.pricing?.input).toBeGreaterThan(0);
  }
  expect(entries.some((e) => e.id.includes("meta.llama"))).toBe(false);
  expect(entries.some((e) => e.id.startsWith("amazon-bedrock/anthropic."))).toBe(false);
  expect(entries.some((e) => e.id.startsWith("amazon-bedrock/global."))).toBe(false);
});
it("hides Bedrock models when the row is disabled even with ambient credentials", async () => { /* row.enabled=false → every entry active=false */ });
it("lists no Bedrock models with no row and no AWS environment", async () => { /* zero entries */ });
```

`model-tiers.test.ts`: a tier spec `amazon-bedrock/...` with no row and `AWS_PROFILE` set counts as active; without AWS env it does not.
`llm-providers.test.ts`: summary `envFallback` is true for a Bedrock row with `AWS_PROFILE` set and false without.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @valet/api test model-catalog model-tiers routes/llm-providers`
Expected: FAIL, no Bedrock entries / `envFallback` false.

- [ ] **Step 3: Implement**

`model-catalog.ts`: add `"amazon-bedrock"` to `KnownCatalogKind`, `KNOWN_KINDS`, `KNOWN_KIND_LABEL` ("Amazon Bedrock"). In `knownKindEntries`, filter `registryModels(kind)` by `BEDROCK_CATALOG_FILTER` when `kind === "amazon-bedrock"`. Replace the two `getEnvApiKey(kind)` truthiness checks in `buildOrgCatalog` with `envCredentialFor(kind).present`. `model-tiers.ts`: add to `ENV_FALLBACK_KINDS`. `host.ts:3910`: add `|| namespace === "amazon-bedrock"`. `routes/llm-providers.ts` `toSummary`: compute `envFallback` from `envCredentialFor(row.kind).present` for known kinds.

- [ ] **Step 4: Run tests and typecheck**

Run: the test command above, then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): list Anthropic-on-Bedrock models in the org catalog" -m "Changelog: The model picker offers Anthropic models on Amazon Bedrock when the deployment has AWS credentials."
```

---

### Task 4: Settings UI card

**Files:**
- Modify: `packages/web/src/components/settings/llm-providers-section.tsx:31-40,142-143`
- Test: `packages/web/src/routes/-settings.organization.models.test.tsx`

**Interfaces:**
- Consumes: Task 1 `LlmProviderKindWire`, Task 3 `envFallback`.
- Produces: a known-provider card for `amazon-bedrock` labelled "Amazon Bedrock"; key field placeholder "Bedrock API key (bearer token)"; deployment badge text "using deployment AWS credentials" for this kind only.

- [ ] **Step 1: Write the failing test**

```tsx
it("renders an Amazon Bedrock card with AWS credential copy", async () => {
  mockProviders([{ id: "prov_b", kind: "amazon-bedrock", name: "Amazon Bedrock", enabled: true, hasKey: false, envFallback: true, models: [] }]);
  render(<ModelsSettingsRoute />);
  expect(await screen.findByText("Amazon Bedrock")).toBeInTheDocument();
  expect(screen.getByText("using deployment AWS credentials")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Bedrock API key (bearer token)")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @valet/web test settings.organization.models`
Expected: FAIL, "Amazon Bedrock" not found.

- [ ] **Step 3: Implement**

Add the kind to `KnownKind`, `KNOWN_KINDS`, `KNOWN_LABEL`. Make the placeholder and badge copy per kind: a small `KIND_COPY: Record<KnownKind, { placeholder: string; deploymentBadge: string }>` with existing values for the other kinds (`"sk-…"`, `"using deployment key"`).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/web test settings.organization.models llm-providers` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): Amazon Bedrock provider card in Models settings" -m "Changelog: Organization → Models shows an Amazon Bedrock card."
```

---

### Task 5: Chart: service-account annotations

**Files:**
- Modify: `deploy/chart/valet/templates/serviceaccount.yaml`
- Modify: `deploy/chart/valet/values.yaml:135-140`
- Modify: `deploy/chart/valet/Chart.yaml` (version `0.10.25` → `0.10.26`)
- Modify: `docs/specs/2026-07-16-llm-providers-design.md` (non-goals line about Bedrock → cross-reference the new spec), `docs/specs/2026-10-29-bedrock-provider-design.md` status → Implemented

**Interfaces:**
- Produces: value `serviceAccount.annotations: {}` rendered under `metadata.annotations` when non-empty. (`AWS_REGION` needs no chart support: the EKS pod identity webhook injects it with the IRSA token.)

- [ ] **Step 1: Write the failing check**

Shell check (no helm unit framework in the repo):

```bash
helm template t deploy/chart/valet --set 'serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/x' \
 | grep -c 'eks.amazonaws.com/role-arn: arn:aws:iam::1:role/x'   # expect 1
helm template t deploy/chart/valet | grep -A3 'kind: ServiceAccount' | grep -c 'annotations:'   # expect 0
```

- [ ] **Step 2: Run to verify it fails**

Expected: first count 0 (annotation not rendered).

- [ ] **Step 3: Implement**

`serviceaccount.yaml`: `{{- with .Values.serviceAccount.annotations }} annotations: {{ toYaml . | nindent 4 }} {{- end }}`. Document in `values.yaml` with the IRSA example. Bump Chart.yaml. Run `helm lint deploy/chart/valet`.

- [ ] **Step 4: Verify**

Run the Step 1 commands and `helm lint`. Expected: counts 1 and 0, lint clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(chart): serviceAccount.annotations for IRSA" -m "Changelog: The Helm chart can annotate the api ServiceAccount, for example with an IRSA role."
```

---

### Task 6: Valet PR

- [ ] Run `pnpm typecheck` and `pnpm --filter @valet/api test` and `pnpm --filter @valet/web test`; record pass/fail counts and name any pre-existing failures (known: `skill-files`, `skill-collector`, `integration/orchestrator-*` need Docker or fail on dev-v2).
- [ ] Open PR against `dev-v2` with a ≤300-word body passing `python3 scripts/docs/pr_description_lint.py`. Title: `feat(api,web,chart): Amazon Bedrock provider kind`. Body sections: Problem, Fix, Owner decision (Anthropic-only catalog; kind named after the pi-ai id), Validation, Deploy order (merge → promote → infra PR).
- [ ] After merge and promotion, confirm the published chart `0.10.26` exists at `oci://ghcr.io/tkhq/charts` before the infra PR, because `validate-flux-render.sh` templates the published chart.

---

### Task 7: Infra: IRSA role and Flux values (tkhq/test-agents-infra)

**Files:**
- Create: `modules/infra/bedrock.tf`
- Modify: `modules/infra/outputs.tf`
- Modify: `flux/agents-dev/valet-release.yaml:16` (chart version → `0.10.26`)
- Modify: `flux/agents-dev/values.yaml` (`serviceAccount.annotations` only; no instanceConfig entry, see spec decision 5)
- Modify: `scripts/validate-flux-render.sh:42` (chart guard → `0.10.26`; add an assertion that the rendered ServiceAccount carries the role-arn annotation)
- Modify: `docs/runbooks/agents-dev-flux-operations.md` (one paragraph: Bedrock role, how to verify)

**Interfaces:**
- Produces: IAM role `agents-dev-valet-bedrock`, ARN `arn:aws:iam::633442603550:role/agents-dev-valet-bedrock`, trusted by `valet:valet-api`.

- [ ] **Step 1: Write `modules/infra/bedrock.tf`**

Copy the `external_secrets_irsa` module block from `modules/infra/secrets.tf:179-195`: `role_name = "${var.cluster_name}-valet-bedrock"`, `namespace_service_accounts = ["valet:valet-api"]`, `role_policy_arns = { invoke = aws_iam_policy.valet_bedrock_invoke.arn }`. Policy document: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/anthropic.*` and `arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*`. Output `valet_bedrock_irsa_arn`.

- [ ] **Step 2: Plan**

Run: `tofu -chdir=environments/dev/infra plan` (AWS creds only, no tunnel).
Expected: 3 to add (role, policy, attachment), 0 change, 0 destroy.

- [ ] **Step 3: Flux values**

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::633442603550:role/agents-dev-valet-bedrock
```
Bump the chart version in `valet-release.yaml` and the guard in `validate-flux-render.sh`; add the annotation assertion. Do not add an `llmProviders` entry to `instanceConfig`: the zero-config path activates the kind from the IRSA marker, and an entry would fail boot on any pre-change image.

- [ ] **Step 4: Validate**

Run: `make validate-flux`
Expected: passes against published chart `0.10.26` (Task 6 gate).

- [ ] **Step 5: Commit and PR**

Two commits: `infra(agents-dev): IRSA role for valet Bedrock invoke` and `flux(agents-dev): chart 0.10.26 with the Bedrock IRSA annotation`. PR body ≤300 words with the order: Valet image promoted and chart `0.10.26` published first (Task 6 gate); human applies infra (`tofu apply` in `environments/dev/infra`); then merges this PR by hand (promote-dev never auto-merges chart bumps); Flux rolls the api.

- [ ] **Step 6: Verify on agents-dev (after apply + merge)**

Through the SSM tunnel: `kubectl -n valet get sa valet-api -o jsonpath='{.metadata.annotations}'` shows the role ARN; the api pod env has `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_REGION` (both injected by the pod identity webhook); Settings → Models shows "Amazon Bedrock" with "using deployment AWS credentials"; `POST /api/org/llm-providers/:id/test` for the Bedrock row returns success; a session on `amazon-bedrock/us.anthropic.claude-sonnet-5-5` completes a turn and usage shows cost. Record results in the PR.
