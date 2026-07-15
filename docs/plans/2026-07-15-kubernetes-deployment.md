# Kubernetes Deployment Implementation Plan (sub-project B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Valet v2 running on Rancher Desktop k3s per `docs/specs/2026-07-15-kubernetes-deployment-design.md`: sandbox-kubernetes provider on the agent-sandbox CRD, api+sandbox images, Helm chart with bundled Postgres, local make-target workflow.

**Architecture:** Provider first (testable against the cluster without deploying the api), then images, then chart, then the end-to-end dogfood. Executes AFTER sub-project A (`DATABASE_URL` boot contract is assumed).

**Tech Stack:** `@kubernetes/client-node`, kubernetes-sigs/agent-sandbox (pinned v0.5.x, API `agents.x-k8s.io/v1beta1`), Helm, nerdctl/containerd, Traefik (k3s), postgres:17.

## Global Constraints

- **Spec is normative:** `docs/specs/2026-07-15-kubernetes-deployment-design.md`. Conflict → STOP and report.
- Node 22 prefix on every bash call: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && `.
- agent-sandbox API pinned in ONE constant: group `agents.x-k8s.io`, version `v1beta1`, plural `sandboxes`. All CRD-facing code in `src/lifecycle.ts`.
- **Teardown semantics (non-negotiable, spec decision 5):** recovery/re-provision NEVER deletes the Sandbox CR (the controller owner-references the PVC to it — CR deletion cascade-deletes the workspace). `destroy(id)` is terminal-only. `create` is upsert-shaped (attachment recovery re-calls it). Sandbox id == deterministic CR name; `restore(id)` is cluster-backed, no in-memory registry.
- Exec/file-ops/job-mode over `pods/exec`; backing pod name resolved per-operation from the `agents.x-k8s.io/pod-name` annotation (label-selector fallback), never cached across epochs.
- Cluster-dependent tests use a skip-if-unreachable guard (same pattern as sandbox-docker's Docker-gated tests). CI never requires a cluster.
- No `any` / `as unknown as` / `@ts-ignore` (CRD payloads are typed via hand-written interfaces for the vendored version — not `any`-blobs).
- Known-allowed failures: the 2 `messages.abort.test.ts` pre-existing ones.
- Commits per task, terse, no AI trailers.

---

### Task 1: Package scaffold + Sandbox CR manifest builder (pure)

**Files:** Create `packages/sandbox-kubernetes/{package.json,tsconfig.json,src/{index.ts,types.ts,manifest.ts},test/manifest.test.ts}`; root tsconfig reference.

**Interfaces (produces):**
```ts
export interface K8sProviderConfig { namespace: string; defaultImage: string; defaultResources?: { cpu?: number; memory?: string }; apiVersion: "agents.x-k8s.io/v1beta1"; }
export function sandboxCrName(sessionKey: string): string;   // deterministic, RFC1123-safe, <=63 chars (hash-suffix on overflow)
export function buildSandboxManifest(cfg: K8sProviderConfig, name: string, opts: SandboxCreateOpts): SandboxCR;
// SandboxCR: { apiVersion, kind: "Sandbox", metadata: { name, labels: { "valet.dev/session-id" } }, spec: { podTemplate: { spec: full PodSpec }, volumeClaimTemplates: [workspace PVC], lifecycle? } }
```
PodSpec per spec decision 5: container image (opts.image ?? default), non-terminating command, env from opts.env, resources mapped, `/workspace` volumeMount ↔ volumeClaimTemplate.

- [ ] Failing tests: name determinism + truncation; manifest golden shapes (env/resources/labels/storage; no top-level image field — it's inside podTemplate).
- [ ] Implement; green; typecheck. Commit: `feat(sandbox-kubernetes): scaffold + Sandbox CR manifest builder`

### Task 2: Lifecycle module — CRD CRUD + status mapping

**Files:** Create `src/lifecycle.ts`, `test/lifecycle.test.ts` (fake CustomObjectsApi), `test/lifecycle.cluster.test.ts` (skip-gated real cluster).

CustomObjectsApi wrapper: `applySandbox` (create-or-adopt: 409 → GET+patch — the upsert shape), `getSandbox`, `deleteSandbox`, `sandboxStatus` → engine `SandboxStatus` mapping (controller conditions → provisioning/ready/error; absent CR → released), `resolvePodName` (annotation `agents.x-k8s.io/pod-name`, label-selector list fallback; returns null while pending).

- [ ] Unit tests on the fake; cluster test (Rancher Desktop + vendored CRDs applied): create → ready → pod resolvable → delete cascades.
- [ ] Commit: `feat(sandbox-kubernetes): CRD lifecycle module`

### Task 3: Vendor agent-sandbox + local cluster bootstrap

**Files:** Create `deploy/agent-sandbox/{VERSION}/manifest.yaml` (vendored release artifact, includes CRDs + controller + admission webhook), `Makefile` targets `k8s-sandbox-install` / `k8s-sandbox-uninstall`, `deploy/README.md` start.

- [ ] Vendor the pinned release manifest (download by tag, record sha256 alongside). `make k8s-sandbox-install` applies it; verify controller + webhook Ready on Rancher Desktop k3s; `kubectl get sandboxes` works.
- [ ] Commit: `chore(deploy): vendor agent-sandbox {VERSION} + install targets`

### Task 4: Exec engine — file ops, exec, job-mode over pods/exec

**Files:** Create `src/exec.ts`, `src/files.ts`, `src/jobs.ts`, tests (unit: framing/offset math; cluster: skip-gated round-trips).

`exec(command, opts)` via client-node `Exec` against the resolved pod; file ops with base64 framing (`base64 -w0`/`-d`) for byte fidelity, path quoting matched to sandbox-docker's; job-mode: detached process writing `/tmp/valet-jobs/{execId}.{out,exit}`, `pollJob(execId, offset)` byte-offset reads, `cancelJob` kills the process group — extract any offset-math shared with sandbox-docker into a small shared helper ONLY if byte-identical (else duplicate with a comment).

- [ ] Unit green; cluster test: write/read binary round-trip (random 1MB buffer), exec exit codes, job start/poll/complete/cancel.
- [ ] Commit: `feat(sandbox-kubernetes): exec, file ops, job-mode over pods/exec`

### Task 5: The provider — SandboxProvider assembly + conformance

**Files:** Create `src/provider.ts` wiring 1+2+4 into `SandboxProvider`/`Sandbox`; `test/conformance.cluster.test.ts` running the ENGINE's sandbox provider conformance suite (`runSandboxContract` in `packages/engine/src/test-helpers/sandbox-contract.ts`).

`capabilities()` per spec. The suite's `recreate` callback = **pod-recreate under the retained CR** (delete backing pod, wait ready, workspace must survive) — NOT provider destroy+create. `destroy` terminal semantics verified (CR + PVC gone). Liveness: pod-vanished-mid-exec surfaces as the sandbox-unavailable error class the attachment layer expects (match sandbox-docker's error shape).

- [ ] Conformance green on Rancher Desktop k3s (skip-gated). Commit: `feat(sandbox-kubernetes): provider passes sandbox conformance`

### Task 6: Boot integration — VALET_SANDBOX_BACKEND

**Files:** Modify `packages/api/src/providers/node.ts` (+ config plumbing), `packages/api/package.json` dep.

`VALET_SANDBOX_BACKEND=docker|kubernetes|local` (default docker). `kubernetes` → build the provider from env (`VALET_SANDBOX_NAMESPACE`, `VALET_SANDBOX_IMAGE`, kubeconfig in-cluster or default loading). Unit test on the selection logic (no cluster needed).

- [ ] Fleet green; commit: `feat(api): sandbox backend selection`

### Task 7: Images — api (with web) + sandbox

**Files:** Create `docker/Dockerfile.api` (multi-stage: pnpm build monorepo → prune → runtime with `packages/web/dist` baked in), `docker/Dockerfile.sandbox-k8s` (or reuse the sandbox default image decision), `Makefile` `k8s-build` (nerdctl --namespace k8s.io, concrete tags, containerd-mode check with a helpful error).

Api serves web: Hono `serveStatic` registered LAST with SPA fallback excluding `/api`, `/mcp`, `/.well-known` (spec decision 3 — test this in `packages/api` route tests, not just in-cluster: fallback returns index.html for `/settings`, JSON 404 for `/api/nope`, and does NOT shadow `/.well-known/oauth-authorization-server`).

- [ ] Route tests green; `make k8s-build` produces runnable images (smoke: `nerdctl run` the api image with PGlite env → `/api/health` responds).
- [ ] Commit: `feat(deploy): api+sandbox images; api serves web with guarded SPA fallback`

### Task 8: Helm chart

**Files:** Create `deploy/chart/valet/` (Chart.yaml, values.yaml, templates: api Deployment w/ PG-wait initContainer, Service, Ingress w/ TLS self-signed + `BETTER_AUTH_URL=https://…`, postgres StatefulSet+Service+Secret gated on `externalDatabase.url`, sandbox Namespace/ServiceAccount/Role/RoleBinding [sandboxes + pods + pods/exec + pods/log], app Secret with `lookup`-retain guard for generated values, ConfigMap, helm-test Job hitting `/api/health`).

