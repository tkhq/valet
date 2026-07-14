# Engine v2 Local End-to-End — Roadmap

> **For agentic workers:** This is the phase roadmap, not a task plan. Each phase gets its own detailed implementation plan (`docs/plans/2026-07-XX-engine-v2-phase-N-*.md`, written when the phase starts, using superpowers:writing-plans) executed via superpowers:subagent-driven-development. Do not implement from this document alone.

**Goal:** A locally running end-to-end Valet v2: web UI → Node API → engine → Docker sandbox, with a working orchestrator (memory, signals, child sessions), the workflow run host, and a real Telegram channel — all on the post-review spec contracts, surviving kill-the-process-mid-turn.

**Architecture:** The local host topology from the engine spec (Kubernetes shape at N=1): one Node process hosting Hono routes + SessionPool, `SqliteSessionStore` + `SqliteEventStream` authoritative, Docker/local sandboxes in-process under the policy wrapper, leased-worker RunHost in-process, Telegram via long-polling.

**Tech Stack:** TypeScript, Node 22, Hono, better-sqlite3 + Drizzle, `@mariozechner/pi-agent-core` / `pi-ai` (pinned 0.73.0), dockerode, Vite/React 19 (packages/web), grammY or raw Telegram Bot API long-polling.

**Source specs (authoritative):**
- `docs/specs/2026-05-02-portable-runtime-engine-design.md`
- `docs/specs/2026-07-11-workflow-run-host-design.md`
- `docs/specs/2026-07-11-orchestrator-engine-design.md`
- `docs/specs/2026-07-11-sandbox-runtime-v2-design.md`

## Global Constraints

- Pre-1.0 migration policy: edit `0000` migrations in place, regenerate drizzle meta, `rm ~/.valet/app.db` — no numbered migrations until first release.
- No `any`, no double-casts, no `@ts-ignore` (CLAUDE.md type-safety rules).
- Every store/stream/host behavior specified in the specs lands with its conformance-suite test in the same phase (Conformance sections are the definition of done).
- Kill-mid-turn recovery is a local test in every phase that touches execution — not deferred to production hardening.
- The existing greenfield packages (`engine`, `api`, `store-sqlite`, `web`, `sandbox-docker`, `sandbox-local`) are evolved in place; the legacy stack (`worker`, `client`, `runner`) is untouched.

---

## Phase 0 — De-risking spikes (no production code)

**Proves:** the two unverified assumptions the whole design leans on.

1. **pi-agent-core continuation spike**: rehydrate a transcript from SQLite rows (assistant entry with tool_call parts, no result), inject a fabricated ToolResult, drive the continuation turn to completion. This validates the restart-safe gate replay contract against the real library. Also verify: context handoff across providers preserves tool_use validity, and thinking-signature behavior on failover.
2. **Fence-shaped SQLite CAS spike**: express `claimSubmission`, `replaceSubmissionAttempt`, and a fenced `appendEntries` as single-statement conditional writes in better-sqlite3, and demonstrate a zombie-writer rejection under two concurrent connections.

**Exit criteria:** both spikes run as checked-in experiments (`packages/engine/experiments/`), each with a short findings note. A pi-agent-core blocker discovered here changes Phase 1's design, which is why this phase exists.
**Risk retired:** the highest-uncertainty library dependency; the fencing idiom.

## Phase 1 — Durable submission core (store + engine)

**Proves:** accepted work survives anything, on the real store.

- Rewrite `packages/store-sqlite` to the post-review `SessionStore` contract: submission lifecycle methods (admit/claim/replace/markers/leases/settlement), `WriteFence` rejection, `queue_item_id`/`stop_reason` entry columns, `engine_attempt_markers`, `engine_meta` schema-version stamping (fail-loud), owner-principal columns.
- Invert `packages/engine`'s `thread.ts`: store-driven submissions replace the in-memory queue (`collecting`/`queued`/`running`/`blocked`/`terminalizing`/`settled`; steer supersession transactional; collect durable).
- Reconciliation: the 7-step tree, terminalization rest-state repair, resume-path repair, stuck-head attention event (emitted; router lands in Phase 4).
- `awaitResult` on `ThreadHandle` with the linkage-based result resolution.
- Conformance suites: submission lifecycle contract (incl. fence rejection, steer, collect/merge), updated store contract; kill-mid-turn integration test (SIGKILL the process between tool calls; restart; verify reconciliation settles or resumes correctly with no duplicate tool execution).

