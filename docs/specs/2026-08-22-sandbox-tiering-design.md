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
   `SandboxProvider`. A `create()` admits only while the org's live count
   (ready attachments in the host cache + the gate's
   admitted-but-not-yet-ready creates) is under
   `VALET_ORG_SANDBOX_CEILING` (default 25; `<= 0` disables). Over the
   ceiling the create WAITS — logged, and measured by the
   `valet.sandbox.capacity_wait{outcome}` histogram — up to
   `VALET_SANDBOX_CAPACITY_WAIT_MINUTES` (default 10; `0` fails fast),
   then fails terminally (`SandboxStartupError`) naming the ceiling and
   the corrective action. The gate counts its own in-flight admissions
   separately from cache state, so a fan-out burst cannot deadlock on
   its own `provisioning` attachments. Org resolution rides the host
   cache (`sessionOrgId`); creates with no resolvable org (conformance
   tests, tooling) admit ungated and fall under the reconcile sweep's
   unowned report.

## Deviations & notes

- Capacity-gate scope, v1: the count is one process's view (host cache +
  local in-flight set) — sandboxes surviving a restart re-count only as
  their sessions re-cache, and a multi-replica api would need a shared
  count. Fan-out bursts are in-process, so this covers the incident
  class. `resume()` (hibernation wake) is not gated; admission order
  among waiters is poll-based, not FIFO. There is also a bounded
  over-admit window (≤1 per concurrent create, milliseconds) between a
  create resolving and its attachment reaching `ready`.
- The wait is visible to operators (log + metric) and to the user as the
  eventual terminal error; a dedicated "waiting for sandbox capacity"
  wire state for the session UI and the workflow run timeline is
  deferred until the web client grows a surface for it.
