# Kubernetes Deployment Design — local k3s reference environment (sub-project B)

**Date:** 2026-07-15
**Status:** Implemented (2026-07-15) — dogfooded end-to-end on Rancher Desktop k3s; see the "Dogfood evidence" note below and `.superpowers/sdd/task-9-report.md`.
**Scope:** Everything needed to run Valet v2 on Kubernetes: a `sandbox-kubernetes` provider (session sandboxes as pods), api+web+sandbox container images, a Helm chart (api, bundled Postgres, RBAC, ingress), and the fully local reference environment on Rancher Desktop's k3s that we iterate toward production with. Cloudflare adapters are a separate future direction.

## Decisions (locked)

1. **Reference environment: Rancher Desktop k3s.** The user already runs Rancher Desktop; enabling Kubernetes gives k3s with Traefik ingress and the `local-path` storage provisioner. Docs and Make targets pin this environment; the chart and provider stay generic Kubernetes (nothing k3s-specific in code).
2. **Images: local builds only.** Multi-stage Dockerfiles built with plain `docker build` — the reference environment runs Rancher Desktop in **moby mode** (verified on the actual machine), where k3s uses cri-dockerd and docker-built images are directly visible to pods; this also preserves the Docker socket that sandbox-docker and `make test-pg` depend on, so we do NOT switch to containerd mode. (containerd-mode users would use `nerdctl --namespace k8s.io build`; documented as a variant, not the default.) No registry. CI publishing (ghcr) is a follow-up when a remote cluster exists.
   **Context-safety rule (binding, verified hazard):** the developer machine's default kubectl context may point at a PRODUCTION cluster (it did — a GKE prod cluster). Every cluster-touching test, script, and make target pins `--context rancher-desktop` (or the client-node equivalent `setCurrentContext`) explicitly. Nothing ever operates on the ambient current-context. CI publishing (ghcr) is a follow-up when a remote cluster exists. Images: `valet-api` (Node 22 + built monorepo + web static assets) and `valet-sandbox` (the session sandbox image; default remains the docker provider's `node:20-bookworm`-equivalent, overridable per-deployment via values and per-session via `SandboxCreateOpts.image`).
