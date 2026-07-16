# agent-sandbox v0.5.1 (vendored)

## Provenance

- Source: https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v0.5.1
- Tag: `v0.5.1`
- Asset: `manifest.yaml`
  (`https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.1/manifest.yaml`)
- Release published: 2026-07-09
- Vendored: 2026-07-15, via `gh release download v0.5.1 -R kubernetes-sigs/agent-sandbox --pattern "manifest.yaml"`
- sha256 (see `SHA256SUMS`): `8cfdf0a878f66b91d2e7103e77859d1412d850ce3f5fe5c3fa134c36bd55504a` — verified to match the GitHub release asset's own digest exactly.

The release also publishes `extensions.yaml` (adds `SandboxClaim`,
`SandboxTemplate`, `SandboxWarmPool` CRDs). It was **not** vendored: the base
`manifest.yaml` already contains the complete `Sandbox` CRD (including its
admission/conversion webhook wiring), and Valet's provider only drives the
base `Sandbox` CRD today. See `../README.md` for the full rationale and the
top-level provenance/smoke-test record.

## Contents

- `manifest.yaml` — vendored verbatim, byte-for-byte, from the release asset above. Do not hand-edit; re-download to update.
- `SHA256SUMS` — sha256 of `manifest.yaml`, generated with `shasum -a 256 manifest.yaml > SHA256SUMS`.

## Update procedure (version bump)

There is no Helm chart to `helm upgrade` — this is a raw manifest applied
with `kubectl apply`. Helm's `crds/` directory semantics (install once,
never upgrade) don't apply here since we don't use Helm for this piece at
all; each version bump is an explicit, reviewed step:

1. Pick the new tag, e.g. `v0.6.0`.
2. Create `deploy/agent-sandbox/v0.6.0/` (new directory — never edit an
   already-vendored version's `manifest.yaml` in place; each pinned version
   directory is immutable once committed).
3. `gh release download v0.6.0 -R kubernetes-sigs/agent-sandbox --pattern "manifest.yaml"` into that directory.
4. `shasum -a 256 manifest.yaml > SHA256SUMS` in the new directory.
5. Write a `README.md` in the new directory following this file's shape (provenance + this update-procedure section, kept in sync).
6. **Diff the CRD schema/versions against the previous vendored copy.** If
   the CRD's `storage: true` version changes (e.g. `v1beta1` -> a future
   `v1beta2`), a plain `kubectl apply` of the new CRD can leave existing
   `Sandbox` objects stored in etcd under the old storage version
   effectively stranded from clients expecting the new one — follow
   upstream's documented CRD/storage-version migration tooling instead of
   just re-applying.
7. Bump `AGENT_SANDBOX_VERSION` in the root `Makefile` (or override via
   `make k8s-sandbox-install AGENT_SANDBOX_VERSION=v0.6.0` for a one-off
   test) to point at the new directory.
8. Re-run `make k8s-sandbox-install` against Rancher Desktop and repeat the
   smoke test documented in `../README.md`; update that file's "Smoke test
   observations" section if the new version's behavior differs (pod naming,
   annotations, condition reasons, etc. — Task 2's status-mapping code
   depends on these staying accurate).
9. Delete old, unreferenced version directories once nothing points at them
   (git history retains provenance).
