# Sandbox Hibernation (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine-driven sandbox hibernation on Kubernetes — 30-min idle suspend (scale-to-zero on the retained PVC via CRD `operatingMode`), manual pause, wake-on-touch — with docker/local/virtual byte-unchanged.

**Architecture:** `SandboxProvider` gains optional `suspend?/resume?` + `SandboxCapabilities.hibernation`; `SandboxAttachment` gains a `suspended` state (`ready → suspended` via `provider.suspend`; `ensureReady` on suspended runs `provider.resume` + the existing `waitReady` path, same epoch). A host-level idle sweep in `EngineHost` (one timer authority, idleness recomputed from store state) suspends idle sessions and stamps app-session status `hibernated`; any submission/tool-op/gateway touch wakes. Kubernetes implements suspend/resume as a JSON **merge-patch** on `spec.operatingMode` (never PUT-replace — controller-metadata clobber hazard) and maps Suspended CRs to the existing `idle` status.

**Tech Stack:** TypeScript strict, @kubernetes/client-node (merge-patch), Hono 4, Drizzle/Postgres (PGlite dev), vitest, live Rancher Desktop k3s for cluster-gated tests.

**Spec:** `docs/specs/2026-07-15-sandbox-hibernation-warm-pools-design.md` — Stage 1 decisions binding; Stage 2 (warm pools) is design-only, DO NOT implement; non-goals (memory snapshots, `shutdownTime`, docker/local hibernation, pool autoscaling) are real.

## Global Constraints

