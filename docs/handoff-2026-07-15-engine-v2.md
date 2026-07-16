# Engine v2 — Session Handoff (2026-07-15)

> For the next agent picking up work on branch `portable-runtime-v1-spec`. Read this first, then the memory file `project_engine_v2_status.md`, then the ledger `.superpowers/sdd/progress.md`.

## TL;DR

The Engine v2 rewrite is **feature-complete through deployment**. As of this handoff the branch runs the full product — durable agent sessions, workflows, orchestrator, real auth, plugins — on **Postgres everywhere** (SQLite retired) and deploys to **Kubernetes** (dogfooded live on Rancher Desktop k3s). A live deployment is **currently running** on the cluster (see below). Working tree is clean; everything is pushed (`origin/portable-runtime-v1-spec` == HEAD `a753f698`).

The originally-planned next milestone is **Phase 7 — Telegram** (first v2 channel plugin).

## How work gets done here (process)

Everything this arc used **superpowers subagent-driven development**: brainstorm → spec (`docs/specs/`) → plan (`docs/plans/`) → per-task implementer subagent → per-task reviewer subagent (opus for risky/engine-touching) → fix loop → whole-phase final review (fable). Durable progress lives in `.superpowers/sdd/progress.md` (gitignored) — trust it + `git log` over memory after a compaction. Adversarial review earned its keep repeatedly: it caught two Criticals in the Postgres spec (a transaction primitive that lost updates; a seq race) and several in the k8s pass (RBAC missing the `update` verb, secure-cookie/secret-rotation gaps, the release-vs-destroy workspace-deletion bug) — **keep reviewing adversarially, especially anything touching the engine's shared attachment/store contracts.**

## What's complete

- **Phases 1–5** (durable submissions, event stream, sandbox attachment, orchestrator, workflows) + **nodes/visual editor**.
- **Plugin system v2** (136 fleet actions, encrypted credential store), **settings split**, **integrations facelift**.
- **Auth v2** (`docs/specs/2026-07-14-auth-v2-design.md`): better-auth, email/password + social + generic OIDC (Keycloak-ready), invites + allowed-email-domains, API keys, MCP OAuth server (walking skeleton), sandbox tokens + service-JWT primitives.
- **Postgres everywhere** (`docs/specs/2026-07-15-postgres-backend-design.md`, plan `docs/plans/2026-07-15-postgres-backend.md`): one dialect. Dev/tests = embedded PGlite (SIGKILL-durable), prod = `DATABASE_URL`. SQLite + better-sqlite3 **deleted**. Stores conformance-pinned + new mutation-tested concurrency contracts. Memory search = Postgres `tsvector`.
- **Kubernetes deployment** (`docs/specs/2026-07-15-kubernetes-deployment-design.md`, plan `docs/plans/2026-07-15-kubernetes-deployment.md`): `packages/sandbox-kubernetes` runs each session sandbox as a pod via the SIG **agent-sandbox** CRD; api image serves the built web; Helm chart with bundled Postgres + namespaced RBAC + TLS + secret retain-guard. Dogfooded: all 6 exit criteria live.

## The LIVE deployment (currently running — READ BEFORE TOUCHING THE CLUSTER)

A helm release `valet` (rev 2) is deployed to namespace `valet` on Rancher Desktop k3s, with a background port-forward on `localhost:8080`. There is **1 user + 2 sessions** in its bundled Postgres.

