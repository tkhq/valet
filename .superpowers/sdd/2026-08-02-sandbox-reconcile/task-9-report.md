# Task 9 Report: Creds mount — live-updatable per-sandbox Secret

## What was done

### Commits

1. `af466613` — `fix: name-keyed container lookup in livePodImageDiffers`
2. `e9cd44ff` — `feat: k8s creds mount — live-updatable per-sandbox Secret`

### Engine contracts (packages/engine/src/types.ts)

Added three new fields:

- `SandboxCreateOpts.credsFiles?: Record<string, string>` — initial credential files for the mount.
- `SandboxCapabilities.credsMount?: boolean` — capability flag indicating live-mount support.
- `SandboxProvider.updateCreds?(id: string, files: Record<string, string>): Promise<void>` — refreshes credential files into a running sandbox.

### k8s sandbox provider

**packages/sandbox-kubernetes/src/types.ts**
- Added `SecretVolumeSource` interface (`secretName`, `optional?`).
- Added `Volume` interface (`name`, `secret?`).
- Added `volumes?: Volume[]` to `SandboxPodSpec`.

**packages/sandbox-kubernetes/src/manifest.ts**
- Added exported constants `CREDS_MOUNT_PATH` (`/etc/valet/creds`) and `CREDS_VOLUME_NAME` (`valet-creds`).
- Added exported helper `credsSecretName(sandboxName)` — returns `valet-creds-<sandboxName>`.
- `buildSandboxManifest` now adds the whole-directory Secret volume and container mount when `opts.credsFiles` is non-empty. Uses no `subPath` — whole-directory mount is required for kubelet live-reload.

**packages/sandbox-kubernetes/src/provider.ts**
- Added `SandboxSecretsApi` interface (`upsertSecret`, `patchSecret`, `deleteSecret`).
- Added `sandboxSecretsApiAdapter(api: k8s.CoreV1Api): SandboxSecretsApi` production adapter. Encodes values as base64 for the Kubernetes Secret `.data` field. `upsertSecret` tries create first; on 409 it GETs + replaces. `deleteSecret` swallows 404.
- Added `secretsApi?: SandboxSecretsApi` to `KubernetesSandboxProviderDeps`.
- `create()`: upserts the creds Secret BEFORE `applySandbox` so the pod finds the Secret at scheduling time.
- `destroy()`: deletes the creds Secret best-effort (swallows all errors) before deleting the CR.
- Added `updateCreds(id, files)` method — calls `secretsApi.patchSecret`.
- `capabilities()`: added `credsMount: true`.

**packages/sandbox-kubernetes/src/lifecycle.ts** (lifecycle fix)
- Imported `SANDBOX_CONTAINER_NAME` from `./manifest.js`.
- `livePodImageDiffers`: changed `containerStatuses?.[0]?.image` (positional — wrong under sidecar injection) to `containerStatuses?.find((cs) => cs.name === SANDBOX_CONTAINER_NAME)?.image` (name-keyed — correct regardless of ordering).

**packages/sandbox-kubernetes/src/index.ts**
- Exported `CREDS_MOUNT_PATH`, `CREDS_VOLUME_NAME`, `credsSecretName`, `SandboxSecretsApi`, `sandboxSecretsApiAdapter`, `SecretVolumeSource`, `Volume`.

### RBAC (deploy/chart/valet/templates/rbac.yaml)

Updated the secrets rule in the sandbox namespace Role to add `get`, `patch`, `update` verbs. These are required for the upsert (get + replace) and live-refresh (patch) operations. The prior rule had only `create` and `delete`.

### Tests

**test/manifest.test.ts** — Added `describe("credsFiles")` with 4 tests:
1. Volume + mount added when `credsFiles` is non-empty.
2. Neither volume nor mount added when `credsFiles` is absent.
3. Neither added when `credsFiles` is an empty object.
4. Deep-equality regression pin — manifest is byte-identical to no-`credsFiles` when `credsFiles` is absent.

**test/lifecycle.test.ts** — Added sidecar-ordering test to `livePodImageDiffers`: a sidecar at index 0 does not confuse the name-keyed lookup; the sandbox container at index 1 is found correctly.