- Every shell command runs under Node 22: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`.
- **Engine contract touchpoints (Task 1) REQUIRE adversarial review (opus):** `SandboxProvider.suspend?/resume?`, `SandboxCapabilities.hibernation`, `AttachmentState "suspended"`, and one new engine-store method `latestActivityAt`. Absent methods / capability-off MUST be byte-identical (the `release?`/`gatewayEndpoint?` precedents at `packages/engine/src/types.ts:652` / `:610` are the template; docker/local/virtual providers and every existing suite unchanged = the pin).
- **Kubernetes context safety (BINDING):** every cluster op pins `--context rancher-desktop`. Cluster-gated tests skip cleanly without a cluster.
- **Merge patch, never PUT-replace, for `operatingMode`:** the existing `applySandbox` PUT-replace path (packages/sandbox-kubernetes/src/lifecycle.ts:381-421) clobbers controller-owned spec fields — suspend/resume must use `patchNamespacedCustomObject` with JSON merge-patch content type.
- **No new epoch on clean wake** (spec decision 2): suspend/resume never touch `_epoch`; epochs stay failure-recovery only.
- **Suspend never races a turn** (spec decision 3): re-check idleness immediately before `provider.suspend`; a submission arriving between check and suspend wins; wake during in-flight suspend queues behind it (both patches idempotent).
- Idle window env: `VALET_SANDBOX_IDLE_MINUTES`, default 30, `0` disables. One timer authority: a host-level sweep (NOT per-session setTimeout; NOT the per-Session 5s sweep — see Task 3 note), idleness recomputed from store state.
- **Sandbox tokens untouched** by hibernation (decision 7): no revocation on suspend.
- **Pre-1.0 migrations:** `agent_sessions.status` enum edit happens in `packages/api/migrations/pg/0000_app.sql` in place + Drizzle schema. `rm -rf ~/.valet/pg` after.
- PGlite one per process; api vitest has unit (env-scrubbed) + integration projects. Known-allowed failures: the 2 `messages.abort` cases. Type safety: no `any`/`as unknown as`/`@ts-ignore`. No Co-Authored-By.
- Root `pnpm typecheck` does not cover `packages/web` — run it separately.

---

### Task 1: Engine contract — `suspend?/resume?`, `hibernation` capability, `suspended` attachment state, `latestActivityAt` [ADVERSARIAL REVIEW REQUIRED]

**Files:**
- Modify: `packages/engine/src/types.ts` (`SandboxProvider`, `SandboxCapabilities`, `SessionStore.latestActivityAt`)
- Modify: `packages/engine/src/sandbox/attachment.ts` (`AttachmentState`, `suspend()`, resume branch in provisioning path)
- Modify: `packages/engine/src/test-helpers/sandbox-contract.ts` (context `provider?` field + capability-gated cases)
- Modify: `packages/engine/src/test-helpers/*store contract*` (conformance case for `latestActivityAt` — find the store-contract suite file)
- Modify: `packages/store-postgres/src/store.ts` + `packages/engine/src/**/in-memory store` (implement `latestActivityAt`)
- Test: `packages/engine/test/attachment-suspend.test.ts`

**Interfaces:**
- Produces (Tasks 2-4): on `SandboxProvider` (beside `release?`, types.ts:652): `suspend?(id: string): Promise<void>; resume?(id: string): Promise<void>;` — absent = capability off. `SandboxCapabilities.hibernation: boolean` (REQUIRED field — all four providers must add it; that is the mechanical Task 2 change). `AttachmentState` gains `"suspended"` (attachment.ts:11). `SandboxAttachment.suspend(): Promise<void>` — only from `ready`: calls `provider.suspend(sandbox.id)`, sets `_state = "suspended"`, keeps `_sandbox` (id stable), emits status via the existing `emitStatus` pipe; no-op (resolve) from any other state. `ensureReady` on `suspended`: transition to `provisioning`, call `provider.resume(id)` then the existing `waitReady`-based readiness path (startup-failure classification unchanged), NO epoch mint, then `ready`. `current()` returns null while suspended (it already gates on `ready` — pin it).
- Produces (Task 3): `SessionStore.latestActivityAt(sessionId: string): Promise<number | null>` — max over the session's queue items of their last-touched timestamp (settled/updated/created — pick the columns the schema actually has; document the choice), null when no items. Conformance-tested in the store contract suite; implemented for Postgres + in-memory.
- Behavior pin: providers without `suspend`/`resume` + `hibernation: false` → all existing suites byte-unchanged; `attachment.suspend()` when the provider lacks `suspend` is a refused no-op (throw `Error("provider does not support hibernation")` — callers gate on capability first).

- [ ] **Step 1: Failing tests** — `attachment-suspend.test.ts` driving a scripted provider (mirror the existing attachment epoch tests' harness): ready→suspend calls provider.suspend once, state suspended, `current()` null, `currentEpoch()` unchanged; ensureReady on suspended calls provider.resume then readiness path, state ready, SAME epoch, waiters resolve; suspend from detached/provisioning resolves without provider calls; provider without suspend → attachment.suspend throws; startup-failure during resume rejects waiters with `SandboxStartupError` (classification unchanged); status events emitted for suspended and the wake transitions. Store-contract case: `latestActivityAt` null on empty, reflects the newest item timestamp after admit+settle.
- [ ] **Step 2: Verify failure** (`pnpm --filter @valet/engine test -- attachment-suspend`; type-only RED via temp `tsc --noEmit`).
- [ ] **Step 3: Implement** per the shapes above. Doc comments mirror the `release?` precedent ("absent === capability off — existing paths unchanged").
- [ ] **Step 4: Conformance** — `SandboxContractContext` gains `provider?: SandboxProvider` and a capability-gated case: when `ctx.capabilities.hibernation` is true, `provider.suspend(sandbox.id)` then `provider.resume(sandbox.id)` round-trips and the sandbox still execs (`echo alive`); when false, assert `provider.suspend === undefined` (fail-loud if `hibernation: true` but `provider` missing from ctx, matching the `persistentWorkspace`/`recreate` pattern).
- [ ] **Step 5: Full engine + store suites** — `pnpm --filter @valet/engine test && pnpm --filter @valet/store-postgres test && pnpm typecheck` — everything green, pre-existing suites unchanged (the byte-identical pin). NOTE: `SandboxCapabilities.hibernation` being required will typecheck-break the four providers — for THIS task add it only to `VirtualSandboxProvider` (`hibernation: false`, packages/engine/src/providers/sandbox/virtual.ts:239) and leave docker/local/k8s to Task 2 ONLY if the build allows (it won't — they're separate packages compiled together via references; so add `hibernation: false` to docker/local/k8s mechanically here too, and Task 2 flips k8s to true with the real implementation).
- [ ] **Step 6: Commit** — `feat(engine): suspend/resume provider seam + suspended attachment state`

---

### Task 2: Kubernetes suspend/resume + status mapping; capability flags everywhere

**Files:**
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts` (`SandboxCustomObjectsApi.patchNamespacedCustomObject`, `setOperatingMode` helper, `mapConditionsToStatus`/`sandboxStatus` Suspended branch)
- Modify: `packages/sandbox-kubernetes/src/provider.ts` (`suspend`/`resume` methods, `capabilities()` → `hibernation: true`)
- Modify: `packages/sandbox-kubernetes/src/types.ts` (`SandboxCRSpec.operatingMode?`)
- Modify: docker/local `capabilities()` → `hibernation: false` (if not already done mechanically in Task 1)
- Test: `packages/sandbox-kubernetes/src/lifecycle.test.ts` (fake objectsApi: merge-patch body/content-type, Suspended→idle mapping), `provider.cluster.test.ts` (live: suspend scales pod away, resume brings it back on the same PVC, conformance `provider` ctx wired)

