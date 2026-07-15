# Kubernetes Deployment Design — local k3s reference environment (sub-project B)

**Date:** 2026-07-15
**Status:** Approved for planning (executes after sub-project A: `docs/specs/2026-07-15-postgres-backend-design.md`)
**Scope:** Everything needed to run Valet v2 on Kubernetes: a `sandbox-kubernetes` provider (session sandboxes as pods), api+web+sandbox container images, a Helm chart (api, bundled Postgres, RBAC, ingress), and the fully local reference environment on Rancher Desktop's k3s that we iterate toward production with. Cloudflare adapters are a separate future direction.

## Decisions (locked)

1. **Reference environment: Rancher Desktop k3s.** The user already runs Rancher Desktop; enabling Kubernetes gives k3s with Traefik ingress and the `local-path` storage provisioner. Docs and Make targets pin this environment; the chart and provider stay generic Kubernetes (nothing k3s-specific in code).
2. **Images: local builds only.** Multi-stage Dockerfiles built directly into Rancher Desktop's containerd via `nerdctl --namespace k8s.io build` — no registry. CI publishing (ghcr) is a follow-up when a remote cluster exists. Images: `valet-api` (Node 22 + built monorepo + web static assets) and `valet-sandbox` (the session sandbox image; default remains the docker provider's `node:20-bookworm`-equivalent, overridable per-deployment via values and per-session via `SandboxCreateOpts.image`).
3. **The api serves the web app.** `packages/web`'s `vite build` output is baked into the api image and served by Hono (`serveStatic` + SPA fallback to `index.html` for non-`/api` paths). One pod, one Service, one ingress host — no separate web deployment. Dev (`make dev-local`) is unchanged (Vite dev server + proxy).
4. **Database: bundled Postgres StatefulSet with external override.** The chart ships a single-replica StatefulSet on the official `postgres:17` image (no Bitnami — their free catalog was discontinued in 2025), PVC via the cluster's default storage class, credentials in a Secret. `externalDatabase.url` in values disables the bundled instance and points the api at managed PG (the prod path). The api consumes plain `DATABASE_URL` either way (sub-project A's boot contract).
5. **`packages/sandbox-kubernetes`: pod-per-session provider.**
   - Implements the engine's `SandboxProvider`/`Sandbox` contract (`create`/`restore`/`destroy`/`status`; file ops, `exec`, and job-mode `execJob`/`pollJob`/`cancelJob`) via `@kubernetes/client-node` — the K8s API only, no kubectl shelling.
   - **Pod shape:** one pod per session in a dedicated sandbox namespace, labeled `valet.dev/session-id`, running the sandbox image with a long-sleep entrypoint (same pattern as the docker provider), resource requests/limits from `SandboxCreateOpts.resources` with chart-level defaults, `env` from `SandboxCreateOpts.env` (this is where `VALET_SANDBOX_TOKEN` / `VALET_API_URL` / `VALET_SANDBOX_JWT_SECRET` arrive — and `VALET_API_URL` is the api's **Service DNS name**, which closes the auth-pass follow-up about container-unreachable URLs).
   - **Workspace persistence:** a PVC per session (named from the session id, `local-path` locally), mounted at `/workspace`. `create` creates PVC+pod; `restore` re-creates the pod over the existing PVC (workspace survives sandbox epochs, matching the docker provider's bind-mount semantics); `destroy` deletes pod and PVC. `capabilities()`: `{ snapshot: "none", persistentWorkspace: true, tunnels: false, warmPool: false, coldStartEstimateMs: ~8000 }`.
   - **File ops ride exec** (no host mount exists): `readFile`/`writeFile`/`readBinary`/`writeBinary`/`readdir`/`stat`/`mkdir`/`rm` are implemented over the exec API with base64 framing for binary safety (`base64 -w0` / `base64 -d`), matching the byte-fidelity the docker provider gets from host fs ops. Paths quoted/escaped exactly as the docker provider's exec path does.
   - **Job-mode exec:** same design as the docker provider — `execJob` starts a detached process inside the pod writing to `/tmp/valet-jobs/{execId}.{out,exit}`, `pollJob` reads output from a byte offset, `cancelJob` kills the process group. This reuses the provider-conformance expectations already pinned by the engine's provider conformance suite, which this package runs (the same suite sandbox-docker and sandbox-local run).
   - **Liveness:** pod deleted/evicted out from under an exec surfaces as the sandbox-unavailable error class the attachment layer already handles (epoch re-provision) — the k8s analog of the docker provider's container-death detection.
6. **In-cluster wiring:** the api pod runs under a ServiceAccount whose Role (namespaced to the sandbox namespace) grants pods+pods/exec+pods/log+PVCs create/get/list/watch/delete — nothing cluster-scoped. Provider config (namespace, image default, resource defaults) comes from env vars fed by the chart. Out-of-cluster dev of the provider itself uses the local kubeconfig (client-node's default loading), so the provider's tests can run against Rancher Desktop k3s without deploying the api.
7. **Sandbox backend selection at boot:** `VALET_SANDBOX_BACKEND=docker|kubernetes|local` (default `docker`, today's behavior). The k8s deployment sets `kubernetes`. `make dev-local` keeps docker.
8. **Helm chart** at `deploy/chart/valet/`: api Deployment (replicas pinned 1 — the engine is a stateful singleton; a values comment says so), Service, Ingress (Traefik class by default, host `valet.localdev` locally), bundled Postgres StatefulSet + Service + Secret (or `externalDatabase.url`), sandbox Namespace + ServiceAccount + Role + RoleBinding, app Secret (`BETTER_AUTH_SECRET`, `VALET_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, optional `AUTH_*`), ConfigMap for non-secret config (`BETTER_AUTH_URL`, sandbox backend/namespace/image). `helm test`-style smoke hook: a Job that curls `/api/health`.
9. **Local workflow (Make targets):** `make k8s-build` (nerdctl builds both images into k8s.io namespace), `make k8s-up` (helm upgrade --install with local values), `make k8s-down`, `make k8s-logs`. Documented flow: enable Kubernetes in Rancher Desktop → `make k8s-build k8s-up` → open `http://valet.localdev` (hosts-file line or Traefik localhost routing) → sign up (first user = admin, from the auth pass — real auth is ON in the cluster: `BETTER_AUTH_SECRET` is chart-generated if unset).
10. **What this pass does NOT change:** the engine, the store layer (sub-project A owns it), the auth system (it just gets configured), sandbox-docker/sandbox-local (they remain the dev/default providers).

## Exit criteria (the dogfood)

On a clean Rancher Desktop k3s: `make k8s-build k8s-up`, then in the browser — sign up (becomes admin), start a session, run a command that provisions a sandbox **pod** (verify `kubectl get pods -n valet-sandboxes` shows it, with the session label), run a >60s command (job-mode path over exec), `kubectl delete pod` the sandbox mid-session and watch the attachment re-provision onto the same PVC with workspace files intact, invite flow works (create invite → second browser profile signs up as member), and everything survives `kubectl rollout restart deployment/valet-api` (boot restore over the bundled Postgres).

## Testing

- Provider conformance: the engine's sandbox provider conformance suite runs against `sandbox-kubernetes` on Rancher Desktop k3s (`make test-k8s`, skipped when no cluster is reachable — same pattern as sandbox-docker's Docker-gated tests).
- Unit: pod/PVC manifest construction (pure functions — image/env/resources/labels), exec framing (base64 round-trips, exit-code capture), job file protocol (offset math shared with docker's — extract to a shared helper if identical).
- Chart: `helm lint` + `helm template` golden-file assertions (RBAC scoped to the sandbox namespace; api env carries DATABASE_URL from bundled vs external correctly; no Secret values in ConfigMaps).
- The full existing fleet stays green untouched (this pass adds packages/files; it does not modify engine/store behavior).

## Non-goals

- CI image publishing / remote clusters (follow-up when a prod cluster exists).
- Horizontal api scaling, HPA, PodDisruptionBudgets (singleton by design this pass).
- CloudNativePG / operator-managed Postgres (values-level swap later if wanted).
- In-sandbox services (VS Code/VNC/gateway) — the service-JWT primitives from the auth pass wait for that pass.
- Cloudflare adapters (future direction; DB story already compatible via Hyperdrive+Neon).
- Network policies / pod security admission hardening beyond namespace isolation (recorded as a prod-readiness follow-up).