3. **The api serves the web app.** `packages/web`'s `vite build` output is baked into the api image and served by Hono (`serveStatic`, registered LAST) with an SPA fallback to `index.html` whose predicate **excludes `/api`, `/mcp`, and `/.well-known`** — the MCP endpoint and OAuth discovery routes from the auth pass are non-`/api` paths a naive fallback would shadow with HTML (adversarial-review catch). Unknown `/api/*` still 404s as JSON. One pod, one Service, one ingress host — no separate web deployment. Dev (`make dev-local`) is unchanged (Vite dev server + proxy).
4. **Database: bundled Postgres StatefulSet with external override.** The chart ships a single-replica StatefulSet on the official `postgres:17` image (no Bitnami — their free catalog was discontinued in 2025), PVC via the cluster's default storage class, credentials in a Secret. `externalDatabase.url` in values disables the bundled instance and points the api at managed PG (the prod path). The api consumes plain `DATABASE_URL` either way (sub-project A's boot contract).
5. **`packages/sandbox-kubernetes`: provider built on SIG agent-sandbox (scoped adoption).**
   - Implements the engine's `SandboxProvider`/`Sandbox` contract (`create`/`restore`/`destroy`/`status`; file ops, `exec`, and job-mode `execJob`/`pollJob`/`cancelJob`) via `@kubernetes/client-node` — the K8s API only, no kubectl shelling.
   - **Lifecycle rides the [kubernetes-sigs/agent-sandbox](https://agent-sandbox.sigs.k8s.io/) `Sandbox` CRD, API group `agents.x-k8s.io/v1beta1`** (v0.5.x controller; the group serves both v1alpha1 and v1beta1 — we pin v1beta1 in one constant). One `Sandbox` custom resource per session in the sandbox namespace, labeled `valet.dev/session-id`. **The CRD has no first-class image/env/resources fields** — its spec is `podTemplate` (a full `corev1.PodSpec`) + `volumeClaimTemplates` + lifecycle (`shutdownPolicy`) + `operatingMode`; the provider's manifest builder assembles the complete PodSpec: container image (non-terminating entrypoint, same pattern as the docker provider), resource requests/limits from `SandboxCreateOpts.resources` with chart defaults, `env` from `SandboxCreateOpts.env` (this is where `VALET_SANDBOX_TOKEN` / `VALET_API_URL` / `VALET_SANDBOX_JWT_SECRET` arrive — `VALET_API_URL` is sourced in `main.ts` from the dedicated `VALET_SANDBOX_API_URL` env var, which the chart's ConfigMap sets to the api Service's **in-cluster DNS name** (`http://<release>-api.<namespace>.svc.cluster.local:<service.port>`, via the `valet.fullname`/`.Release.Namespace`/`.Values.service.port` helpers — see `deploy/chart/valet/templates/configmap.yaml`), so it's reachable from a sandbox pod in a different namespace; `main.ts` falls back to `authConfig.baseUrl` — the public `BETTER_AUTH_URL`, which is NOT pod-reachable — when `VALET_SANDBOX_API_URL` is unset, matching pre-chart behavior. There is still no in-sandbox consumer of `VALET_API_URL` — that's the deferred auth follow-up; this only makes the injected value correct), a `/workspace` volumeMount, and a `volumeClaimTemplates` entry for the workspace PVC. The controller owns pod creation, TTL cleanup, and status; the provider drives the CRD through client-node's CustomObjects API (there is no TS SDK — Python/Go only — which is fine: CRDs are plain API objects) and maps CRD status → `SandboxStatus`.
   - **Exec targeting:** the backing pod's name is NOT in the CRD status — it lives in the `agents.x-k8s.io/pod-name` annotation (with a label-selector list as fallback), and the controller creates a FRESH pod name after pod-level recovery. The provider resolves the pod name per operation (or re-resolves whenever readiness flips), never caches it across epochs.
   - **Scope boundary:** exec, file ops, and job-mode are OURS over `pods/exec` against the Sandbox's backing pod (a Sandbox is a pod underneath; the missing TS SDK's file conveniences don't reach us anyway). `SandboxTemplate`/`SandboxClaim` are not used this pass. **Warm pools (`SandboxWarmPool`) and hibernation/resume are recorded fast-follows**, not in scope — but they are the payoff that justifies the CRD dependency, so the lifecycle module must not preclude them.
   - **Churn containment:** agent-sandbox is v0.x; all CRD-facing code lives in one lifecycle module (`src/lifecycle.ts`) behind the provider's own surface, with the pinned CRD version in one constant. If the project stalls or the API breaks, the swap-back to plain pods+PVCs is that one module.
   - **Storage/teardown semantics (adversarial-review catch — the controller owner-references the PVC to the CR, so deleting the CR cascade-deletes the workspace; two teardown paths must therefore be distinguished):**
     - `create(opts)` creates the Sandbox CR; the returned sandbox id **is** the CR name, derived deterministically from the session identity. **`create` is upsert-shaped**: the attachment layer's failure-recovery path calls `provider.create()` again with the same opts (Phase 3 behavior), so an existing CR of the same name is adopted/re-asserted, never an error — which is also what makes re-provision workspace-safe (the retained CR keeps its PVC).
     - **The engine's re-provision must NOT terminally delete the CR — and the existing attachment contract did.** Adversarial review found the real wiring: `SandboxAttachment.reportFailure` (liveness re-provision) calls `provider.destroy(oldId)` *unconditionally* before re-`create`, and `SandboxProvider.restore` is **never called anywhere in the engine** (the `restore(id)` path this spec originally assumed does not exist — the engine only `create`s and `destroy`s). For docker that's fine (destroy = `rm` container, the bind-mounted workspace survives); for k8s `destroy` cascade-deletes the PVC, so re-provision would wipe the workspace. **Fix (engine, additive): a new optional `SandboxProvider.release?(id)` seam.** `reportFailure` calls `provider.release?.(oldId)` when implemented, else falls back to `provider.destroy(oldId)` — so docker/local/virtual behavior is byte-unchanged (they don't implement `release`). The k8s provider implements `release` as a **no-op** (leave the CR standing; the subsequent upsert-`create` re-adopts it and the controller heals the pod onto the retained PVC — workspace survives). Pod death is invisible plumbing beneath a stable CR: **the k8s sandbox identity is the CR, not the pod.**
     - `destroy(id)` is TERMINAL: deletes the CR, controller cascade-deletes pod + PVC. Reached on session deletion via `SandboxAttachment.destroy`'s `provider.destroy(id)` branch — so `KubernetesSandbox` must NOT define a `destroy()` method (a no-op there would short-circuit the attachment and leak the CR forever; the terminal delete lives on the provider only).
     - `capabilities()`: `{ snapshot: "none", persistentWorkspace: true, tunnels: false, warmPool: false, coldStartEstimateMs: ~8000 }` (warmPool flips true in the fast-follow). `persistentWorkspace: true` is honest because re-provision goes through `release`-then-adopt, never destroy.
   - **File ops ride exec** (no host mount exists): `readFile`/`writeFile`/`readBinary`/`writeBinary`/`readdir`/`stat`/`mkdir`/`rm` are implemented over the exec API with base64 framing for binary safety (`base64 -w0` / `base64 -d`), matching the byte-fidelity the docker provider gets from host fs ops. Paths quoted/escaped exactly as the docker provider's exec path does.
   - **Job-mode exec:** same design as the docker provider — `execJob` starts a detached process inside the pod writing to `/tmp/valet-jobs/{execId}.{out,exit}`, `pollJob` reads output from a byte offset, `cancelJob` kills the process group. This reuses the provider-conformance expectations already pinned by the engine's provider conformance suite, which this package runs (the same suite sandbox-docker and sandbox-local run).
   - **Liveness:** pod deleted/evicted out from under an exec surfaces as the sandbox-unavailable error class the attachment layer already handles (epoch re-provision) — the k8s analog of the docker provider's container-death detection.
6. **In-cluster wiring:** the api pod runs under a ServiceAccount whose Role (namespaced to the sandbox namespace) grants the agent-sandbox `Sandbox` custom resource create/get/list/watch/**update**/delete (the `update` verb is required — the create-is-upsert adopt path re-asserts the CR via `replaceNamespacedCustomObject`, an HTTP PUT, which is exactly the workspace-preserving re-provision path in decision 5; omitting it 403s there) plus pods + pods/exec + pods/log create/get/list/watch/delete — nothing cluster-scoped (the agent-sandbox controller itself owns PVC management). Provider config (namespace, image default, resource defaults) comes from env vars fed by the chart. Out-of-cluster dev of the provider itself uses the local kubeconfig (client-node's default loading), so the provider's tests can run against Rancher Desktop k3s without deploying the api.
7. **Sandbox backend selection at boot:** `VALET_SANDBOX_BACKEND=docker|kubernetes|local` (default `docker`, today's behavior). The k8s deployment sets `kubernetes`. `make dev-local` keeps docker.
8. **Helm chart** at `deploy/chart/valet/`: api Deployment (replicas pinned 1 — the engine is a stateful singleton; a values comment says so) with an **initContainer that waits for Postgres readiness** (the api runs migrations at boot; without the gate it crash-loops until PG is up), Service, Ingress (Traefik class by default; **TLS terminated at Traefik with a self-signed/default cert and `BETTER_AUTH_URL=https://…` — better-auth marks session cookies `Secure`, so plain-http login would silently fail**; adversarial-review catch), bundled Postgres StatefulSet + Service + Secret (or `externalDatabase.url`; note StatefulSet PVCs survive `helm uninstall` by Kubernetes design — `make k8s-down` documents the explicit PVC delete for a true reset), sandbox Namespace + ServiceAccount + Role + RoleBinding, app Secret (`BETTER_AUTH_SECRET`, `VALET_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, optional `AUTH_*`) — **generated values use a `lookup`-based retain guard so `helm upgrade` reuses the existing Secret** (naive `randAlphaNum` regenerates per upgrade, which would invalidate every session AND rotate the sandbox JWT master, since `VALET_SANDBOX_JWT_MASTER` falls back to `BETTER_AUTH_SECRET`), ConfigMap for non-secret config (`BETTER_AUTH_URL`, sandbox backend/namespace/image). **The api pod template carries `checksum/secret` + `checksum/config` annotations** — Kubernetes injects `envFrom`/`secretKeyRef` env vars at pod start only, so without them a key rotation updates the Secret while the running pod keeps the old value and `helm upgrade --wait` still reports success. `checksum/secret` digests the supplied values (`api.secrets.*`, `externalDatabase.url`, `postgres.*`) rather than the rendered Secret: the retain guard emits a fresh `randAlphaNum` on any render that cannot `lookup`, so a digest over the rendered Secret would change when nothing changed and restart the api on the first upgrade after an install. Secrets reached through `api.extraEnvFrom` are outside the chart and outside both digests — rotate those with an explicit `kubectl rollout restart`. `helm test`-style smoke hook: a Job that curls `/api/health`.

   **agent-sandbox installation (corrected — there is NO published Helm chart or repo to depend on):** the project releases raw `manifest.yaml` (CRDs + controller Deployment + **admission webhook Service and its certs** — the webhook exists and must be accounted for). We **vendor the version-pinned release manifest** under `deploy/agent-sandbox/{VERSION}/manifest.yaml` and apply it via a documented `make` step / Helm pre-install hook. Helm's `crds/` dir semantics (install-once, never upgraded) make "CRDs pinned in values" impossible — version bumps are an explicit vendored-manifest update + re-apply, and a future v1alpha1→v1beta1 storage migration uses upstream's migration tooling.
9. **Local workflow (Make targets):** `make k8s-build` (nerdctl builds both images into the `k8s.io` containerd namespace — **requires Rancher Desktop in containerd mode, not dockerd**; images get concrete tags and the chart sets `imagePullPolicy: IfNotPresent` so k8s never tries a registry pull), `make k8s-up` (vendored agent-sandbox manifest apply + helm upgrade --install with local values), `make k8s-down` (helm uninstall; documents the PG PVC delete for a full reset), `make k8s-logs`. Documented flow: enable Kubernetes in Rancher Desktop → `make k8s-build k8s-up` → open `https://valet.localdev` (**name resolution is an `/etc/hosts` line `127.0.0.1 valet.localdev`, or switch the ingress host to a `*.sslip.io` name in values — Traefik routes by Host header but cannot make the name resolve**; accept the self-signed cert) → sign up (first user = admin, from the auth pass — real auth is ON in the cluster: `BETTER_AUTH_SECRET` is chart-generated-with-retain if unset).
10. **What this pass changes in the engine (minimal, additive):** ONE optional seam — `SandboxProvider.release?(id)` — consumed by `SandboxAttachment.reportFailure` (decision 5). Providers that don't implement it (docker/local/virtual) keep exact current behavior via the `destroy` fallback. Everything else the pass leaves untouched: the store layer (sub-project A owns it), the auth system (it just gets configured), sandbox-docker/sandbox-local (dev/default providers, behavior-unchanged).

## Exit criteria (the dogfood)

On a clean Rancher Desktop k3s: `make k8s-build k8s-up`, then in the browser — sign up (becomes admin), start a session, run a command that provisions a sandbox (verify `kubectl get sandboxes,pods -n valet-sandboxes` shows the Sandbox CR + backing pod with the session label), run a >60s command (job-mode path over exec), `kubectl delete pod` the backing pod mid-session and watch recovery (controller-recreate or attachment re-provision — either path) land on the same workspace storage with files intact, invite flow works (create invite → second browser profile signs up as member), and everything survives `kubectl rollout restart deployment/valet-api` (boot restore over the bundled Postgres).

## Testing

- Provider conformance: the engine's sandbox provider conformance suite runs against `sandbox-kubernetes` on Rancher Desktop k3s (`make test-k8s`, skipped when no cluster is reachable — same pattern as sandbox-docker's Docker-gated tests).
- Unit: Sandbox CR manifest construction (pure functions — image/env/resources/labels/storage), CRD-status→SandboxStatus mapping, exec framing (base64 round-trips, exit-code capture), job file protocol (offset math shared with docker's — extract to a shared helper if identical).
- Chart: `helm lint` + `helm template` golden-file assertions (RBAC scoped to the sandbox namespace; api env carries DATABASE_URL from bundled vs external correctly; no Secret values in ConfigMaps; the pod-template checksums track a rotated key and stay byte-identical across two renders of the same input).
- The full existing fleet stays green untouched (this pass adds packages/files; it does not modify engine/store behavior).

## Dogfood evidence (2026-07-15)

Ran the full exit-criteria checklist above against a live Rancher Desktop
k3s cluster, driven via curl + `kubectl` (no browser — API-level evidence,
see `.superpowers/sdd/task-9-report.md` for the full transcript):

- Signup #1 became org admin (`/api/me` → `role: "admin"`); a prompt
  invoking the `bash` tool provisioned a `Sandbox` CR + backing pod in
  `valet-sandboxes`, labeled `valet.dev/session-id`; a `sleep 75` command
  (>60s) completed via the job-mode exec path; `kubectl delete pod` on the
  backing pod mid-session was healed by the agent-sandbox controller onto a
  fresh pod with the same CR/PVC, and a file written before the delete was
  still present after; an invite → second signup landed as `member` in the
  same org; `kubectl rollout restart deployment/valet-api` preserved the
  session, its full message history, and both users' auth sessions across
  the restart (bundled Postgres boot restore).
- One naming/observability gap found, not fixed (working-as-designed, not a
  wiring bug): the `valet.dev/session-id` label's value is the sanitized
  **workspace path** (`sandboxCrName`/`buildSandboxManifest` in
  `packages/sandbox-kubernetes/src/manifest.ts`), not the engine's session
  id — `SandboxCreateOpts` has no `sessionId` field by design (mirrors
  `sandbox-docker`'s workspace-as-identity model). Two sessions whose
  workspace paths sanitize to the same RFC1123 string would collide on one
  CR, and `kubectl get sandbox -l valet.dev/session-id=<real session id>`
  does not work as the label name suggests. Left as a follow-up; not a
  blocker for this pass since workspace-derived identity is deterministic
  and consistent with the existing docker provider.

## Update (2026-08-26): boot ordering and the probe split

The sha-a6eadbe rollout to agents-dev crash-looped: `startServer()` bound the
HTTP listener after every awaited boot-restore step, so `/api/health` was
unreachable while `restoreUnsettledSessions` waited on a `git fetch` inside a
wedged sandbox. Boot crossed the 300s startup budget and the kubelet killed
the pod before the port ever bound.

The fix changes both the api and the chart (0.10.2):

- `main.ts` binds the listener right after provider construction. Restore,
  child-watch re-arm, channel host, prebuild sweep, instance-config
  reconcile, and the team-sync report run in a background chain after the
  port binds. The restore pass is bounded: 60s per session, 4 sessions at a
  time (`runBoundedRestore` in `boot-restore.ts`).
- `GET /api/ready` (new) reports 503 until the background chain completes.
  `reconcileInstanceConfig` keeps its fail-fast `process.exit(1)`; it runs
  before the ready flip, so a pod with a bad config dies NotReady and never
  takes traffic.
- Probes: startup + liveness stay on `/api/health` ("port bound"); the
  startup window shrinks from 300s to 90s because pre-bind work is now only
  DB connect + migrations + provider construction. Readiness moves to
  `/api/ready`, so a pod still restoring holds traffic without being killed.

Follow-ups recorded, not done here: lazy workspace refresh (take `git fetch`
out of restore-time prep entirely) and sandbox disk-exhaustion hygiene.

## Non-goals

- CI image publishing / remote clusters (follow-up when a prod cluster exists).
- Horizontal api scaling, HPA, PodDisruptionBudgets (singleton by design this pass).
- CloudNativePG / operator-managed Postgres (values-level swap later if wanted).
- agent-sandbox `SandboxTemplate`/`SandboxClaim`, `SandboxWarmPool`, and hibernation/resume — recorded fast-follows once the basic flow dogfoods (warm pools flip `capabilities().warmPool`; hibernation maps onto attachment epochs). gVisor/Kata runtime classes likewise (prod hardening).
- In-sandbox services (VS Code/VNC/gateway) — the service-JWT primitives from the auth pass wait for that pass.
- Cloudflare adapters (future direction; DB story already compatible via Hyperdrive+Neon).
- Network policies / pod security admission hardening beyond namespace isolation (recorded as a prod-readiness follow-up).