**Interfaces:**
- Consumes: Task 1 seam. Produces (Task 3): a k8s provider where `provider.suspend(id)` merge-patches `{ spec: { operatingMode: "Suspended" } }` and `resume` patches `"Running"`; `status()` maps a Suspended CR to `state: "idle"`.
- The patch helper: extend `SandboxCustomObjectsApi` (lifecycle.ts:200-206) with `patchNamespacedCustomObject` and implement `setOperatingMode(deps, name, mode: "Running" | "Suspended")` using JSON merge-patch (`@kubernetes/client-node`'s patch call with `PATCH_FORMAT_JSON_MERGE_PATCH` / the client's documented merge-patch invocation — read the installed client version's API first; the fake in tests asserts the body is EXACTLY `{ spec: { operatingMode: mode } }` and nothing else). Idempotent: patching the same mode twice is fine.
- Status mapping: `mapConditionsToStatus`/`sandboxStatus` (lifecycle.ts:498-508, 666-691): when the CR's `spec.operatingMode === "Suspended"`, return `"idle"` BEFORE the Ready-condition branches (a suspended CR's pod is gone; without this branch it reads as `provisioning`). Wake path: `resume` + existing `waitReady`/`classifyPodFailure` untouched.

- [ ] Steps: failing lifecycle tests (fake api pins merge-patch verb + exact body + content type; Suspended→idle; Running CR unchanged mapping) → implement → cluster-gated live test (suspend → pod gone CR stays, resume → pod back, marker file survives on PVC, conformance hibernation case green) → docker/local/virtual conformance contexts assert `hibernation: false` + absent methods → `pnpm --filter @valet/sandbox-kubernetes test && pnpm --filter @valet/sandbox-docker test && pnpm --filter @valet/sandbox-local test && pnpm --filter @valet/engine test && pnpm typecheck` → commit `feat(sandbox-kubernetes): operatingMode suspend/resume via merge patch`.

---

### Task 3: Host idle sweep + `VALET_SANDBOX_IDLE_MINUTES`

**Files:**
- Modify: `packages/api/src/engine/host.ts` (sweep interval, idleness computation, suspend + status stamp, wake hook clearing status)
- Modify: `packages/api/src/providers/node.ts` + `packages/api/src/providers/sandbox-backend.ts` (`resolveIdleMinutes(env)` pure fn → `EngineHostOpts.idleMinutes?`)
- Test: `packages/api/src/engine/host.idle-sweep.test.ts`

