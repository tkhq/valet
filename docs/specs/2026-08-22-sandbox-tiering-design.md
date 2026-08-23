# Sandbox tiering layer 2 — Tier 0 sessions, stranded-idle hibernation, capacity backpressure

## Context

Layer 1 (`2026-08-22-sandbox-lifecycle-design.md`, PR #393) gave every
sandbox a teardown owner. This layer shrinks what gets provisioned at all
and bounds what one org can hold concurrently. It implements the incident
review's recommendations A (execution tiers, the Tier-0 slice) and D.5
(backpressure), plus a stranded-session bug the layer-1 deploy exposed.
Per-run and per-user shared sandboxes (recommendations B/C) are NOT here —
they conflict with the gateway's per-session JWT rule and need their own
design.

## Decisions

1. **Tier 0 rides the existing lazy-attachment contract.** The engine
   already provisions on first sandbox touch (`PolicySandbox.dispatch` →
   `ensureReady`); the only eager trigger is the warm-on-claim kick at
   turn start, which orchestrator/assistant sessions already disable.
   Workflow sessions now set `warmSandboxOnClaim: false` too
   (`EngineHost.buildWorkflowSession`). A session-node turn that only
   calls the LLM and api-side plugin actions provisions nothing — the
   saturation incident's triage workflow (slack read + LLM, 11-way
   foreach) would have created ZERO pods. Static tier derivation from
   tool grants was rejected: every session carries bash/read/write
   built-ins, so grants over-approximate; first-touch is the truth.
   Interactive user sessions and children keep warm-on-claim — their
   turns usually touch the filesystem, and warming overlaps the LLM
   call.
2. **Stranded idle sessions hibernate through a DB-driven sweep.**
   `EngineHost.runIdleSweep` walks the host cache only, and an api
   restart evicts idle sessions while their pods keep running (by
   design). Boot-restore only re-caches sessions with unsettled work, so
   an idle session from before a restart sat `status='active'` with a
   pod forever — the reaper only reaps `hibernated` rows. Observed on
   agents-dev (2026-08-22): 32 assistant sessions idle for days, each
   holding a pod. `IdleHibernationSweep`
   (`packages/api/src/engine/idle-hibernation-sweep.ts`, 5-minute
   interval, same `VALET_SANDBOX_IDLE_MINUTES` window) sweeps `active`
   rows that are uncached, past the idle window on the engine activity
   clock, and free of unsettled work: provider-level suspend (no live
   attachment exists) + the same guarded `writeHibernated` flip the
   cache sweep's hook uses. The deployed HibernationReaper then owns the
   destroy after retention; reopening wakes through the normal
   hibernated path. Auto-repair is justified under the CLAUDE.md rule:
   the violation is expected in normal operation (every restart strands
   whatever was idle at that moment), and this sweep is that window's
   named owner. Kubernetes-only in effect (gated on hibernation
   capability + derivable sandbox ids).
3. **Backpressure: sandbox slots are a bounded per-org resource.**
   `withSandboxCapacityGate`
   (`packages/api/src/engine/gated-sandbox-provider.ts`) wraps the built
   `SandboxProvider`. A `create()` admits only while the org's
   occupied-slot count is under `VALET_ORG_SANDBOX_CEILING` (default 25;
   `<= 0` disables). Counting (redesigned in review): occupied = cached
   attachments in `provisioning`/`ready` MINUS the sessions currently
   parked at the gate — their attachments already read `provisioning`
   while they hold no pod, and subtracting them is what keeps a burst
   from deadlocking against itself. An admitted create therefore stays
   counted through `provider.create` AND the post-create prep window
   (clone, steps) until the attachment leaves `ready` — a live pod is
   never invisible to the count (the first design freed its slot at
   create-resolve and over-admitted through long preps). Over the
   ceiling the create WAITS — logged, and measured by the
   `valet.sandbox.capacity_wait{outcome}` histogram — up to
   `VALET_SANDBOX_CAPACITY_WAIT_MINUTES` (default 10; `0` fails fast),
   then fails terminally (`SandboxStartupError`) naming the ceiling and
   the corrective action. A waiter whose session is destroyed abandons
   its create instead of consuming the next freed slot. Org resolution
   rides the host cache (`sessionOrgId`); creates with no resolvable org
   (conformance tests, tooling) admit ungated and fall under the
   reconcile sweep's unowned report.

## Deviations & notes

- Capacity-gate scope, v1: the count is one process's cache view —
  sandboxes surviving a restart re-count only as their sessions
  re-cache, and a multi-replica api would need a shared count. Fan-out
  bursts are in-process, so this covers the incident class. `resume()`
  (hibernation wake) is not gated; admission order among waiters is
  poll-based, not FIFO. A gated tool call also outlives the attachment
  waiter timeout (60s): the turn fails retryably ("still provisioning")
  while the create keeps waiting, and the eventual admit serves the
  retry — scheduler-level parking of over-ceiling workflow NODES (the
  cleaner surface) is deferred to the layer-3 design.
- The wait is visible to operators (log + metric) and to the user as the
  eventual terminal error; a dedicated "waiting for sandbox capacity"
  wire state for the session UI and the workflow run timeline is
  deferred until the web client grows a surface for it.
- Stranded-sweep races, reviewed: the unsettled/liveness re-check sits
  immediately before the suspend (nothing awaits between), and liveness
  includes mid-build sessions (`sessionLiveOrBuilding` covers the host's
  inflight map). The residual window is milliseconds; a wake that loses
  it recovers through the attachment failure path (one failed tool op →
  re-provision resumes the CR → the ready transition heals the row).
  Sessions that never touch their sandbox again get their row healed at
  build time instead: `trackHibernationWake` now fires `onWake` on every
  build into the cache, so a hibernated row flips back to `active` even
  for chat-only wakes with no `ready` transition.
- `mintSandboxEnv` still mints creds/tokens eagerly at workflow session
  build, though Tier-0 sessions may never provision — wasted
  `sandbox_tokens` writes per fan-out item. Making the sandbox env lazy
  (minted at first provision) is deferred; the tokens are revoked at run
  settle by the reclaimer, so the exposure is run-scoped.
- The interval shell the lifecycle spec flagged as copy-debt is now
  extracted (`lib/sweep-timer.ts`, overlap-guarded) and used by all four
  DB-driven sweeps. The per-session destroy/race ritual remains
  duplicated across the reaper/child watcher/reclaimer — still the
  named follow-up before a sixth sweep.