**Exit criteria:** all suites green; the dogfood script (`make dogfood-api`) runs a real Anthropic turn, is killed mid-turn, restarts, and completes without duplicated side effects.
**Depends on:** Phase 0 findings.

## Phase 2 — Event stream + gates + client resume

**Proves:** the UI experience on the new event plane; approvals survive restarts.

- `SqliteEventStream`: offset-addressed log, `eventKey` idempotent append, per-submission retention, access-control enforcement at the API layer; EventStream conformance suite.
- API/WS: offset-carrying frames, client resume protocol (replay-from-offset then live), deltas live-only; engine owns appends (`onEvent` = post-append tap).
- Decision gates on the new contracts: ordinals, restart-safe replay wired end-to-end (the "not implemented yet" gap closes here), expiry defaults (24h/72h) on the alarm/timer loop, steer withdrawal.
- `packages/web`: resume protocol, gate cards against the new REST/WS shapes, submission-state surfaces (queued/superseded/merged indicators).
- Operator surface: `GET/POST /api/admin/submissions` (list, force-settle).

**Exit criteria:** browser reload mid-stream loses nothing (offset resume, no refetch flash); kill the server while a gate is pending, restart, resolve the gate from the UI, turn completes via replay; conformance suites green.

## Phase 3 — Sandbox attachment + lazy warming

**Proves:** instant agent, background workspace.

- Policy wrapper: epoch tagging, lazy attachment (cold handle, first-op await, `workspace_provisioning` structured error), two-tier cancellation, `sandbox_status` events, cold-attachment model hint.
- `sandbox-docker` under the wrapper; job-mode exec for >60s commands (in-process equivalent of the sandboxd job contract); attachment re-provision with epoch supersession test (simulate a hung container).
- Sandbox provider conformance suite (runs against docker + local + virtual).
- Carried from Phase 2: fenced EventStream appends for live-execution events (spec ~§1198) — deterministic eventKeys protect the re-runnable settlement/gate events today; attempt-fencing the remaining live appends closes the zombie double-emit gap.

**Exit criteria:** a session prompt gets first tokens before the container is running; a 3-minute `sleep && echo` exec completes via job mode; killing the container mid-exec produces a structured retryable tool error and a background re-provision, never a session error.

## Phase 4 — Orchestrator, signals, memory (local)

**Proves:** the product's core loop — a persistent, principal-owned assistant.

- Principal model in `packages/api`'s app schema (clean-slate: users, orgs, teams, `orchestrator_identities`, bindings, notifications, drop log) — fresh v2 tables per the orchestrator spec.
- Signal admission: `SignalContent` end-to-end, engine-stamped sender + hopCount, edge ACL, `signal:{sender}` threads, deterministic settlement dispatchIds.
- Child sessions via `task`: ownership inheritance, concurrency cap, `child.settled` reporting, gate routing through the parent.
- Memory locally: v2 memory tables (owner-tuple + OKF columns), `mem_*` as engine ToolDefs against `toolConfig` endpoints, snapshot injection via `systemContext`, compaction hooks; OKF import (bring a real exported bundle in).
- Attention router + notifications (web only at this phase); stuck-head events route here.
- Limits: per-thread pending cap, org session ceiling, hop budget.

**Exit criteria:** a local orchestrator with imported memory answers instantly sandbox-less, spawns a child coding session in Docker, receives its `child.settled` signal, journals via `mem_patch`, and survives a process restart mid-child-run.