- [ ] `helm lint` + `helm template` golden tests (scripted assertions: retain-guard renders, RBAC namespaced, DATABASE_URL wiring bundled-vs-external, no secrets in ConfigMap, imagePullPolicy IfNotPresent).
- [ ] Commit: `feat(deploy): valet helm chart`

### Task 9: Local workflow + THE DOGFOOD (exit criteria)

**Files:** `Makefile` `k8s-up`/`k8s-down`/`k8s-logs`; `deploy/README.md` complete (hosts-file or sslip.io, cert acceptance, reset instructions incl. PG PVC delete).

- [ ] Execute the spec's exit criteria on a clean Rancher Desktop k3s, in order: `make k8s-build k8s-up` → browser signup (admin) → session → sandbox CR+pod appear with session label → >60s job-mode command → `kubectl delete pod` mid-session → recovery onto same storage with files intact → invite flow (second browser profile → member) → `kubectl rollout restart deployment/valet-api` → boot restore over bundled PG. Record evidence (kubectl outputs, screenshots-by-description) in the ledger.
- [ ] Fix-forward anything the dogfood surfaces (product bugs found here are in-scope for this task or spawn immediate fix tasks — the controller decides).
- [ ] Update spec status → Implemented; CLAUDE.md gains the k8s dev-commands section. Commit: `feat(deploy): local k8s workflow; dogfood evidence`

## Self-Review

- Spec coverage: decisions 1-10 → cluster pin (3,9), images (2,7), api-serves-web (7), bundled PG + retain guard + TLS (8), provider/CRD/exec/teardown (1,2,4,5), RBAC (8), backend selection (6), make targets + dogfood (9). Fast-follows (warm pool, hibernation) correctly absent.
- The conformance suite name/location was verified by the adversarial review (`runSandboxContract`, `packages/engine/src/test-helpers/sandbox-contract.ts`) — Task 5 references the real thing.
- Types: `K8sProviderConfig`/manifest fns (T1) → T2/T5; lifecycle fns (T2) → T5; exec modules (T4) → T5; provider (T5) → T6.
