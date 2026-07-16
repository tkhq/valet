# Sandbox Hibernation + Warm Pools Design — the agent-sandbox payoff

**Date:** 2026-07-15
**Status:** Draft
**Scope:** Stage 1 (ships now): engine-driven sandbox hibernation — idle-timeout + manual pause, wake-on-touch — implemented on the base `Sandbox` CRD's `operatingMode`, with the provider seam kept generic. Stage 2 (design-complete, implementation gated): warm pools via the agent-sandbox extension CRDs. This is the fast-follow the k8s deployment spec recorded as "the payoff that justifies the CRD dependency."

## Context

- The vendored base CRD (v0.5.1, `deploy/agent-sandbox/v0.5.1/manifest.yaml`) already carries the hibernation surface, unused: `spec.operatingMode: Running | Suspended` (`:183-188`) plus `shutdownTime`/`shutdownPolicy`. Suspended scales the pod away while the Sandbox CR and its workspace PVC persist — hibernation upstream is scale-to-zero, not a memory snapshot.
- The engine **never idles a sandbox today**: provisioning is lazy (first claimed turn), `destroy` fires only on session deletion, `release` only on liveness re-provision. `SessionStatus` already includes `"hibernated"` as an enum value with no sandbox-side behavior behind it.
- Warm pools (`SandboxWarmPool`/`SandboxClaim`/`SandboxTemplate`) live in a **separate un-vendored** `extensions.yaml`. Upstream v0.5.0/0.5.1 carry a status-wiping race on warm-started claims (fix indicated for v0.5.2), and PVC support in pooled sandboxes is an open feature request (kubernetes-sigs/agent-sandbox#453) — pooled pods cannot yet carry our workspace `volumeClaimTemplates` model.
- `capabilities()` currently reports `warmPool: false, coldStartEstimateMs: 8000`.

## Stage 1 — Hibernation (this pass)

### Decisions (locked)

1. **Provider seam (engine contract change — adversarial review required):** `SandboxProvider` gains optional `suspend?(id): Promise<void>` and `resume?(id): Promise<void>`, and `SandboxCapabilities` gains `hibernation: boolean`. Kubernetes implements both by patching `spec.operatingMode` (merge patch, preserving controller-owned metadata — the PUT-replace clobber note from B-Task 2 applies) and returns `hibernation: true`. Docker/local/virtual don't implement them (`hibernation: false`) and are byte-unchanged; the engine's idle policy is a no-op when the capability is off.

2. **Attachment states, not new machinery:** hibernation maps onto the existing `SandboxAttachment` epoch model (as the k8s spec predicted). A new attachment state `suspended` sits beside `detached`/`provisioning`/`ready`. `suspend` transitions `ready → suspended` (calls `provider.suspend`); any `ensureReady` on a suspended attachment transitions `suspended → provisioning` via `provider.resume` + the existing `waitReady` polling (the controller recreates the pod on the retained PVC; startup-failure classification applies unchanged). The sandbox id (CR name) is stable across suspend/resume — no new epoch is minted for a clean wake; epochs remain the failure-recovery mechanism.

3. **Idle policy (engine-level, per session):** when a session has **no running turn, no queued submissions, and no open decision gate holding a turn** for a configurable window, the engine suspends its sandbox and sets session status `hibernated`. 
   - Default window: **30 minutes**, configured via engine options from env `VALET_SANDBOX_IDLE_MINUTES` (0 disables). One timer authority: the engine host's existing periodic sweep cadence (the same place event-retention pruning runs), not per-session `setTimeout`s — restart-safe because idleness is recomputed from store state (`lastActivityAt` high-water mark), not from in-memory timers.
   - **Suspend never races a turn:** the sweep re-checks turn/queue state immediately before calling `provider.suspend`, and a submission arriving between check and suspend wins — `submitPrompt` on a hibernated/suspending session always proceeds to `ensureReady`, and a wake requested during an in-flight suspend queues behind it (suspend completes, then resume runs; both are idempotent CR patches).
4. **Manual pause + implicit wake:** `POST /api/sessions/:id/pause` (session-access-gated) forces the same suspend path regardless of the idle window (refused with 409 if a turn is running). There is no explicit resume route: any submission, gateway touch (the auth-gateway spec's 409-wake hint), or `ensureReady` caller wakes the session. UI: a pause control on the session view; hibernated sessions show a "sleeping — will wake on message" badge driven by the existing status stream.

5. **Status truthfulness:** `SandboxStatus.state` gains honest reporting — the k8s provider maps a Suspended CR to the existing `idle` state (no new enum value; `idle` was unused and means exactly this). Session status `hibernated` clears back to `active` when a wake completes. Wake latency is cold-start-shaped (~8s today); the UI badge covers it, and warm pools (Stage 2) are the latency fix.

6. **`shutdownTime` stays out.** Cluster-side expiry (`shutdownTime`/`shutdownPolicy`) is redundant with the engine's sweep and introduces a second authority that can suspend a sandbox the engine believes is ready. One brain: the engine decides; the CRD field stays unset. Revisit only if api-down-for-days resource leakage becomes real (noted, not built).

7. **Sandbox tokens are untouched by hibernation.** Suspend does not revoke `VALET_SANDBOX_TOKEN` (the env is baked at session build and must survive wake); token revocation remains bound to session stop/deletion exactly as today.

## Stage 2 — Warm pools (design-complete, gated)

**Gate to open implementation (all three):** (a) upstream release with the warm-claim status-race fix (v0.5.2+) published and vendored — both `manifest.yaml` and `extensions.yaml` at the same pinned version; (b) a workspace answer for pooled pods: either upstream PVC-in-template support (#453) or an accepted seeding strategy (pool pods run the image with an emptyDir; on claim, the provider provisions the workspace PVC and re-binds — which upstream does not support today, hence the gate); (c) hibernation (Stage 1) dogfooded, since wake-latency data tells us how much the pool actually buys.

**Design (locked now so Stage 1 doesn't preclude it):**

- One `SandboxTemplate` per sandbox image/profile (helm-managed), one `SandboxWarmPool` with `replicas` from values (default 2, 0 = disabled). Templates/pools are **per-image**, so this composes with the sandbox-images-v2 spec (`docs/specs/2026-07-15-sandbox-images-v2-design.md`): each repo prebuild config maps to at most one template/pool, pool sizing is image-keyed, and pooling stays an optimization applied only where a pool exists for the resolved image.
- `create(opts)` becomes claim-first: create a `SandboxClaim` referencing the pool; on fulfillment, adopt the claimed Sandbox (label it with the session identity, apply session env — **env application to a pre-started pod is the hard part**: pooled pods boot without `VALET_SANDBOX_TOKEN`/JWT secret, so per-session env must arrive post-claim, e.g. written to a file via exec before first use, or the claim triggers a one-time controller-side restart with merged env — the plan picks after testing what upstream fulfillment actually does). Fallback to today's cold `Sandbox` create on claim timeout (pool empty/broken) — warm is an optimization, never a correctness dependency.
- `capabilities()` flips `warmPool: true` and drops `coldStartEstimateMs` to the measured claim latency.
- Stage 1's seams are already compatible: suspend/resume operate on the adopted CR identically; `release`/adopt semantics unchanged.

## Exit criteria (Stage 1 dogfood)

On live Rancher Desktop k3s: start a session, run a command, wait past a shortened idle window (env set to 1 minute) → `kubectl get sandboxes,pods -n valet-sandboxes` shows the CR Suspended and the pod gone, session badge shows sleeping; send a message → pod comes back on the same PVC, a file written before hibernation is still present, reply arrives; manual pause works and is refused (409) mid-turn; a message sent at the exact moment of suspension is not lost (wake wins); api restart while a session is hibernated → session still shows hibernated and wakes correctly on message.

## Testing

- **Contract:** suspend/resume added to the provider conformance suite as capability-gated cases (k8s runs them live; docker/local assert the capability is off and the engine policy no-ops — pinning byte-unchanged behavior).
- **Engine unit:** idle sweep — fires only with no turn/queue/gate; recompute-from-store beats in-memory state after restart; suspend/submit race resolves to wake (deterministic interleaving via injected hooks, same style as the attachment epoch tests).
- **k8s provider:** `operatingMode` merge-patch preserves controller metadata; Suspended→`idle` status mapping; wake path reuses `waitReady` incl. startup-failure classification.
- **API:** pause route 409-mid-turn, 404 non-access; status stream reflects hibernated→active.
- **The mutation-tested store concurrency contracts stay green** — hibernation adds no new store writes beyond session status.

## Non-goals

- Memory snapshots / CRIU-style checkpointing (upstream has none; hibernation = scale-to-zero on a retained PVC).
- `shutdownTime`-based cluster-side expiry (decision 6).
- Warm-pool implementation before the three-part gate opens (Stage 2 is design-only in this pass).
- Hibernation for docker/local providers (capability off; docker container stop/start parity is a possible later nicety, not needed for the k8s payoff).
- Autoscaling pool size, per-org pools, gVisor/Kata runtime classes.