## Phase 5 — Workflow run host (local)

**Proves:** durable structured automation on the same substrate.

- Portable checkpointed interpreter (`driveUntilPark`): wave loop over `dag/v1`, intent/terminal checkpoints, signals with `consumedBy` + atomic consume, park state.
- Local leased-worker RunHost: wake queue, timer scan, lost-wake sweep (≤60s); RunHost + checkpoint + signal conformance suites.
- Workflow→engine integration: idempotent session create, `dispatchId` prompts, `awaitResult` with `resultSchema`, dual-target approvals (workflow signal side).

**Exit criteria:** a workflow that spawns a session, awaits a schema-validated result, waits on an approval, and completes — killed and restarted at three different points (mid-node, parked-on-approval, terminalizing) without duplicate dispatches (asserted via dispatchId capture).

## Phase 6 — Platform: auth + plugin system

**Proves:** the product works for real users with real integrations — not just the local stub.

- Real login/auth replacing `VALET_LOCAL_AUTH` (provider TBD in its own design pass), user/org provisioning on first login, and narrowing the internal-token bypass (ledger carry-item).
- Plugin system v2 per `docs/specs/2026-07-13-plugin-system-v2-design.md`: the `ValetPlugin` manifest, both loaders (bundled registry + dynamic node_modules), the assembler, and the **fleet port** of all action-bearing plugins to engine-native shapes (subagent per plugin, verbatim execute bodies, mocked-fetch tests).
- Credential declarations feeding connect flows (OAuth/api-key UI built against the declarations contract).

**Exit criteria:** log in as a real user; connect one OAuth service and one API-key service through the UI; the orchestrator lists and calls ported plugin actions via `list_tools`/`call_tool` with per-user credentials; a plugin dropped into node_modules loads on restart without a rebuild; a deliberately broken plugin quarantines without killing boot.

## Phase 7 — Telegram channel (local, long-polling)

**Proves:** the full product loop with a real external surface.

- Implemented as the **first v2 channel plugin** (`plugin-telegram/src/transport/` per the plugin-system spec; legacy `src/channels/` untouched for the worker; payload helpers lifted verbatim).
- Telegram transport implementing the engine ChannelTransport contract: long-polling ingress (no public webhook), conversationKey codec (`telegram:v1:...`), signal admission with `dispatchId = update_id`, outbound send, gate delivery with inline buttons, gate updates on resolution.
- Binding + identity-link flows in the API/web (link Telegram account, DM binding auto-created); drop log for unlinked actors; per-binding throttle.
- Gate hygiene: minimized bodies, explicitly-addressed free-text resolution.

**Exit criteria:** from a phone: DM the bot → linked orchestrator responds; ask it to do repo work → child session spawns; approve its PR-creation gate from a Telegram button; kill the server between the gate delivery and the button press; restart; the button press still resolves and the child finishes.

---

## Sequencing notes

- Phases 1→2→3 are strictly ordered (each builds on the previous's contracts). Phase 4 needs 1–3. Phase 5 needs 1–2 (not 3/4). Phase 6 (platform) needs 4; Phase 7 (Telegram) needs 4 + 6 (it ships as a v2 channel plugin over the plugin framework). Ordering decided 2026-07-13: 5 → 6 → 7.
- [2026-07-13] Phases resequenced: the original Phase 6 (Telegram) moved to Phase 7, behind a new platform phase (auth + plugin system, spec: `docs/specs/2026-07-13-plugin-system-v2-design.md`), so Telegram lands as a plugin rather than bespoke wiring. An assistant-centered web-UI detour (spec: `docs/specs/2026-07-13-assistant-centered-web-ui-design.md`) shipped between Phases 4 and 5.
- Each phase = one detailed plan + one PR-sized review gate; the conformance suites added in early phases run in CI for all later phases.
- The 0000 migrations are regenerated once at the start of Phase 1 (engine schema) and once at Phase 4 (app schema); dev databases are dropped at both points.
