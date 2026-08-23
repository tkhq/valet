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
3. **Backpressure: sandbox slots are a bounded per-org resource.** (See
   the backpressure section below.)

## Deviations & notes

- (grows as the implementation lands)