- **Access:** http://localhost:8080 (real auth is ON; first signup = admin — already taken). Port-forward: `kubectl --context rancher-desktop -n valet port-forward svc/valet-api 8080:80`.
- **Watch sandboxes:** `kubectl --context rancher-desktop -n valet-sandboxes get sandboxes,pods -w`.
- **Tear down when done:** `make k8s-down` (helm uninstall, context-pinned). The bundled Postgres PVC survives uninstall by design — `kubectl --context rancher-desktop -n valet delete pvc <name>` for a full reset.
- **Rebuild+redeploy after code changes:** `make k8s-build` (builds BOTH images — WAIT for both; the api build is the slow one and it's easy to move on before the sandbox image lands), then `kubectl --context rancher-desktop -n valet rollout restart deploy/valet-api`. Same `:dev` tag → the tag re-points at the new local image, `IfNotPresent` picks it up on the new pod. Rollout drops the port-forward's pod — re-establish it after.
- **Browser access via port-forward needs `http://localhost:8080` in trusted origins** (the release has it set via `api.auth.trustedOrigins`). The *designed* entry is `https://valet.localdev` through the ingress (needs `/etc/hosts` or a `*.sslip.io` host + self-signed cert); `BETTER_AUTH_URL` targets that.

## ⚠️ Critical gotchas (do not skip)

1. **The machine's default kubectl context is a PRODUCTION GKE cluster** (`gke_labrat-glitch-prod...`). Context safety is BINDING: **every** kubectl/helm command pins `--context rancher-desktop` (or `--kube-context`). Never operate on the ambient context. In code, the api's `resolveKubeConfig` throws out-of-cluster without `VALET_KUBE_CONTEXT` and uses `loadFromCluster()` in-cluster.
2. **Node 22 required** for every command: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && …`.
3. **PGlite: one instance per process** (its WASM heap isn't freed on `close()`). Tests use one shared instance with per-boot `DROP SCHEMA CASCADE` reset; kill-tests spawn `node --import tsx` directly (never the `tsx` CLI — it re-execs and orphans on SIGKILL). Dev reset = `rm -rf ~/.valet/pg`.
4. **Transaction discipline (Postgres):** raw `BEGIN`/`COMMIT` through the shared `query()` is forbidden (it lost updates in review) — use the `transaction(fn)` primitive. Multi-statement fenced writes lock a stable always-present row (`engine_sessions` for event-seq).
5. **drizzle sqlite idioms (`.get()/.all()/.run()`) compile clean but crash at runtime on pg** — a `ws.ts` bug shipped this way. RUN the suites; don't trust tsc alone for residual sqlite-isms.
6. **The k8s sandbox identity is the CR, not the pod.** Re-provision goes through `SandboxProvider.release?()` (no-op for k8s → CR re-adopted, workspace survives); terminal `destroy` deletes the CR (cascades the PVC). Never delete the CR on recovery.
7. **Root `pnpm typecheck` does NOT cover `packages/web`** — run `cd packages/web && pnpm typecheck` separately. `packages/worker` + `packages/client` are frozen legacy (still on D1/sqlite — leave them).
8. Known-allowed failing tests: the 2 `messages.abort.test.ts` cases (pre-existing, deterministic — need their own investigation). `sandbox-local` has a `FORCE_COLOR` env flake (run with `FORCE_COLOR=0`).

## Roadmap — what's left

**Named next:** **Phase 7 — Telegram** (first v2 channel plugin; exercises the channel-plugin seam for the first time).

**Feature work needing real building:**
- **Cloudflare adapters** (deferred target; DB already compatible via Neon + Hyperdrive — Workers plumbing).
- **Auth follow-ups:** a **mailer** (unlocks password reset, email verification, emailed invites); the **full MCP tool surface** (OAuth server shipped, real Valet-tools-over-MCP is its own design); the **in-sandbox auth gateway** consuming the service-JWT primitives already built (VS Code/VNC/terminal behind auth); **OAuth connect flows** for integrations (the provider-token → credential-store hook exists, the UI flow doesn't).

**Kubernetes production-hardening** (local reference env is fine without these):
- CI image publishing to ghcr (remote clusters); sandbox images run as root + aren't size-minimized; network policies; tighten the `pods` RBAC over-grant.
- **agent-sandbox fast-follows: warm pools + hibernation** — near-instant sandbox allocation + pause/resume; the payoff that justified the CRD dependency.

**Smaller tracked follow-ups:**
- **First-load session UI race** (client-side; orchestrator warm-up window on a fresh account throws in the frontend, recovers on refresh — server returns all 200s). Needs the browser console error to pin the exact component; likely in `chat.tsx`/`session-view.tsx` first-load ordering.
- Postgres: `claimRun` could use `RETURNING` for atomicity; `updateDecisionGateEntry` should run inside `transaction(fn)`.
- k8s: `workspace`-as-sessionId label naming (`SandboxCreateOpts` has no `sessionId` field); `VALET_API_URL` has no in-sandbox consumer yet (the deferred auth-gateway follow-up).

## Fixed this session (context for why the last few commits exist)

- **Postgres pass + K8s pass** completed and reviewed READY (whole-phase fable reviews).
- Live-inspection findings, all fixed + reviewed + running on the cluster: **nav presence dot** stacked beneath the name → inline (`1f2f6ba0`); **sandbox startup failures hung silently** (ImagePull/CrashLoop/unschedulable all mapped to "provisioning") → now surface a terminal `SandboxStartupError` in ~7s with the real cause, via a pure `classifyPodFailure` + engine `doProvision` waiter-rejection gated strictly on `instanceof SandboxStartupError` (docker/local/virtual byte-unchanged) (`f26f34a3`, `a753f698`); earlier k8s cancel-path fixes (dash-portable group kill, output cap, prompt cancel sentinel).