**Interfaces:**
- Consumes: Task 1 (`attachment.suspend()`, capability), Task 2 (k8s impl — tests use a scripted provider with `hibernation: true`), `SessionStore.latestActivityAt`, `listUnsettledSubmissions`.
- Produces (Task 4): `EngineHost` maintains ONE `setInterval` (60s cadence; unref'd; started in the constructor when `idleMinutes > 0` and the provider reports `hibernation: true`, stopped in shutdown/evictAll path) that iterates the host's in-memory session cache. Per session: idle ⇔ `listUnsettledSubmissions(id).length === 0` AND `(latestActivityAt(id) ?? sessionCreatedAt) < now - idleMinutes*60_000` AND attachment state is `ready`. If idle: RE-CHECK `listUnsettledSubmissions` immediately before calling `session.attachment.suspend()` (race rule), then update `agent_sessions.status` to `"hibernated"` (Task 4 adds the enum; in THIS task write the engine-side only if Task 4 hasn't landed — order the tasks 3 then 4 with Task 3 exposing `EngineHost.onHibernate?/onWake?` callbacks and Task 4 wiring the db writes through them; keep the seam explicit).
- Wake clears status: hook `attachment.onStatus` — on transition into `ready` FROM `suspended`-initiated provisioning, invoke `onWake` (Task 4 sets status `"active"`). Simplest robust rule: `onWake` fires on every `suspended → provisioning → ready` sequence; track `wasSuspended` on the attachment listener in the host.
- **Documented limitation (write it in the code comment + spec Deviations later):** the sweep covers in-memory sessions only; a session evicted from cache (or never restored after an api restart) with a still-running pod is not swept. Boot-restore only rehydrates sessions with unsettled submissions — an idle-but-running pod from before a restart hibernates only when next touched. Accepted for Stage 1 (decision 6 rejected cluster-side expiry as a second authority).
- Config: `resolveIdleMinutes(env: NodeJS.ProcessEnv): number` — parses `VALET_SANDBOX_IDLE_MINUTES`, default 30, `0`/invalid → 0 (disabled logs once). Mirror `resolveDefaultImage`'s shape (sandbox-backend.ts:109-111).

- [ ] Steps: failing tests (scripted provider + fake timers: idle session suspends after window; running/queued/gated session never suspends; activity resets the clock; race — submission admitted between check and suspend wins [inject a hook between the re-check and suspend, same style as the attachment epoch tests]; capability-off provider → sweep no-ops entirely; idleMinutes 0 → no interval) → implement → `pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): engine idle sweep hibernates sandboxes after VALET_SANDBOX_IDLE_MINUTES`.

---

### Task 4: API — pause route, status plumbing, gateway-touch wake

**Files:**
- Modify: `packages/api/src/schema/index.ts` + `packages/api/migrations/pg/0000_app.sql` (`agent_sessions.status` enum + `"hibernated"`)
- Modify: `packages/api/src/wire/types.ts` (`SessionStatus` union + `"hibernated"`)
- Modify: `packages/api/src/routes/sessions.ts` (`POST /:id/pause`)
- Modify: `packages/api/src/engine/host.ts` (wire `onHibernate`/`onWake` to the db status writes)
- Modify: `packages/api/src/routes/gateway-proxy.ts` (fire-and-forget `session.attachment.warm()` before returning the 409 `{wake:true}`)
- Test: `packages/api/src/routes/sessions.pause.test.ts`, extend `gateway-proxy.test.ts`

**Interfaces:**
- `POST /api/sessions/:id/pause` (session-access-gated like sandbox-jwt, sessions.ts:243 pattern): 404 non-owner; 409 `{ error: "a turn is running" }` when any unsettled submission has status `"running"` or `"blocked_on_decision_gate"`; otherwise `session.attachment.suspend()` + status → `"hibernated"`, 200 `{ status: "hibernated" }`. 400/409 (pick 409, test pins it) when the provider lacks hibernation capability.
- No explicit resume route (spec decision 4). Wake paths: submission (existing PolicySandbox.dispatch → ensureReady — no change needed), gateway touch (`warm()` before the 409 — attachment.ts:135 is fire-and-forget and now must handle the suspended state by kicking the resume path; verify Task 1 made `warm()` do that), `onWake` → status `"active"`.
- `entryToSession`/`SessionDetail` mappers pass the widened status through; the web already renders status strings (Task 5 styles it).

- [ ] Steps: failing tests (pause happy path incl. provider.suspend called + status row hibernated; 409 mid-turn [seed a running submission]; 404 non-owner; capability-off 409; gateway 409 now also triggers warm — assert provider.resume called eventually with a suspended fake; status flips back to active after wake completes) → implement (schema edit + `rm -rf ~/.valet/pg`) → `pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): manual pause + hibernated status + gateway-touch wake`.

---

### Task 5: Web — pause control + sleeping badge

**Files:**
- Modify: `packages/web/src/components/session/session-header.tsx` (pause button beside delete, sessions-header action row :43-67; `SandboxChip` map entry `suspended: { dot: "bg-neutral-400", label: "sleeping — will wake on message" }`)
- Modify: `packages/web/src/api/` hooks (`usePauseSession(sessionId)` mutation → invalidate session detail)
- Test: extend the session-header component tests

**Interfaces:** consumes `POST /:id/pause` + the `sandbox.status` stream (a `suspended` attachment state now arrives via the existing pipe — stream store needs no change, `SandboxChip` just gains the map entry). Pause button hidden when `session.profile`-agnostic but capability unknown client-side — show it always for owned sessions and surface the 409 error text verbatim on failure (capability-off deployments see the error; acceptable, note in report). Disable the button while `sandbox.state` is not `ready`.

- [ ] Steps: failing component tests (suspended chip renders sleeping label; pause click posts and surfaces 409 text; button disabled while provisioning) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): pause control + sleeping badge`.

---

### Task 6: Exit-criteria dogfood + docs sync

**Files:**
- Modify: `docs/specs/2026-07-15-sandbox-hibernation-warm-pools-design.md` (Status → Stage 1 Implemented + Deviations incl. the in-memory-sweep limitation), `docs/handoff-2026-07-15-engine-v2.md` (queue row #3), `CLAUDE.md` if a durable gotcha emerged
- Test: full battery + live dogfood

- [ ] **Step 1: Full battery** — `pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/store-postgres test && pnpm --filter @valet/sandbox-kubernetes test && pnpm --filter @valet/sandbox-docker test && FORCE_COLOR=0 pnpm --filter @valet/sandbox-local test && pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test` (only the 2 known abort failures).
- [ ] **Step 2: Live dogfood (coordinator, Rancher Desktop k3s, per the spec's exit criteria):** rebuild/redeploy api with `VALET_SANDBOX_IDLE_MINUTES=1`; session + command; wait past window → CR Suspended, pod gone, badge sleeping; send message → pod back on same PVC, pre-hibernation file present, reply arrives; manual pause works, 409 mid-turn; message at the suspend moment is not lost; api restart while hibernated → still hibernated, wakes on message. Record PASS/FAIL + ids in the ledger.
- [ ] **Step 3: Docs + commit** — `docs(specs): sandbox hibernation stage 1 implemented`.

---

## Self-review notes (already applied)

- **Spec coverage:** decision 1 → T1/T2; 2 → T1; 3 → T3 (with the two-callback seam so T3 is testable before T4's schema lands); 4 → T4/T5; 5 → T2 (Suspended→idle) + T4 (status truthfulness); 6 → nothing (deliberate — `shutdownTime` stays out); 7 → nothing to build (pin: pause tests assert no credential/token writes). Exit criteria → T6. Stage 2 → NOT planned (gated).
- **Deviation from the spec's sweep language (record in T6 docs):** the spec says "the engine host's existing periodic sweep cadence (the same place event-retention pruning runs)" — no such cross-session host sweep exists (event pruning is per-session on restore; the 5s Session sweep is per-session, in-memory, claim-armed). T3 CREATES the host-level interval and documents the in-memory-only limitation.
- **`lastActivityAt`:** no such column exists; T1 adds the recompute-from-store `latestActivityAt` store method instead of a new written-on-every-turn column — restart-safe by construction, no hot-path write amplification.
- **Type consistency:** `hibernation: boolean` (required) on `SandboxCapabilities`; `"suspended"` on `AttachmentState`; `"hibernated"` on BOTH the app `agent_sessions.status` enum and wire `SessionStatus` (the engine's own `SessionStatus.hibernated` already exists, unused; T4 does not need to touch engine status).
- **Known softness (flagged for implementers):** `attachment.warm()` must kick the resume path for suspended state (T1 verifies); the k8s client's merge-patch invocation differs across @kubernetes/client-node versions — T2 reads the installed version's API before writing the helper; a Suspended CR's Ready-condition shape should be confirmed live in T2's cluster test rather than assumed.