**test/provider.test.ts** — Added `KubernetesSandboxProvider creds Secret lifecycle` describe block with 6 tests:
1. `create()` with `credsFiles` calls `upsertSecret` before `createNamespacedCustomObject` (order-sensitive assertion).
2. `create()` without `credsFiles` does not call `upsertSecret`.
3. `updateCreds()` calls `patchSecret`.
4. `updateCreds()` throws when `secretsApi` is not wired.
5. `destroy()` calls `deleteSecret`.
6. `destroy()` tolerates `deleteSecret` failures (best-effort).

**test/conformance.cluster.test.ts** — Added `secretsApi` wiring to the provider. Added cluster-gated test: creates a sandbox with `credsFiles: { token: "aaa" }`, reads `/etc/valet/creds/token`, calls `updateCreds` with `{ token: "bbb" }`, polls until the file reflects `"bbb"` (timeout 120 s, 2 s interval). Cleans up with `provider.destroy`.

## Validation results

- `pnpm typecheck` — clean (zero errors)
- `pnpm --filter @valet/sandbox-kubernetes test` — 187 passed, 56 skipped (all skipped are cluster-gated tests that require Rancher Desktop — expected on this machine)

## Design decisions

**No subPath, no envFrom-secret.** Both break kubelet live-reload. The volume is a whole-directory Secret mount. The comment in `buildSandboxManifest` explains this explicitly.

**Secret upserted BEFORE `applySandbox`.** The pod template references the Secret volume at scheduling time. If the Secret does not exist yet, the pod hangs in `Pending` (even with `optional: true`, this is safer). The upsert therefore precedes the CR apply.

**`optional: true` on the Secret volume source.** A missing Secret does not block pod scheduling. This is a safety net for edge cases (e.g. rapid pod restart before the Secret is created in a race), not the primary ordering guarantee.

**base64 encoding in `sandboxSecretsApiAdapter`.** Kubernetes Secret `.data` values must be base64-encoded. The adapter encodes values at the boundary; callers pass plain strings.

---

## Review fix report (2026-08-02)

Fixed four findings from the code review of commit `e9cd44ff`.

### Finding 1 — updateCreds 404s on a missing Secret (Important)

**Root cause.** `patchSecret` called `replaceNamespacedSecret` (PUT) unconditionally. A missing Secret (sandbox created before this feature, or manually deleted) makes the call throw 404.

**Fix.** Renamed `patchSecret` → `writeSecret` throughout the interface and adapter. The new `writeSecret` GETs the existing Secret first (for `resourceVersion`), replaces it; on 404 falls back to create. `updateCreds()` now calls `writeSecret`. The name is honest: it writes (creates or replaces), never patches in-place.

### Finding 2 — capabilities().credsMount unconditionally true (Minor)

**Fix.** Changed `credsMount: true` to `credsMount: Boolean(this.deps.secretsApi)`. A provider wired without `secretsApi` now advertises `credsMount: false`, matching its actual inability to call `updateCreds`.

### Finding 3 — upsertSecret 409 replace omits resourceVersion (Minor)

**Fix.** In `sandboxSecretsApiAdapter.upsertSecret`, the 409 branch now GETs the existing Secret via `readNamespacedSecret` to obtain `metadata.resourceVersion` before issuing the replace PUT. The RBAC already grants `get`.

### Finding 4 — id comment on updateCreds/destroy (Minor)

**Fix.** Added a note to both `destroy()` and `updateCreds()` docblocks: `id` must be the Sandbox CR name (`sandbox.id`), never the raw workspace key.

### Tests updated

- `FakeSecretsApi.patchSecret` → `FakeSecretsApi.writeSecret` (records `method: "write"`).
- `updateCreds() patches the creds Secret` renamed and assertion updated to `method: "write"`.
- Added `updateCreds() creates the Secret when writeSecret reports 404` — verifies 404-fallback path does not throw.
- Added `capabilities().credsMount is true when secretsApi is wired`.
- Added `capabilities().credsMount is false when secretsApi is absent`.
- Fixed inline `SandboxSecretsApi` in `destroy() swallows` test: `patchSecret` → `writeSecret`.

### Validation

- `pnpm typecheck` — clean (zero errors)
- `pnpm --filter @valet/sandbox-kubernetes test` — 190 passed, 56 skipped (cluster-gated, expected)

### Cluster re-run needed?

No for unit validation. Yes for full end-to-end confidence: the `conformance.cluster.test.ts` test exercises `updateCreds` against a real apiserver; run it against Rancher Desktop to confirm the 404-fallback path when the rotate sweep (Task 12) hits pre-feature sandboxes.
