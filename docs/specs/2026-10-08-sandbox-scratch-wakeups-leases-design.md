# Sandbox scratch storage, wakeups, and leases

Date: 2026-10-08. Status: proposed.

Depends on: `2026-09-03-sandbox-workspace-fit-design.md` (workspace claim
sizing), `2026-09-04-prebuild-sandbox-resources-design.md` (cpu/memory
resources and their four sources), `2026-09-10-sandbox-storage-eviction-design.md`
(ephemeral-storage request and limit), `2026-07-15-sandbox-hibernation-warm-pools-design.md`
(idle hibernation).

## Problem

A user needs 500Gi to 1Ti of disk per sandbox for formal verification. A
run takes one to two days. The data is working state: the user accepts
that it is gone when the sandbox stops.

The current model cannot serve this:

1. One EBS gp3 volume per sandbox holds home state, the repo checkout, and
   all build output. EBS bills on provisioned size, never shrinks, resizes
   once per 6 hours, and has the same baseline speed at 1Gi and 1Ti.
2. The reactive grow path doubles the claim after ENOSPC. From 1Gi to 1Ti
   is 10 doublings, about 60 hours. It is a silent repair of a sizing miss,
   which the repo's invariant rule forbids.
3. The node-local ephemeral-storage limit (30Gi) evicts the pod. A prover
   that writes to `/tmp` or `~/.opam` hits this limit long before the
   volume fills.
4. A `bash` call dies at its timeout, maximum 1 hour. Nothing durable keeps
   a sandbox awake across turns. The idle sweep suspends the session after
   30 minutes without queue activity. An api restart drops the in-memory
   `pendingJobCount`.
5. `cluster-autoscaler` runs with `skip-nodes-with-local-storage=false` and
   `scale-down-unneeded-time=10m`. It drains a lightly loaded node under a
   long run. No sandbox pod carries `safe-to-evict: "false"`.

Repo-declared `workspaceStorage` reaches children through
`resolveRepoPrebuildFlags`, so the `task` tool needs no storage argument
for the persistent claim. It needs one for scratch, which does not exist.

## Thesis

Split storage into three classes with different lifetimes, and split "keep
this sandbox busy" into two durable concepts:

- A **wakeup** is a persisted row that produces a signal for a thread when
  its condition holds. Kinds: `process`, `watch`, `timer`. Later specs add
  `event` and `schedule` on the same table.
- A **lease** is a persisted row that keeps a sandbox out of idle
  suspension and off the autoscaler's eviction list until a deadline. A
  lease costs node hours, so it always has an owner and a deadline.

A `process` or `watch` wakeup owns a lease for its lifetime. A `hold` is a
bare lease. A `timer` never holds a lease: the session hibernates while it
waits, and the signal wakes the thread.

This mirrors the Claude Code harness (`Bash run_in_background`, `Monitor`,
`ScheduleWakeup`, `CronCreate`, `TaskStop`). It adds two things the
harness never needed: durability across api restarts, and liveness of a
sandbox that can hibernate.

## Requirement language

MUST, MUST NOT, SHOULD, and MAY follow RFC 2119. A sentence without one of
these words is informative.

## Terminology

One name for one thing. Synonyms in code or prose are defects.

- **workspace claim**: the persistent `/workspace` PVC. Sized at create
  from `workspaceStorage`. Survives hibernation.
- **scratch**: the node-local emptyDir at `/scratch`, sized by the
  `scratch` resource. Wiped when the pod stops.
- **home seed**: the directories `valet-home-init` copies from the image
  into the workspace claim (`HOME_DIRECTORIES`).
- **wakeup**: a row in `wakeups`. Produces one or more signals for a
  thread. Kinds: `process`, `watch`, `timer`.
- **sandbox process**: a `process` wakeup's detached process group inside
  the sandbox. In prose always "sandbox process", never "job". The word
  "job" stays reserved for Kubernetes `Job` and the existing bash job-mode
  exec path.
- **lease**: a row in `leases`. Owner kinds: `process`, `watch`, `hold`.
- **WakeWatcher**: the api-side sweep that evaluates wakeups and leases.
- **signal**: a `SignalContent` submission (`kind: "signal"`) to a thread.
- **fire**: the moment a wakeup produces a signal.
- **release**: the moment a lease stops holding.

## Acceptance scenario (normative)

The single run that means "it works". The implementation ships an
integration test that performs every step from a clean database.

Universe: org `acme`, user `u-001`, repo `acme/lean-proofs` with this
`.valet/prebuild.yaml`:

```yaml
resources:
  cpu: 12
  memory: "48Gi"
  scratch: "800Gi"
workspaceStorage: "20Gi"
```

Deploy values: `scratchMax: 1Ti`, `scratchAgentMax: 100Gi`,
`leaseMaxHours: 72`, `workspaceStorageMax: 128Gi`, idle 30 minutes.

| Step | Action | Expected observation |
|---|---|---|
| 1 | Create a session on `acme/lean-proofs`. | Sandbox CR has `ephemeral-storage` request `802Gi`, limit `830Gi`, an emptyDir `scratch` with `sizeLimit: 800Gi` at `/scratch`, env `TMPDIR=/scratch/tmp`, workspace claim `20Gi`. |
| 2 | Agent calls `bash { command: "lake build", background: true, deadline_hours: 48, reason: "full proof build" }`. | Result text contains `started sandbox process wk_…`. A `wakeups` row (`process`, `running`) and a `leases` row (owner `process`, deadline now+48h) exist. The pod carries `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` within 60s. |
| 3 | The turn ends. 45 minutes pass with no queue activity. | The session is still `active`. The pod is still Running. |
| 4 | The api restarts. | Within 60s of boot the WakeWatcher re-adopts the row. No signal is emitted. The pod is unchanged. |
| 5 | Agent calls `process_read { id, offset: 0, bytes: 4096 }` in a later turn. | Returns the first 4096 bytes of the log and `nextOffset`. |
| 6 | The sandbox process exits with code 0 after 31 hours. | Within 60s the thread receives one `process.exited` signal with `cause=exit`, `exitCode=0`, body = last 4096 bytes of the log. The lease is released. The pod annotation is removed within 60s. |
| 7 | The agent's signal turn ends. 30 minutes pass. | The session is suspended by the idle sweep. `/scratch` is gone. `/workspace` persists. |
| 8 | Agent calls `wake_at { after_seconds: 7200, prompt: "Check the proof report" }` in a new turn, then the turn ends. | A `wakeups` row (`timer`, `pending`) exists. No `leases` row exists. The session hibernates after 30 minutes. |
| 9 | Two hours pass. | The thread receives one `timer.fired` signal whose body is `Check the proof report`. The sandbox is resumed only when a tool in that turn needs it. |
| 10 | Agent calls `task { prompt, resources: { scratch: "200Gi" } }`. | Result text is the refusal in A4 naming `scratchAgentMax`. No child is created. |

Pass criterion: all ten steps, in one run, from a clean start.

## Part A: Scratch tier

### A1. Resource shape and sources

`scratch` is a fourth sandbox resource beside `cpu`, `memory`, and the
deploy-only ephemeral knobs. It is a Kubernetes quantity string, for
example `"800Gi"`.

- `PrebuildResources` widens to `Pick<SandboxResources, "cpu" | "memory" | "scratch">`.
- `RESOURCE_FIELDS` in `resolve-repo-resources.ts` becomes
  `["cpu", "memory", "scratch"]`. The preservation mask covers all three.
- The four sources are the same as cpu/memory, in the same authority
  order: `task.resources.scratch` > `.valet/prebuild.yaml`
  `resources.scratch` > saved repo defaults (`image_sources.sandbox_resources`)
  > none. There is no deploy-wide default scratch.
- `scratch` MUST travel through `resolveRepoPrebuildFlags` and
  `applySandboxResourceOverrides`. It MUST NOT take the `workspaceStorage`
  path, which the spec provider overwrites at run start (`attachment.ts`,
  `desired.workspaceStorage`). This is the TKAI-385 trap: a field that is
  set in one builder and overwritten in another.
- The REST create route and the sources PATCH route accept
  `resources.scratch` with the same validation as `memory`.

### A2. Pod manifest (kubernetes provider)

When `resources.scratch` is set, `buildSandboxCR` MUST:

1. Add volume `scratch` as `emptyDir: { sizeLimit: <scratch> }`.
2. Mount it at `/scratch` on the sandbox container.
3. Set container env `TMPDIR=/scratch/tmp`.
4. Set `ephemeral-storage` request to `scratch + ephemeralStorageRequest`
   and limit to `scratch + ephemeralStorageLimit`. When a deploy knob is
   disabled (`"0"`), that term is `0`. The sum is formatted with
   `formatStorageQuantity`.

The start scripts (`start-full.sh`, `start-headless.sh`) create
`/scratch/tmp` with mode `1777` when `/scratch` exists.

When `resources.scratch` is absent the manifest is byte-identical to today.

`scratch` is an authoritative resource field. A change to it on an existing
CR follows the cpu/memory rule (pod recreation at a run-start window),
with the lease exception in C5.

### A3. Lifetime contract

`/scratch` lives as long as the pod. Hibernation, a resource change, an
image change, a crash, and destroy all wipe it. The system prompt and the
`bash` tool description state this and name `/workspace` as the place for
anything to keep.

The api MUST NOT copy, snapshot, or restore `/scratch`.

### A4. Limits and refusals

| Knob | Env | Chart value | Default |
|---|---|---|---|
| Deploy cap | `VALET_SANDBOX_SCRATCH_MAX` | `sandbox.scratchMax` | `0` (scratch disabled) |
| Agent cap | `VALET_SANDBOX_SCRATCH_AGENT_MAX` | `sandbox.scratchAgentMax` | `100Gi` |

One validation function, `validateScratchRequest(quantity, source, caps)`,
serves all four sources. It MUST refuse and MUST NOT clamp. The refusal
text is normative:

- Not a quantity, or below `1Gi`:
  `scratch "<value>" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".`
- Scratch disabled (`scratchMax` is `0`):
  `scratch is not enabled on this deployment. Ask an admin to set sandbox.scratchMax.`
- Over the deploy cap:
  `scratch <value> exceeds the <cap> deploy cap (sandbox.scratchMax). Request at most <cap>, or ask an admin to raise the cap.`
- From `task` and over the agent cap:
  `scratch <value> exceeds the <cap> agent cap (sandbox.scratchAgentMax). Retry without resources.scratch, declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.`

Where the refusal lands:

- `task`: the tool result, prefixed `[task_resources]`. No child row is
  written.
- REST create and sources PATCH: HTTP 400 with the text.
- prebuild.yaml: the session's startup warnings, and the sandbox is
  created without scratch. A repo file MUST NOT block a session; the
  warning names the file.

The scheduler failure `Insufficient ephemeral-storage` already maps to an
actionable error. That text gains `(scratch <value>)` when scratch is set.

### A5. Other backends

- docker: `/scratch` is a per-sandbox host directory bind mount, deleted on
  destroy. No size limit. The create result carries the warning
  `scratch is not size-limited on the docker backend.`
- local and virtual: `/scratch` is a plain directory. Same warning.

### A6. Metrics

- `valet_sandbox_scratch_requested_bytes` gauge, labels `session_class`.
- `valet_sandbox_scratch_refused_total` counter, labels `source`, `reason`.

## Part B: Wakeups

### B1. Table and store contract

`wakeups` is an engine table (`SessionStore`, both store implementations,
the shared conformance suite). Pre-1.0 rule: edit `0000_engine.sql`, add
the `SCHEMA_REPAIRS` entry, do not bump `ENGINE_SCHEMA_VERSION`.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `wk_` + 20 base32 chars |
| `session_id` | text | |
| `thread_id` | text | the thread that receives signals |
| `kind` | text | `process` \| `watch` \| `timer` |
| `status` | text | `pending` \| `running` \| `done` \| `cancelled` \| `expired` \| `lost` |
| `reason` | text | human-visible; for `timer` the first 80 chars of `prompt` |
| `command` | text null | `process`, `watch` |
| `prompt` | text null | `timer` |
| `exec_id` | text null | the in-sandbox handle |
| `lease_id` | text null | `process`, `watch` |
| `fire_at` | bigint null | `timer` |
| `deadline_at` | bigint null | `process`, `watch` |
| `exit_code` | int null | |
| `cause` | text null | terminal cause, see B6 |
| `log_offset` | bigint | `watch`: bytes already turned into events |
| `log_tail` | text | the last 4 KB of the log, NUL replaced; default `''` |
| `event_count` | int | `watch` |
| `created_at`, `updated_at`, `ended_at` | bigint | ms |
| `origin_json` | text null | the channel origin of the creating turn |
| `window_start_at` | bigint null | `watch`: start of the rate window |
| `window_count` | int null | `watch`: polls with new output in the window |
| `watch_buffer` | text null | `watch`: lines read but not yet sent; `''` when empty |
| `last_emit_at` | bigint null | `watch`: when the last `watch.event` went out |

Store methods: `createWakeup`, `createWakeupWithLease(wakeup, lease)` (both
rows in one transaction), `getWakeup`, `listWakeups(sessionId, statuses?)`,
`listDueWakeups(now, limit, after?)`, `countWakeupsByKindAndStatus(statuses)`,
`transitionWakeup(id, from[], to, patch, updatedAt)` (a single-statement CAS
that returns the row only when `from` matched), and
`transitionWakeupAndReleaseLease(id, from[], to, patch, updatedAt, cause)`
(the same CAS and the release of the row's lease in one statement).

`listDueWakeups` returns `{ rows, next }`. `rows` holds the running and
pending `process`/`watch` rows and the pending `timer` rows with
`fire_at <= now`, in `(created_at, id)` order, and skips an unreadable row.
`next` is the keyset cursor of the last row the page read, readable or
not, or null when the page read fewer than `limit` rows. A caller pages on
`next`, so it reads every due row.

### B2. Kinds

**process**: a detached command in the sandbox. Owns a lease. Fires once,
on exit or on a terminal cause.

**watch**: a detached command whose stdout lines become events. Owns a
lease. Fires `watch.event` per poll with new lines, and `watch.exited` once.

**timer**: fires `timer.fired` once at `fire_at`. Holds no lease.

### B3. Tools

All tools are engine builtins. They reach the store through a new
`ToolContext.wakeups` seam the host injects, shaped like `requestDecision`:
`{ create, get, list, cancel, readLog }`. A session without the seam
returns `[wakeups_unavailable] this session cannot schedule wakeups.`

`bash` gains three optional fields:

```
bash { command, timeout?, background?: boolean, deadline_hours?: number, reason?: string }
```

- `background: true` requires `deadline_hours` (1 to `leaseMaxHours`) and
  `reason` (1 to 200 chars). Missing either returns
  `[bash_background] Set deadline_hours (1 to <max>) and reason when background is true.`
- The call starts the sandbox process, writes the `wakeups` row and the
  lease, and returns within the normal exec round trip:
  `started sandbox process <id> (deadline <ISO>). You will receive a process.exited signal. Read its log with process_read.`
- `timeout` is ignored when `background` is true.
- The foreground timeout text becomes:
  `[timed out after <n>s] For work longer than an hour, rerun with background: true and a deadline_hours.`
- A foreground command whose text matches `^\s*sleep\s+(\d+)` with a value
  over 300 is refused:
  `[bash_sleep] Use wake_at to pause for more than 5 minutes.`

New tools:

| Tool | Parameters | Returns |
|---|---|---|
| `watch` | `command`, `reason`, `max_hours` (1 to `leaseMaxHours`) | `started watch <id> …` |
| `wake_at` | one of `at` (ISO 8601) or `after_seconds` (60 to `timerMaxHours*3600`); `prompt` (1 to 4000 chars) | `scheduled wakeup <id> at <ISO>` |
| `hold_sandbox` | `hours` (1 to `leaseMaxHours`), `reason` | `holding sandbox until <ISO> (lease <id>)` |
| `process_read` | `id`, `offset?` (default 0), `bytes?` (default 4096, max 65536) | `{ text, nextOffset, eof }` rendered as text |
| `wakeup_list` | none | one line per non-terminal wakeup and lease: id, kind, reason, state, deadline |
| `wakeup_cancel` | `id` (wakeup id or lease id) | `cancelled <id>` |

`process_read` on a `watch` returns the raw log. `wakeup_cancel` on a
`process` or `watch` kills the group and releases its lease with
`cancelled`. On a `timer` it sets the row `cancelled`. On a `hold` it
releases the lease with `cancelled`. Nothing is deleted.

The kill is best-effort. It uses the session's ready sandbox, or a
restored handle for the lease's sandbox. It never provisions compute, and
a failed kill does not block the cancel. An agent cancel records
`valet_wakeups_total{cause="cancelled"}`.

`wakeup_cancel` on the lease id of a `process` or `watch` is refused,
because the wakeup would keep running with no lease:
`[wakeup_cancel] <lease id> belongs to <kind> <wakeup id>. Cancel <wakeup id> instead; that stops the <kind> and releases this lease.`

Ownership: the seam accepts only ids of its own session. `process_read`,
`wakeup_cancel`, and `get` treat an id from another session as unknown and
return the unknown-id text.

Per-session cap: when a session has `wakeupsPerSession` or more
non-terminal wakeups and active hold leases combined, every create tool
refuses (a process or watch lease counts through its wakeup):
`[wakeups_limit] This session already has <n> active wakeups and leases (limit <cap>, sandbox.wakeupsPerSession). Cancel one with wakeup_cancel.`

The system prompt gains one paragraph: background work is reported by
signal; do not poll it; `/scratch` is wiped when the sandbox stops.

### B4. In-sandbox protocol

`process` and `watch` reuse the job-mode exec protocol
(`packages/sandbox-kubernetes/src/jobs.ts`, `packages/sandbox-docker/src/sandbox.ts`):
`setsid`, combined stdout and stderr to `<dir>/<execId>.out`, exit code to
`<execId>.exit`, group pid to `<execId>.pid`.

Changes:

- `<dir>` is `/scratch/valet-jobs` when `/scratch` exists, else
  `/tmp/valet-jobs`.
- The `.out` file is not capped for `process` and `watch`. The existing
  `maxOutputBytes` cap stays for foreground job-mode bash.
- `execJob` gains `{ uncapped: true }`.
- `pollJob(execId, offset, { maxBytes?, tail? })` bounds each read.
  Without `tail` it reads forward at most `maxBytes` and reports
  `running` while bytes remain past the cap. With `tail` it returns only
  the last `maxBytes` before the end of the log and sets `nextOffset` to
  the end. `process_read` passes its `bytes`. The WakeWatcher reads a
  `process` with `{ maxBytes: 4096, tail: true }` and a `watch` with
  `{ maxBytes: 65536 }`. A watch line that fills a whole read becomes one
  event, so a long line cannot stall the watch.
- The kubernetes poll reads the status before the output. With no
  `.exit`, it checks `kill -0 -<pid>`. A dead group, rechecked after one
  second for a late `.exit`, reports `dead`, which maps to `failed` with
  no exit code (`cause=pid_missing`).
- At container start, the image start scripts write `<execId>.dead` for
  each `/scratch/valet-jobs/<execId>.pid` with no `.exit`. A container
  restart killed those jobs, and a new process can reuse the pid. The
  poll reports `dead` for a job with this marker.

A provider that lacks `execJob` returns `[bash_background] this sandbox backend cannot run background processes.`

### B5. WakeWatcher

An api sweep (`packages/api/src/engine/wake-watcher.ts`), DB-driven like
`ChildWatcher`, interval 30s, started in `main.ts`, with the
sandbox provider and the pod patch api injected.

Each tick reads every due row in pages of 200. It stops at a short page.
For each due row:

| Kind | Probe | Transition |
|---|---|---|
| `process`, `watch` | exec `test -f .exit && cat .exit; kill -0 -<pid>` | `.exit` present → `done`, `cause=exit`, `exit_code` |
| | | no `.exit`, pid dead → `lost`, `cause=pid_missing` |
| | | exec fails `SandboxUnavailableError` → `lost`, `cause=sandbox_unavailable` |
| | | sandbox gone (CR not found, lease released, session deleted) → `lost`, `cause=sandbox_unavailable` |
| | | `now >= deadline_at` → kill group, `expired`, `cause=deadline` |
| | | probe fails for another reason → no change before `deadline_at`; at or past it → `expired`, `cause=deadline` |
| `watch` | plus `tail -c +<log_offset>` | new lines → one `watch.event` signal per tick, max 200 lines; advance `log_offset`, add to `event_count` |
| `timer` | none | `fire_at <= now` → `done`, `cause=fired` |

The decision is a pure function:

```
decideWakeup(now, row, probe) → { to: Status, cause?: Cause, signals: SignalDraft[] } | null
```

No I/O and no clock inside. Vectors in the testing section run against it.

Order per transition: (1) CAS `transitionWakeup`; (2) on success, release
the lease if any; (3) submit the signal(s). A crash between (1) and (3)
loses at most one signal; the row is terminal, so the signal is never
duplicated. The `thread_id` target MUST exist; when the thread is gone, the
signal goes to the session's main thread.

Restart: the watcher reads due rows from the table. Nothing is held in
memory between ticks.

Rate: a `watch` whose `event_count` grows by more than
`VALET_WATCH_MAX_EVENTS_PER_HOUR` (default 120) in a rolling hour is
expired with `cause=rate`. The `watch.exited` body names the limit.

### B6. Signals

All signals use `tagName: "wakeup"`. Attributes are flat strings. Every
signal carries `wakeupId`, `kind`, and `reason`.

| Signal | When | Body | Extra attributes |
|---|---|---|---|
| `process.exited` | terminal `process` | last 4096 bytes of the log | `cause` (`exit` \| `deadline` \| `cancelled` \| `pid_missing` \| `sandbox_unavailable`), `exitCode` when `exit`, `durationSeconds`, `logPath` |
| `watch.event` | new lines | the new lines, joined by `\n` | `lineCount`, `eventCount` |
| `watch.exited` | terminal `watch` | last 4096 bytes | same as `process.exited`, plus `rate` as a cause |
| `timer.fired` | `fire_at` reached | the `prompt` | `scheduledAt`, `firedAt` |
| `lease.expired` | a `hold` lease passes its deadline | `Hold "<reason>" expired at <ISO>.` | `leaseId` |

A wakeup the agent cancelled emits no signal. A wakeup a human cancelled
from the UI emits its terminal signal with `cause=cancelled`.

## Part C: Leases

### C1. Table

`leases` is an engine table, same rules as B1.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `ls_` + 20 base32 chars |
| `session_id` | text | |
| `sandbox_id` | text null | filled when known |
| `owner_kind` | text | `process` \| `watch` \| `hold` |
| `owner_id` | text null | wakeup id; null for `hold` |
| `reason` | text | |
| `created_at` | bigint | |
| `deadline_at` | bigint | NOT NULL |
| `released_at` | bigint null | |
| `release_cause` | text null | `owner_ended` \| `cancelled` \| `deadline` |
| `thread_id` | text null | the thread that created it; `lease.expired` goes there |
| `origin_json` | text null | the channel origin of the creating turn |

Store methods: `createLease`, `releaseLease(id, cause, releasedAt)` (CAS on
`released_at IS NULL`), `getLease(id)` (released or not),
`listActiveLeases(sessionId)`, `listAllActiveLeases()`,
`countActiveLeases(sessionId)`, and `setLeaseSandboxId(id, sandboxId)`
(fills a missing sandbox id on an active lease).

### C2. Owners

- A `process` or `watch` wakeup creates its lease in the same store
  transaction as its own row. Its terminal transition releases the lease
  with `owner_ended`, `cancelled`, or `deadline`.
- `hold_sandbox` creates a lease with no owner row. The WakeWatcher
  releases it at `deadline_at` with `deadline` and emits `lease.expired`.
- `deadline_at` MUST be at most `created_at + leaseMaxHours`.
- Session delete ends the session's background work.
  `SessionStore.deleteSession` moves its `pending` and `running` wakeups
  to `lost` with `cause=sandbox_unavailable` and releases its active leases
  with `owner_ended`, in the same transaction as the delete. No signal is
  sent: the session is gone.

### C3. Idle predicate

Both idle authorities add one predicate: a session with
`countActiveLeases(sessionId) > 0` is not idle.

- `EngineHost.maybeSuspendIdleSession` (in-memory sweep).
- `IdleHibernationSweep.sweep` (DB sweep).

The in-memory `pendingJobCount` check stays for foreground job-mode bash.

### C4. Child settle

A child session with an active lease is not settled. `ChildWatcher` MUST
NOT emit `child.settled` while `countActiveLeases(childSessionId) > 0`.
The child's 24h retention clock starts at its settle, as today. So the
clock starts after the last lease releases and after the turn that handles
the terminal signal ends.

### C5. Pod eviction

For every sandbox with at least one active lease, the pod MUST carry
`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` and the label
`valet.dev/leased: "true"`. The WakeWatcher reconciles this each tick:

1. For each sandbox that `listAllActiveLeases()` names, patch the pod when
   the annotation is absent.
2. List pods with the label. For each with zero active leases, remove the
   annotation and the label.

The patch is idempotent. The chart RBAC gains `pods: patch` in the sandbox
namespace.

A resource change (A2) or image change MUST NOT recreate the pod of a
leased sandbox. The attachment defers the change to the next run-start
window after the last lease releases, and logs the deferral.

### C6. Expiry

The WakeWatcher and `wakeup_cancel` are the only releasers of leases. A
lease that is active past `deadline_at` for more than 2 ticks is an
invariant violation (INV-6): it raises `valet_leases_over_deadline` and
pages. The WakeWatcher's lease pass then ends the open owner as
`expired/deadline` and counts it in `valet_leases_orphan_released_total`
with `reason=deadline` (Deviations, A3). No other code path releases it.

## Part D: Policy and limits

| Knob | Env | Chart value | Default |
|---|---|---|---|
| Scratch deploy cap | `VALET_SANDBOX_SCRATCH_MAX` | `sandbox.scratchMax` | `0` |
| Scratch agent cap | `VALET_SANDBOX_SCRATCH_AGENT_MAX` | `sandbox.scratchAgentMax` | `100Gi` |
| Lease max | `VALET_LEASE_MAX_HOURS` | `sandbox.leaseMaxHours` | `72` |
| Timer max | `VALET_TIMER_MAX_HOURS` | `sandbox.timerMaxHours` | `720` |
| Wakeups per session | `VALET_WAKEUPS_PER_SESSION` | `sandbox.wakeupsPerSession` | `20` |
| Watch event rate | `VALET_WATCH_MAX_EVENTS_PER_HOUR` | `sandbox.watchMaxEventsPerHour` | `120` |

Every refusal names the knob. There is no org storage budget in this spec;
scratch cost is node hours, which the lease gauges measure (Part G). A
budget is a follow-up on the same gauges.

Authority: a human declaration (prebuild.yaml, create route, Settings) is
bounded by the deploy cap. An agent request (`task`) is bounded by the
agent cap. The agent cap MUST be at most the deploy cap; boot fails loud
otherwise, like the existing workspace default/max check.

## Part E: Workspace claim: retire reactive growth

1. Remove `growWorkspace` from the bash ENOSPC hook (`policy.ts`) and from
   workspace prep (`workspace-prep.ts`). ENOSPC on `/workspace` returns:
   `[valet] The workspace volume (<size>) is full. Write build output to /scratch, or declare a larger workspaceStorage in .valet/prebuild.yaml. Free space in /workspace before retrying.`
2. Keep the adoption grow in `provider.create` (TKAI-402). It converges an
   existing claim up to a raised declaration. This is an expected case in
   normal operation; the comment at the call site names this reason.
3. `resolveWorkspaceStorageRequest` MUST refuse a request over
   `workspaceStorageMax` and MUST NOT clamp. The refusal is a
   `SandboxStartupError`:
   `workspaceStorage <value> exceeds the <cap> cap (sandbox.workspaceStorageMax). Lower the declaration in .valet/prebuild.yaml, or ask an admin to raise the cap.`
4. Usage sampling: at settle and at hibernate, the host runs
   `df -B1 --output=used,size /workspace /scratch` and records
   `valet_sandbox_volume_used_bytes{volume}` and
   `valet_sandbox_volume_size_bytes{volume}` with the repo label. The
   session page shows both volumes as `used / size`.
5. Home seed: `HOME_DIRECTORIES` drops `.cache`, `.cargo`, `.rustup`,
   `.npm`, `go`, `.gradle`, `.m2`. They stay in image layers. The
   `valet-home-init` script and `persistentHomeMounts` follow the list.
   `HOME_LAYOUT_VERSION` becomes `"3"` so existing claims migrate once. The
   image-floor lift (TKAI-538) stays in this spec.

## Part F: Infra (test-agents-infra, separate PR)

1. Node group `scratch`: `instance_types = ["m7gd.4xlarge", "m7gd.8xlarge"]`,
   `AL2023_ARM_64_STANDARD`, nodeadm `instance.localStorage.strategy: RAID0`,
   `min_size 0`, `max_size 2`, on-demand, untainted, the shared DinD
   cloud-init, and the ASG tag
   `k8s.io/cluster-autoscaler/node-template/resources/ephemeral-storage` at
   the NVMe size minus 50Gi reserve.
2. Chart RBAC: `pods: patch` in the sandbox namespace. `Chart.yaml` version
   bump.
3. agents-dev values: `scratchMax: 1Ti`, `scratchAgentMax: 100Gi`,
   `leaseMaxHours: 72`.
4. Alerts: the INV-6 page is the counter
   `valet_leases_orphan_released_total{reason="deadline"}` (Part G). The
   gauge is non-zero for one pass only, because the same pass repairs the
   lease, so `valet_leases_over_deadline > 0` for 5m fires only when the
   repair itself keeps failing. Also:
   `valet_leases_unannotated > 0` for 5m; `increase(valet_wakeups_total{cause="rate"}[1h]) > 3`.
   The existing `SandboxPodUnschedulable` covers a scratch pod that no
   node fits. Fleet scratch: `valet_sandbox_scratch_live_bytes > 4Ti` for
   10m. Size the threshold to the scratch pool's total local disk.
5. Keep `scratchMax: "0"` until the scratch node pool exists. A small
   scratch request otherwise lands on a node's 100Gi gp3 root volume. Heavy
   writes there saturate the volume, which made a node NotReady through
   PLEG on 2026-08-28. Set `sandbox.scratchPoolReady: true` when the pool
   exists. Until then, the api logs a WARNING at boot when `scratchMax` is
   above `0`.
6. Keep `jobLogMaxBytes` below `scratchMax` and below the scratch a repo
   declares. Job logs live on `/scratch` and count against its size. The
   api fails at boot when `jobLogMaxBytes` exceeds a non-zero `scratchMax`.

## Part G: Observability

| Metric | Type | Labels |
|---|---|---|
| `valet_wakeups_total` | counter | `kind`, `cause` |
| `valet_wakeups_active` | gauge | `kind` |
| `valet_leases_active` | gauge | `owner_kind` |
| `valet_leases_node_seconds_total` | counter | `owner_kind` |
| `valet_leases_over_deadline` | gauge | |
| `valet_leases_unannotated` | gauge | pods with a lease and no `safe-to-evict` annotation at the last reconcile |
| `valet_sandbox_scratch_requested_bytes` | gauge | `session_class` |
| `valet_sandbox_scratch_refused_total` | counter | `source`, `reason` |
| `valet_sandbox_scratch_live_bytes` | gauge | declared `/scratch` summed over running sandboxes, set by the reconcile sweep |
| `valet_sandbox_volume_used_bytes`, `_size_bytes` | gauge | `volume`, `repo` |
| `valet_wakeups_sweep_ok_at_seconds` | gauge | Unix time of the last finished WakeWatcher pass, or of the watcher start |
| `valet_wakeups_sweep_failed_total` | counter | |
| `valet_wakeups_signal_lost_total` | counter | `kind` |
| `valet_wakeups_bad_rows_total` | counter | `table` |
| `valet_leases_orphan_released_total` | counter | `owner_kind`, `reason` (`missing_owner`, `terminal_owner`, `deadline`) |
| `valet_jobs_logs_pruned_total` | counter | |
| `valet_jobs_docker_output_dropped_total` | counter | |

Example alert rules. The OTel Prometheus export appends the unit, so the
`valet.wakeups.sweep_ok_at` gauge (unit `s`) exports as
`valet_wakeups_sweep_ok_at_seconds`.

OTel creates a counter series at its first value, so `increase()` alone
misses the first event of each label set. Each counter rule adds the
series that did not exist one window ago, the pattern in
`deploy/chart/valet/alerts/prebuild.yaml`.

```
time() - valet_wakeups_sweep_ok_at_seconds > 300 or absent(valet_wakeups_sweep_ok_at_seconds)
valet_leases_over_deadline > 0                                     for 5m
(sum(increase(valet_leases_orphan_released_total{reason="deadline"}[1h])) or vector(0))
  + (sum(valet_leases_orphan_released_total{reason="deadline"}
      unless valet_leases_orphan_released_total{reason="deadline"} offset 1h) or vector(0)) > 0
(sum(increase(valet_wakeups_bad_rows_total[1h])) or vector(0))
  + (sum(valet_wakeups_bad_rows_total unless valet_wakeups_bad_rows_total offset 1h) or vector(0)) > 0
(sum(increase(valet_wakeups_signal_lost_total[1h])) or vector(0))
  + (sum(valet_wakeups_signal_lost_total unless valet_wakeups_signal_lost_total offset 1h) or vector(0)) > 0
```

UI: a wakeups strip on the session page lists active wakeups and leases
(kind, reason, elapsed, deadline, cancel). A signal turn that produced no
message and no tool call renders collapsed, the way quiet ticks collapse in
the Claude Code harness.

## Invariants

Each invariant names its enforcing mechanism. Review is never the
mechanism.

- **INV-1 Every lease has an owner kind, a reason, and a deadline.**
  Mechanism: NOT NULL columns; the wakeups seam refuses a lease longer than
  `leaseMaxHours` before it calls `createLease` (the stores take no limits
  configuration). Vector: insert with a 100h deadline under a 72h max is refused.
- **INV-2 A session with an active lease is never idle-suspended.**
  Mechanism: both sweep predicates call `countActiveLeases`. Vector: each
  sweep against a fake store with one lease skips the suspend.
- **INV-3 A pod with an active lease carries `safe-to-evict: "false"`.**
  Mechanism: WakeWatcher reconcile each tick. Metric:
  `valet_leases_unannotated` counts mismatches found by the reconcile.
- **INV-4 A scratch request never exceeds its cap, and is never clamped.**
  Mechanism: one `validateScratchRequest` function on every source; the
  manifest builder takes the validated value only. Vector per source.
- **INV-5 A wakeup reaches a terminal status once and emits at most one
  terminal signal.** Mechanism: `transitionWakeup` is a single-statement
  CAS. The watcher submits the signal only after the CAS returns the row.
- **INV-6 Only the WakeWatcher and `wakeup_cancel` release a lease.**
  Mechanism: `packages/api/src/engine/lease-releasers.test.ts` greps every
  package's `src` for `releaseLease(` and fails on a file outside the
  WakeWatcher, the wakeups seam, and the stores. `valet_leases_over_deadline`
  pages. Session delete also releases leases, inside the store (C2).
- **INV-7 A timer never creates a lease.** Mechanism: the lease insert is
  reachable only from `process`, `watch`, and `hold_sandbox` code paths;
  vector: `wake_at` leaves `leases` empty.
- **INV-8 A leased sandbox's pod is never recreated by a spec change.**
  Mechanism: the attachment's run-start reconcile checks
  `countActiveLeases` before a pod-replacing change. A cold attachment
  (api restart, cache eviction) adopts compute in `provider.create`, so it
  checks the lease first and passes `preserveLivePod: true`. The
  kubernetes provider then keeps the live pod and its CR template and
  skips every roll. Docker keeps the container on its image. The attachment
  records the live image and resources, so the change still reads as
  drift and lands after the last lease releases.
- **INV-9 The workspace claim never shrinks and is never silently clamped.**
  Mechanism: existing never-shrink rule in `resolveWorkspaceStorageRequest`;
  Part E item 3 replaces the clamp with a refusal. Vector: a 200Gi
  declaration under a 128Gi cap fails create with the Part E text.
- **INV-10 `decideWakeup` is deterministic.** Mechanism: pure function with
  `now` injected; vectors compare its output byte for byte.

## Testing

Unit (vitest):

- `validateScratchRequest`: each refusal text in A4, for each source.
- `buildSandboxCR`: the A2 mounts, env, sums; byte-identical output when
  scratch is absent; sums with each ephemeral knob disabled.
- `resolveRepoPrebuildFlags` and `applySandboxResourceOverrides` carry
  `scratch` from each of the four sources with the preservation mask.
- `decideWakeup` vectors (normative, in `packages/api/src/engine/wake-watcher.vectors.json`).
  Each vector is `(now, row, probe) → expected`:
  - running process, `.exit=0` → `done`, `exit`.
  - running process, no `.exit`, pid dead → `lost`, `pid_missing`.
  - running process, sandbox unavailable → `lost`, `sandbox_unavailable`.
  - running process, deadline passed → `expired`, `deadline`.
  - running watch, 3 new lines → one `watch.event`, offset advanced.
  - running watch, over rate → `expired`, `rate`.
  - pending timer, due → `done`, `fired`.
  - pending timer before `fire_at` → `null`.
- Idle sweeps (INV-2), `ChildWatcher` settle hold (C4), pod reconcile
  (C5) against fakes.
- `bash` background validation and the sleep refusal; every tool's
  refusal text.

Store conformance (`in-memory-store`, `store-postgres`): `wakeups` and
`leases` CRUD, `listDueWakeups`, CAS semantics of `transitionWakeup` and
`releaseLease` under two concurrent callers.

Integration (api suite): acceptance steps 2, 4, 6, 8, 9, 10 with a virtual
sandbox provider and a fake clock.

e2e (`make e2e`): a docker-backend `process` that outlives a 60s bash
timeout and delivers `process.exited`; `/scratch` present on the docker
backend with the A5 warning. The sandbox-k8s suite asserts the CR
ephemeral sums and the pod annotation after `hold_sandbox`.

Manual on agents-dev before the chart change merges:

1. One session with `scratch: "500Gi"` lands on the `scratch` pool.
2. A 2h `sleep` background process survives an api rollout.
3. The session page shows both volumes.

## Non-goals (normative boundary)

A v1 implementation MUST NOT ship these under this spec's label.

| Excluded | Why | Re-entry seam |
|---|---|---|
| `event` and `schedule` wakeup kinds | They touch the events pipeline and need their own policy pass (per-session subscription target, cron expiry rules). | `wakeups.kind`; `event_subscriptions.target` gains `{ kind: "session", sessionId, threadId }`. |
| Org-level storage or node-hour budget | Scratch cost is node hours; no evidence yet of fleet-wide overrun. | `valet_leases_node_seconds_total` by org; a refusal in `createLease`. |
| Snapshot-on-hibernate for the workspace claim | Separate project; changes billing and resume latency. | `SandboxProvider.suspend` and `resume`. |
| Running long work as a Kubernetes `Job` | Loses interactive access to live state. | A `process` kind variant with an external runner. |
| Per-user persistent home | Different ownership model. | `persistentHomeMounts`. |
| Removing the image-floor lift (TKAI-538) | Needs a bake survey after the home-seed trim. | `liftWorkspaceStorageToImageFloor`. |
| Size-limited `/scratch` on the docker backend | Dev only. | `sandbox-docker` create opts. |

## Rollout order

1. Engine: tables, store contract, conformance suite, `decideWakeup`,
   tools, `ToolContext.wakeups` seam. No behavior change until the host
   injects the seam.
2. api: WakeWatcher, idle predicates, `ChildWatcher` settle hold,
   `resolveRepoPrebuildFlags` scratch, routes, `SCHEMA_REPAIRS`.
3. sandbox-kubernetes: manifest, pod patch api, `execJob` uncapped.
   sandbox-docker: `/scratch` bind, uncapped job output.
4. Chart: values, RBAC, `Chart.yaml` bump. Infra PR: `scratch` node group,
   alerts, agents-dev values.
5. Part E: remove reactive growth, refusal over cap, usage sampling, home
   seed trim with layout version 3.
6. Web: wakeups strip, volume usage, collapsed quiet turns.

Steps 1 to 4 unblock the user. Step 5 and 6 follow in the same release.

## Deviations

Implementation gaps become errata to this file in the same PR.

- **B5, signal delivery failure.** The WakeWatcher submits a signal once,
  after the CAS. If the submit throws, the watcher logs the error with the
  wakeup id and does not retry. The row already moved, so the signal is
  lost. The watcher records `valet.wakeups.signal_lost{kind}` and logs the
  error. `valet.wakeups.total` keeps its closed cause set and has no
  `delivery_failed` cause. A failed `lease.expired` delivery is also
  logged, counted with `kind=hold`, and not retried.
- **B5, kill before CAS.** B5 lists the CAS first. The watcher runs the
  best-effort kill (`cancelJob`) before the CAS, so a lost CAS can still
  kill a process. The kill is a no-op on a process that already ended.
- **B5, lease release failure.** If `releaseLease` throws after the CAS,
  the watcher logs the error, then still delivers the signals and records
  `valet.wakeups.total`. The lease stays active and
  `valet_leases_over_deadline` pages after its deadline.
- **B5, restart durability on docker.** Durable wakeups survive an api
  restart only on kubernetes. The docker provider (the `make dev-local`
  default) keeps job state in memory on each sandbox handle. After a
  restart, or for a session that is not cached, `restore()` returns a new
  handle with no job state. Every running `process` or `watch` wakeup then
  ends `lost` with `cause=pid_missing`. A slow tick can also see
  `pid_missing` after docker evicts a finished job. The kubernetes path is
  not affected, because its job state lives in the pod.
- **B5, probe failures.** Four errors mean the sandbox is gone:
  `SandboxUnavailableError`, `SandboxSupersededError`, the kubernetes
  pod-gone error, and the kubernetes `restore()` miss (`Sandbox CR "<id>"
  not found`). Any other exec error is a probe `error`. Before `deadline_at` the row stays
  unchanged for the next tick. At or past it the row expires with
  `cause=deadline`, so a probe that always fails cannot keep a row and
  its lease alive. The watcher treats a row as unavailable when its lease
  is released or its session row is gone.
- **B5 and C5, lease sandbox id.** A lease created before its attachment
  knew the sandbox id has no `sandbox_id`. The WakeWatcher resolves it
  from the live attachment or the session row and writes it back with
  `SessionStore.setLeaseSandboxId`. This gap occurs in normal operation,
  so the backfill is not a silent repair.
- **C5, reconcile shape.** The watcher calls
  `SandboxProvider.setEvictionProtection(id, true)` for each leased sandbox
  each tick. The provider reports `changed` when the pod lacked the
  annotation. A change on a sandbox whose oldest lease is older than two
  ticks counts toward `valet_leases_unannotated`. So do a failed patch and
  a lease older than two ticks whose sandbox id stays unknown. Providers without the
  seam (docker, local) skip the reconcile.
- **Acceptance, test coverage.** The integration test
  `wakeups-acceptance.test.ts` runs steps 2, 4, 6, 8, 9, and 10. It uses a
  scripted virtual sandbox and drives the WakeWatcher clock by hand. Steps 1, 3, 5, and 7 need a kubernetes pod or the idle
  clock. Their unit suites cover them, so no single run covers all ten.
- **A1 and Part D, create route.** The REST session create route does not
  accept `resources` today, cpu and memory included. `scratch` on create
  waits for the plan that adds `resources` to that route. Spec A1 bullet 5
  and the Part D create route row describe that future state.
- **A5, backends without scratch.** The `local` and `virtual` backends mount
  nothing for scratch and emit the A5 warning through `console.warn`. A
  host filesystem `/scratch` is not a sandbox path. The docker backend also
  warns through `console.warn`, because its create path has no warnings
  channel.
- **A5, docker scratch dir.** Docker stores `scratchHostDir` in its
  inventory record, so a destroy after an api restart still deletes the
  host dir. Docker creates the dir and then sets mode `0o777` with
  `chmod`, because the process umask masks the `mkdir` mode. So the sandbox user
  can write to it.
- **B5, docker job output.** Docker keeps detached output in api memory
  with the existing job state. It writes no log file to disk. This is
  acceptable for the dev backend. See the restart durability entry above.
- **C5, pod summary shape.** `PodSummary` exposes `annotations` and
  `labels` as flat fields, to match its existing flat shape. It has no
  `metadata` object.
- **B1, engine ids subpath.** `newWakeupId` and `newLeaseId` live behind the
  `@valet/engine/wakeups-ids` subpath. They use `node:crypto`, and a
  browser loads the engine barrel, so the barrel cannot import it.
- **B3, `wakeup_list` leases.** `wakeup_list` prints hold leases only. A
  process or watch lease appears through its wakeup line, so the list does
  not show it twice.
- **B3, `process_read` refusals.** `process_read` refuses an unknown id, a
  timer id, and a backend without `pollJob`. Each refusal text starts with
  `[process_read]` and names the next step.
- **Part D, agent cap off.** `VALET_SANDBOX_SCRATCH_AGENT_MAX="0"` sets no
  agent cap. Only the deploy cap then bounds `task.resources.scratch`.
- **C4, child settle grace.** The WakeWatcher releases a lease before it
  submits the terminal signal. After the last lease releases, `ChildWatcher`
  waits a bounded grace window (`leaseSettleGraceMs`, default 90 seconds).
  The engine then admits the signal turn before the child settles.
- **B5 and B6, watch log tail.** `watch` carries `logTail` across ticks,
  the same as `process`. The rate-expiry signal body names the limit that
  the watch exceeded.
- **B5, probe before deadline.** `decideWakeup` reads the probe status
  before it checks the deadline. A process that already exited ends
  `done` with `cause=exit`, even when the tick runs after its deadline.
- **A2, kubernetes adoption.** The kubernetes provider's legacy "preserve
  cpu and memory" adopt branch does not roll the pod when only `scratch`
  changes. A follow-up fixes this (Task 10 ruling).
- **A2, scratch on adoption.** The sandbox-kubernetes `preserveCpuMemory`
  adoption helper ignores `scratch`. Adoption does not keep a live scratch
  value.
- **B4, docker read bounds.** Docker keeps job output as an in-memory
  string. Its offsets and `maxBytes` count UTF-16 code units. The
  kubernetes provider counts bytes. The `local` and `virtual`
  backends ignore the bounds; `process_read` cuts their output to `bytes`.
- **B4, dead detection on docker.** Docker holds the job's child process,
  so it sees an exit directly and needs no `kill -0` check.
- **C2 and INV-6, session delete.** `deleteSession` releases leases with
  its own SQL inside the store. It does not call `releaseLease`. The INV-6
  grep test allows the stores for this reason.
- **C4, settle result.** After a lease wait, `child.settled` carries the
  result of the last turn the ChildWatcher awaited. That is the turn that
  handled the terminal signal. A superseded turn does not replace the
  result.
- **A4 and Part G, REST scratch refusal.** A REST session has no parent
  to receive a startup warning. When its `.valet/prebuild.yaml` scratch
  request is dropped, the host writes the warning once as a `system`
  entry on the session's default thread. The session page shows it; the
  model does not see `system` entries. When a later reconcile finds a
  refusal, the host only logs it.
- **Part G, scratch requested gauge.** `valet_sandbox_scratch_requested_bytes`
  uses `session_class` `repo` for an accepted `.valet/prebuild.yaml`
  request and `task` for an accepted `task` request.
- **B: A2, scratch on adoption.** This entry supersedes the two A2 entries
  above. An adopt keeps the live fingerprint when the preserve mask names
  every resource field, in any order. A legacy CR without a fingerprint
  keeps none. When the mask names `scratch`, the adopt keeps the live
  scratch state. That state is the emptyDir size, the mount, `TMPDIR`, the
  scratch init container, and the ephemeral-storage values. A failed
  repository read therefore no longer deletes a live `/scratch`.
- **B: A2, fingerprint back-compat.** The resource fingerprint gets a
  scratch slot only when scratch is set. A CR without scratch keeps its
  pre-scratch hash, so the upgrade does not roll every pod.
- **B: A4, Pending grace.** The 10-minute Pending grace runs from the
  pod's own creation time. A resumed CR is older than its new pod, so the
  CR's age no longer applies. A pod with no creation time uses the start of
  the readiness wait. A `TriggeredScaleUp` event in the last 10 minutes
  keeps the pod retryable until the pod is 30 minutes old. A later
  `NotTriggerScaleUp` or `FailedScaleUp` event ends that deferral.
- **B: A3, scratch bootstrap.** A scratch pod gets a `valet-scratch-init`
  init container. It creates `/scratch/tmp` and `/scratch/valet-jobs` with
  mode 1777, whatever the image. The start scripts and the plain-headless
  command still create both directories. Mode 1777 lets the `dockerd`
  workload user write job logs.
- **B: A4, capacity error text.** When the shortage is ephemeral-storage
  and the pod has scratch, the error adds `(scratch <value>)`. It lists the
  ephemeral-storage request with cpu and memory. It tells the user to lower
  `resources.scratch` in `.valet/prebuild.yaml` or `task.resources.scratch`.
  It also names the admin option: a node pool with enough local disk.
- **B: A4, refusal texts and the REST warning.** This entry supersedes the
  REST entry above. The disabled and deploy-cap refusals tell the reader to
  set `sandbox.scratchMax` in the Valet chart, an admin task. The agent-cap
  refusal keeps the `.valet/prebuild.yaml` advice. The host writes a REST
  warning on the thread that `SessionMeta.warningThreadKey` names. Without
  it, the warning goes on `web:default`. No route sets `warningThreadKey`
  yet. The coding system prompt also carries the warning, so the model
  knows that `/scratch` is absent.
- **B: Part D, knob ranges.** The integer knobs accept plain digits only.
  Hours run from 1 to 8760, `VALET_WAKEUPS_PER_SESSION` from 1 to 1000, and
  `VALET_WATCH_MAX_EVENTS_PER_HOUR` from 1 to 100000. Any other value
  stops the api at boot with a message that names the variable and the range.
- **B: C5, pod read.** `setEvictionProtection` reads only the pods that
  carry the sandbox's `valet.dev/session-id` label.

Fix wave 2, group A (durability core). Where an entry below conflicts
with an earlier entry, the entry below wins.

- **B4, exec ids.** An exec id is `job-<base36 epoch ms>-<8 random
  base36>` (`newExecId` in `@valet/engine/wakeups-ids`). Job files live as
  long as the pod, and a per-handle counter let a later handle reuse a
  live job's files after an api restart. `EXEC_ID_PATTERN` accepts
  `[a-z0-9]` runs joined by single dashes, so a legacy `job-3` still
  passes. `ExecOpts.execId` lets a caller ask for an id it already stored.
- **B4, kickoff refusal.** The kubernetes kickoff exits 17 when any of
  `<id>.out`, `.pid`, `.exit`, or `.dead` exists, before it truncates
  anything. `execJobInPod` turns that exit into an error that names the
  id. `cancelJob` skips the kill when `.exit` or `.dead` exists, because
  the recorded pid may now belong to another group.
- **C2, atomic writes.** The store gains `createWakeupWithLease` (one
  transaction) and `transitionWakeupAndReleaseLease` (one statement: the
  CAS and the release of the row's `lease_id`). A lost CAS releases
  nothing. This supersedes the "B5, lease release failure" entry: a CAS
  and its release now commit together.
- **B5, start order.** The seam writes the wakeup as `pending` with a
  pre-generated exec id, and its lease, before it starts the job. It then
  moves the row to `running`. A failed start ends the row `lost` with
  `cause=pid_missing` and kills the requested id. `listDueWakeups` also
  returns `pending` process and watch rows. The WakeWatcher ends one that
  is older than 15 minutes as `lost`, `cause=pid_missing`, kills the
  requested id, and sends `process.exited` or `watch.exited`. The grace
  covers a start that includes a cold sandbox provision, so it is longer
  than one tick. If that happens first, the seam stops the started job and
  refuses with a text that tells the agent to run the command again.
- **B5, kill after CAS.** The watcher and `wakeup_cancel` kill a process
  group only after their CAS succeeds. A lost CAS kills nothing. This
  supersedes the "B5, kill before CAS" entry.
- **C6, crash-window lease release.** Each tick, the WakeWatcher releases
  a process or watch lease whose wakeup row is missing or terminal, or
  that is two ticks past its deadline, with `release_cause=deadline`.
  Crash windows occur in normal operation, so CLAUDE.md permits this
  repair. `valet.leases.orphan_released{owner_kind}` counts each release.
  C6 and INV-6 therefore name a third release path inside the WakeWatcher.
- **C4, settle on facts.** `ChildWatcher` waits while a lease is active,
  bounded at the latest lease deadline plus one poll. Past the bound it
  logs, records `valet.leases.settle_over_deadline`, and settles. It also
  waits while a timer is pending and fires inside the retention window
  (24 hours when no window is set). Then it awaits the terminal signal
  turn (`wakeup:<id>:terminal`) of each wakeup that ended after the
  watched submission was admitted, whether or not a lease was ever seen.
  It waits at most `leaseSettleGraceMs` after the wakeup ended for that
  turn to be admitted. An agent cancel sends no signal and owes no turn.
  This supersedes the "C4, child settle grace" entry.
- **B5, watch rate.** The limit counts `watch.event` signals. A tick emits
  at most one, whatever its line count. `window_start_at` and `window_count` on the row
  hold the count. The window starts at the first signal after the
  previous window ends, so it is an hour long but not a sliding hour.
  `event_count` and the `eventCount` attribute count signals. The
  rate-expiry body keeps the log tail and then names the limit.
- **B5, last lines.** When a watch exits, its final lines become one last
  `watch.event` before `watch.exited`.
- **B4, log cap.** The provider caps a detached job's log, which replaces
  the "not capped" bullet in B4. `VALET_JOB_LOG_MAX_BYTES` (a byte count or a quantity such as `2Gi`,
  default 2 GiB) reaches the provider through `ExecOpts.maxOutputBytes`.
  Kubernetes caps `.out` with `head -c`. Docker keeps at most 64 MiB in
  api memory per detached job. Only the first 16 MiB streams live, so a
  docker watch sees no new lines past that point until the job exits.
- **B4, docker offsets and job state.** Docker offsets and `maxBytes` now
  count UTF-8 bytes, the same as kubernetes. A read never splits a
  codepoint. A terminal poll of a detached job keeps its state, so the
  watcher and `process_read` do not consume each other's reads. The state
  goes 5 minutes after the first terminal poll, 60 minutes after exit when
  nobody polls it, or at `cancelJob`. This supersedes the "B4, docker read
  bounds" entry.
- **B4, offsets past invalid bytes.** The decision kernel advances a watch
  offset by `nextOffset` minus the bytes it held back, in the provider's
  units. A replacement character for one invalid byte no longer moves the
  offset past unread bytes. NUL in a log becomes U+FFFD before any store
  write or signal, because Postgres `text` rejects NUL.
- **B5, sandbox gone.** `SandboxEvictedError` and the new
  `SandboxGoneError` (docker `restore` throws it for an unavailable,
  missing, or stopped container) count as a gone sandbox. This extends
  the "B5, probe failures" entry.
- **B5, shutdown.** `WakeWatcher.stop()` resolves when the pass in flight
  ends, and `main.ts` awaits it before it evicts the session cache.
- **B6, origin and threads.** `engine_wakeups` and `engine_leases` gain a
  nullable `origin_json`, and `engine_leases` gains a nullable
  `thread_id`. Every signal carries the stored origin with
  `reply: "manual"`. `lease.expired` goes to the lease's thread. Its
  attributes are `leaseId`, `reason`, `ownerKind`, and `expiredAt`; it has
  no `wakeupId` or `kind`.
- **B6, logPath.** `process.exited` and `watch.exited` carry `logPath`
  only when the WakeWatcher has `jobLogDir`, which the host sets for a
  provider that writes job log files. Docker writes none.
- **B3, tools.** The per-session cap counts per thread: the thread's
  pending and running wakeups and its holds. `wakeup_list` shows the
  thread's rows and one line that counts the other threads' rows.
  `process_read` gains `tail`. It reads through the raw sandbox handle or
  a restored one, never the policy sandbox, so it never wakes compute. A
  stopped sandbox gives `[process_read] the sandbox is not running; the
  log is gone with it.` `hold_sandbox` refuses when the session has no
  sandbox. The start texts name `process_read { id, tail: true }`.
- **B3, texts.** `[wakeups_unavailable]` ends with `Run the work in the
  foreground.` A foreground timeout suggests a larger timeout. After 60
  seconds or more it also names background mode with `deadline_hours`
  and `reason`.
- **C2, session delete.** `deleteSession` deletes the session's wakeup
  and lease rows in its transaction, after it counts each open wakeup in
  `valet.wakeups.total{cause="sandbox_unavailable"}`. The rows held the
  command, the prompt, and a log tail.
- **Part G, metrics.** Label keys are `owner_kind` and `session_class`.
  `valet.wakeups.active` comes from a store count over `pending` and
  `running`, so a timer that is not due counts. `node_seconds` uses the
  real time since the previous pass. New: `valet.wakeups.sweep_ok_at`
  (unix seconds of the last finished pass), `valet.wakeups.sweep_failed`,
  `valet.wakeups.bad_rows{table}` (a row that does not parse is skipped
  and counted, never thrown), `valet.leases.orphan_released{owner_kind}`,
  and `valet.leases.settle_over_deadline`. A lease with no sandbox to
  protect no longer counts toward `valet_leases_unannotated`.
- **C: B6, human cancel.** `cancelWorkAsHuman` in `wakeups-admin.ts`
  calls the seam's own cancel, then submits the terminal signal with
  `cause=cancelled` and `cancelledBy=user:<id>` to the wakeup's thread
  (the main thread when that thread is gone). A process or watch sends
  `process.exited` or `watch.exited`; the body says a person stopped it
  and keeps the stored log tail. A timer sends the new type
  `timer.cancelled`, so the agent does not read the cancel as its prompt.
  A hold sends the new type `lease.released`. A process or watch
  lease id resolves to its wakeup. A lost CAS sends nothing, because the
  WakeWatcher's own signal stands.
- **C: routes.** `GET /api/sessions/:id/wakeups` lists open wakeups and
  active leases with no command and no exec id. `POST
  /api/sessions/:id/wakeups/:wakeupId/cancel` is a human cancel. The list
  needs view access; the cancel needs `canCancelSessionWakeup`, which is
  the pause rule (`canAdministerSession`). On a team session both hide
  work on threads the caller cannot see.
- **C: pause and replace.** Both return 409 while
  `countActiveLeases > 0`, with the text `This session has active
  background work: <wakeup or hold id> "<reason>" (deadline <ISO>). Ask
  the agent to cancel it, or send force=true to stop it.` With
  `force=true` (query or JSON body) they cancel the leased work (process,
  watch, hold) as a human cancel, stop the sandbox, and only then submit
  the signals. Timers keep their schedule, because they do not use the
  sandbox. The response names the cancelled ids in `cancelledWork`.
- **C: thread archive.** Archive cancels the thread's wakeups and holds
  as a human cancel with no signal. The thread is hidden, and the main
  thread of a team session can belong to other people, so no thread is
  a safe target. A caller who may not cancel gets a 409 that names the
  action, as for a pending approval.
- **C: owner move.** A move cancels every open wakeup and hold before the
  owner write, with no signal, because a signal turn would run as the new
  owner. The response carries `cancelledWorkCount`. The engine store is
  outside the app database transaction, so the cancel runs just before
  the owner write.
- **C: web.** A wakeup signal card shows the reason, a cause or exit
  badge (danger unless `exit 0`), the run time, and the log in a `<pre>`
  block. The wire does not ship the envelope tag, so the card keys on the
  signal type prefix and a `wakeupId` or `leaseId` attribute. A
  background `bash` card shows the reason and the deadline. The session
  header shows `N background · next deadline in …` with a list and a
  Cancel per row for session admins.
- **C: startup warning thread.** The prompt route passes the target
  thread's key as `warningThreadKey`, so a scratch warning from that
  build lands on that thread. The create route targets the default
  thread, which is already the fallback.
- **B3: A2, adopt records scratch.** The provider's override record and its
  `valet.dev/resource-overrides` annotation now carry `scratch`. A
  preserve-all adopt records the live emptyDir size. The provider fills a
  record from the live template when an older annotation lacks scratch
  (`resourceOverridesWithLiveScratch`). A preserved scratch also goes
  into the attachment's create options for a later re-create. Wave 4
  removed the applied-file fallback; see "B4: applied file is not a
  scratch source".
- **B3: A3, applied-state loss on a container restart.** A container
  restart deletes `/etc/valet/applied.json` and keeps the pod and
  `/scratch`. When the read finds no file inside an epoch the attachment
  already observed, it keeps the recorded resources and re-runs every
  step. It logs the event, because a restart (an OOM kill) can happen in
  normal operation. The file stays on the rootfs, so it still dies
  with the pod.
- **B3: B4, scratch setup on every start.** On each container start, the
  start prefix of a scratch pod creates the scratch directories and
  links `/tmp/valet-jobs`. It also writes `.dead` for each job with no exit
  code. This works whatever the image. The init container cannot make the link,
  because `/tmp` is on the workload container's rootfs. A scratch-less
  pod keeps its old prefix byte for byte. The start-script code stays.
- **B3: A2, sticky scratch root and root temp dir.** The init container,
  the start prefix, and the start scripts set the `/scratch` root to
  1777. They remove a symlink that stands in place of a scratch directory,
  and they never write `.dead` through a symlink. A new
  `/scratch/tmp-root` (0700) is the temp dir for root services. The start
  scripts export `TMPDIR=/scratch/tmp-root` when root owns it. The
  workload user keeps `/scratch/tmp`. A root api exec (the privileged
  path and every exec without docker) exports `TMPDIR=/scratch/tmp-root`
  when that directory exists (`ROOT_TMPDIR_PREFIX` in `exec.ts`).
- **B3: A4, scratch quantity form.** Valet accepts a scratch request only
  as whole bytes or with a `Ki`, `Mi`, `Gi`, or `Ti` suffix. The value reaches the
  emptyDir `sizeLimit` verbatim, and the CRD rejects some forms the parser
  accepts.
- **B3: A4, Pending text.** The terminal Pending text names the pod's real
  Pending minutes. A scale-up deferral can push it to 30.
- **B3: A6, fleet scratch gauge.** The reconcile sweep sets
  `valet.sandbox.scratch.live_bytes` each pass from the kubernetes
  listing (running CRs only). It is for an alert (Part F). Nothing caps
  the fleet total, because a cap would refuse work the per-request caps
  already allow.
- **B3: Part D, boot-time job log cap.** The api resolves
  `VALET_JOB_LOG_MAX_BYTES` once at boot and passes it to every wakeups
  seam as `jobLogMaxBytes`. New knobs: `VALET_WATCH_MIN_INTERVAL_MS` (default
  120000, in `WakeupLimits.watchMinIntervalMs`) and
  `VALET_SANDBOX_SCRATCH_POOL_READY`. The host passes `scratchEnabled` to
  the coding prompt builder.
- **C3: one background-work rule.** Pause, replace, a profile change of
  a running sandbox, an owner move, and a thread archive share
  `gateBackgroundWork` (`routes/wakeups.ts`). It supersedes the "C: pause
  and replace", "C: thread archive", and "C: owner move" bullets. The 409
  body is `BackgroundWorkConflict`: the text names each visible item by
  reason, kind, and deadline (no ids), and says to cancel it first or
  retry with `force=true`. `work` lists the visible items with ids.
  Pause, replace, and profile select process, watch, and hold work; move
  and archive also select timers.
- **C3: team visibility.** The text and `work` name only work on threads
  the caller can see (`keepVisibleThreads`). Hidden work is counted
  (`hiddenCount`) with no reasons. `force` is refused (409,
  `forceAllowed: false`) while hidden work exists, so a forced action never
  stops work on a private thread, and `cancelledWork` never echoes a hidden
  id. A caller without `canCancelSessionWakeup` gets 403 on `force`.
- **C3: signals on force.** A forced pause or replace defers the signals
  until the sandbox stopped, as before. A forced move or profile change
  now sends them too, after the owner write and into the rebuilt session,
  attributed to the mover. A forced archive sends them to the session's
  main thread, so the agent learns why the work ended even if the thread
  is unarchived later.
- **C3: ordering.** A forced pause checks that the attachment can suspend
  (`current() !== null`) before it cancels. After an api restart the
  attachment is `detached`, and the pause refuses with the work still
  running (wave 4 moved this check before the gate and gave it the next
  step; see "C4: pause on a detached sandbox"). Pause, replace, and PATCH re-check
  for an unsettled submission after the cancel; if a turn started, they
  send the signals and return 409 saying the work already stopped.
- **C3: other archive paths.** A brief dismissal and the settled-run
  thread archive (`run-attention.ts`) do not archive a thread with open
  background work, and do not cancel it. The dismissal counts it as
  `keptRunning`. A person archives such a thread through the 409 rule.
- **C3: web.** Pause, replace, the profile switch, archive (menu, `A`
  key, catch-up Archive), and move catch the 409, list the visible work,
  and resend with `force` from a confirm ("Stop background work and
  pause", and so on). With `forceAllowed: false` the dialog shows the
  server text and no confirm. Replace errors in the thread list now show.
  The move dialog lists the work up front and reports how many items
  stopped. Badge rows show `running 3h` or `starting`. Consecutive
  `watch.event` cards of one watch, and the quiet turns between them,
  render as one expandable card; quiet turns elsewhere still render as
  before. The card shows `from <channel>` when `MessageSignal.origin` is
  set; `engineSignalToWire` (`bridge.ts`) copies `origin.channelType`
  and nothing else from the origin.
- **A3: watch rate counts polls with output.** Fix wave 3 (data M1)
  found the signal-count limit unreachable. One signal per 30-second tick
  gives at most 120 per hour, and the check needed 121. The window now
  counts WakeWatcher polls that read new lines, and it starts over only
  when it is more than one hour plus one tick old (fix wave 4). So a watch
  with output on every poll stops on the 121st such poll at the defaults,
  even when each tick lands a little late.
- **A3: coalesced watch signals.** A watch sends at most one
  `watch.event` per `watchMinIntervalMs` (default 120000,
  `VALET_WATCH_MIN_INTERVAL_MS`). The first signal goes out at once. Lines
  read in between collect in the new nullable `watch_buffer` column, and
  `last_emit_at` records the last signal. A buffer of 64 KiB goes out at
  once. At exit, the buffer and the last lines go out as one final
  `watch.event` before `watch.exited`. B1 gains both columns, with
  `SCHEMA_REPAIRS` entries.
- **A3: INV-6 before the repair.** The WakeWatcher sets
  `valet.leases.over_deadline` at the start of each pass, before it ends
  or repairs anything. `valet.leases.orphan_released` gains a `reason`
  label: `missing_owner` and `terminal_owner` are crash windows;
  `deadline` is a bug and pages. Take a lease two ticks past its deadline
  whose owner is still open. Its owner now ends as `expired/deadline`
  with a kill and its signal. The release is in the same statement. An unreadable owner row reads as missing.
- **A3: pending rows are probed.** The start grace is 45 minutes, longer
  than the kubernetes scale-up wait plus an image pull. Past it, the
  WakeWatcher probes a pending row. A running job is adopted (`running`),
  an exited job ends with its exit code, and no job ends `lost` with a
  kill. The seam's `pending -> running` write can throw after the job
  started. The seam then returns the started process and leaves the row for
  this adoption. So the agent does not run the command twice.
- **A3: seam start texts.** A pending start that a human cancel ended
  refuses with `<id> was cancelled before it started, so it was stopped.
  Do not start it again unless someone asks.` The tools return every
  `[bash_background]`, `[wake_at]`, and `[hold_sandbox]` seam refusal as
  result text. A create re-reads the session after its
  writes; when a delete won the race, it ends its rows and refuses.
- **A3: transition time.** Each WakeWatcher transition stamps `endedAt`
  and `updatedAt` with the clock at that transition. On a slow pass, the
  pass start time was minutes old. The ChildWatcher awaits the terminal turn of a wakeup that ended
  after the watched submission was admitted or was created after it, and
  measures its admission grace from when it first saw the row ended. It
  awaits a `cancelled` row's turn too, because a human cancel sends one;
  an agent cancel sends none and costs one grace wait. The lease bound is
  the latest deadline plus two WakeWatcher ticks plus one poll.
- **A3: child retention and leases.** The retention sweep skips a child
  while it holds an active lease or a pending timer, at both checks, and
  logs once per child (INV-8).
- **A3: job logs on scratch.** The seam caps a detached log at
  `min(jobLogMaxBytes, scratch / 4)` when the host passes `scratchBytes`.
  A capped kubernetes log ends with `[valet: log capped at <n> bytes;
  later output dropped]` once output passes the cap; `process_read` and
  the exit body name it. The marker needs a `head` that reads no more
  than it writes from a pipe. GNU coreutils on the sandbox image does.
  Job files are pruned at each kickoff when their `.exit` or `.dead` is
  more than a day old, and `valet.jobs.logs_pruned` counts them. The
  brief named a WakeWatcher step. The kickoff runs the prune instead,
  because logs grow only through kickoffs and the kickoff needs no row
  state to find them.
- **A3: docker.** The `/scratch` host directory is mode 1777. One
  sandbox's finished detached job buffers stay under 256 MiB in total;
  past that, the oldest finished buffer is dropped and counted in
  `valet.jobs.docker_output_dropped`. Running buffers are never dropped.
- **A3: smaller fixes.** A timer with no prompt ends `lost` and counts as
  a bad row. `getWakeup` and the count read skip and count unreadable
  rows. The first pass after a start counts at most one interval of
  `node_seconds`. `sweep_ok_at` is set when the watcher starts. A session
  delete counts open wakeups as `cause=session_deleted`. The INV-6 test
  matches `releaseLease(` in any case. `stop()` makes a pass stop before
  its next row, and the signal shutdown waits 20 seconds. A `task`
  scratch refusal counts in `valet.sandbox.scratch.refused`.
- **A3: prompts and tools.** The `/scratch` sentence appears only when
  the host passes `scratchEnabled`. The rules tell the agent to end its
  turn after a start, cover `watch` and `hold_sandbox`, and bound the
  child timer promise at 24 hours. The orchestrator persona says a
  `<wakeup>` signal is the assistant's own work even when it reads
  `addressed="false"`. `wake_at` refuses an `at` with no UTC offset.
  Terminal signal bodies end with a line that names the next step for
  `pid_missing`, `sandbox_unavailable`, `deadline`, and a capped log.
- **Wave 3 wiring.** The host passes `scratchBytes` to every wakeups seam.
  The value comes from the attachment's last observation
  (`observedResources`), so the log cap follows the live `/scratch` size on
  every session builder. The
  `valet serve` hard exit uses `SHUTDOWN_HARD_EXIT_MS` (20 seconds), the
  same deadline as the api entry. A refused saved scratch counts in
  `valet.sandbox.scratch.refused` with source `saved`. The agent-cap and
  disabled `task` refusals end with `Retry without resources.scratch`.
- **Wave 3, restored job handle.** A kubernetes handle can lack a kickoff
  identity: it was restored after an api restart, or polled after a
  terminal poll. Such a handle checks the backing pod before a poll or
  cancel. A missing CR, a
  missing pod, or a pod that is not Running means the job is gone, so the
  row ends `sandbox_unavailable` at once. The brief named a Pending pod as
  transient. A Pending pod has no container, so no process of the original
  job can run in it; it is a recreated pod.
- **B4: applied file is not a scratch source.** The applied file lives in
  the sandbox, where the agent can write it. The attachment no longer takes
  `scratch` from it; the provider record and the live pod are the only
  sources. The kubernetes manifest builder refuses a scratch value that is
  not whole bytes or a Ki, Mi, Gi, or Ti quantity, as a last line for a
  value that arrived another way.
- **B4: root temp dir guard.** `ROOT_TMPDIR_PREFIX` exports
  `TMPDIR=/scratch/tmp-root` only when the path is a real directory that
  root owns, the same guard the start scripts use. A pod from before the
  scratch bootstrap has no such directory, so root execs there keep the
  container's `TMPDIR`.
- **B4: `.dead` stamp never stops a start.** The start prefix and both
  start scripts write a `.dead` marker only when nothing exists at that
  path, ignore a write failure, and stamp only `.pid` files older than the
  start (a temp stamp file and `find ! -newer`). A planted directory,
  FIFO, or file in `valet-jobs` cannot crash-loop the container, and a
  kickoff that races the start keeps its pid.
- **B4: `Unknown` pod phase.** A restored handle treats `Pending`,
  `Succeeded`, and `Failed` as a gone pod. `Unknown` (the kubelet lost
  contact) is a transient probe error: the row stays, the lease stays, and
  the deadline still bounds it.
- **Wave 3, wakeup signals and `addressed`.** The envelope still renders
  `addressed="false"` for a `<wakeup>` signal. The orchestrator persona
  rule names the signal as the assistant's own work, which is enough.
- **C4: forced archive keeps details off the main thread.** The human
  cancel signal of a forced archive goes to the main thread with the
  reason and the archiver's note. It has no `Last output` block and no
  channel origin, because the main thread can have readers that the work's
  thread does not have. The same rule holds for any signal that lands on a
  thread other than the work's own. The archived thread gets a `system`
  entry that names the stopped work and says a person archived the
  thread.
- **C4: refusal text for a member.** When the caller may not cancel the
  work and no work is hidden, the 409 text says `Ask the agent in this
  thread to cancel it (wakeup_cancel), or ask a team admin.` for archive.
  Session actions say the same, without "in this thread". The web dialog
  then has the title "Background work is running", no confirm, and a
  description that does not repeat the list.
- **C4: pause on a detached sandbox.** Pause checks the attachment before
  the background-work gate. When no sandbox is attached, it returns 409
  `The sandbox is not attached yet. Send a message in the session, then
  pause again.`, with or without background work.
- **C4: stale UI after a forced action.** Pause, replace, the profile
  change, and the move refresh the background-work list on every outcome.
  If a forced retry returns the 409 that says the work already stopped,
  the web dialog marks each row "Stopped", shows the server text, and
  offers no confirm.
- **C4: move sends force only after a 409.** The move dialog shows the
  polled list, but the first submit never sends `force`. The server's 409
  names the work as it is now, and only the confirm after it sends
  `force`.
- **C4: work item status.** `BackgroundWorkItem` has `status`: `pending`
  while a process or watch starts or a timer waits, else `running`. The
  dialog shows "starting" for a pending process or watch.
- **C4: timer cancel note.** A human cancel of a timer adds the route's
  note to the `timer.cancelled` body, as it does for a process.
- **C4: signal card words.** The wakeup card shows causes as words:
  `pid_missing` is "process not found", `sandbox_unavailable` is "sandbox
  stopped", `rate` is "too many events", and `deadline` is "deadline
  reached". A `cancelled` badge uses the neutral style. When the signal
  has `cancelledBy`, the card says "by a person". The wire has no name for
  the person, so the card does not name one.
- **C4: badge time.** The badge names the soonest event of any kind:
  "next deadline" for a deadline, "next wakeup" for a timer. Times round
  to the nearest unit, so 47 hours reads "in 2d" and 90 minutes reads
  "in 2h".
- **C4: bash card.** The background strip and summary show only when the
  result starts with `started sandbox process`. A refused or failed start
  renders as a plain result.
- **C4: archive waits for a turn.** An archive without `force` returns
  409 `A turn is running in this thread. Wait for it to finish, then
  archive.` while the thread has an unsettled submission. Without this
  check, a turn could start work after the gate on a thread that is then
  hidden.
- **C4: lease re-check before a stop.** Pause and replace read the leased
  work again right before `suspend()` or `replace()`. If work started
  after the gate, they send the deferred signals and return 409:
  `background work started, so the request did not <action>.` The text
  adds that the work already stopped when a forced cancel ran, and ends
  with `Retry to see the new work.` The profile PATCH runs the same
  re-check before its replace; its 409 keeps the `Profile saved, but the
  sandbox did not restart` shape, with the same "already stopped"
  sentence after a forced cancel.
- **C4: profile gate after a restart.** A profile change runs the
  background-work gate whenever leased work exists. The gate no longer
  depends on a live engine session. After an api restart the session
  stays cold while its sandbox can still run leased work. The forced path
  cancels the work. The next build replaces the sandbox, as before.
- **C4: work with no thread.** A hold with no `threadId` is session-level
  work. On a team session, a caller who passes `canCancelSessionWakeup`
  sees it in the list, can cancel it, and can force past it. The gate
  names it to every caller, with the "ask the agent or a team admin" text
  for a caller who may not cancel; it never counts as hidden work.
- **A4: rate window and drift.** A rate window starts over only when it
  is more than one hour plus one WakeWatcher tick old. The watcher passes
  its interval to the kernel as `tickMs`. A `setInterval` tick lands a
  little after the last one. So a window of exactly one hour started over
  one poll before the 121st, and the limit never tripped.
- **A4: due-row cursor.** `listDueWakeups` returns `{ rows, next }`.
  `next` is the cursor of the last raw row, so an unreadable row in a full
  page no longer ends the pass. Both stores and the contract cover it.
  `SessionStore` gains `getLease(id)` so the contract can read back a
  released lease.
- **A4: watch bodies.** Deadline, `sandbox_unavailable`, and rate bodies
  carry the unsent watch lines, up to 64 KiB. They used a 4 KB tail. A
  human cancel of a watch adds them after `Last output`. One `watch.event`
  holds at most 64 KiB of lines. A larger buffer keeps the rest for the
  next emit, which is due at once while the buffer stays full. At exit,
  the lines go out as several `watch.event` signals of at most 64 KiB.
- **A4: pending rows and adoption.** A pending row past its start grace
  waits for its deadline when its probe fails, as a running row does. When the seam's running write loses to a WakeWatcher adoption, the
  seam returns the running row and kills nothing.
- **A4: docker.** A finished detached job stays in memory until a
  terminal poll reads its exit. Docker writes no cap marker. Its poll
  reports `truncated`, and the exit body and `process_read` add the same
  capped-log notice the kubernetes marker gives. `readLog` returns
  `capped: true` for it.
- **A4: seam refusals.** A raw sandbox with no job mode ends the row with
  no `pid_missing` count and returns the `[bash_background]` unavailable
  text. `hold_sandbox` on a session with no running sandbox refuses with
  `The sandbox is not running. Send a command that needs it first, then
  hold it.` A create can land after its session delete. It then runs the
  session delete cascade again, which deletes its rows and counts its
  open wakeups in `valet.wakeups.total`. The validators refuse a NUL
  byte in `command`, `reason`, or `prompt` and name the field.
- **A4: shutdown.** `close()` raises the WakeWatcher's stop flag before
  the other awaited stops and awaits it before `evictAll`. A stopping pass
  skips the lease reconcile. A row's kill runs after its signal delivery.
  When the hard exit cuts a pass, the signal is already submitted and only
  the kill is lost.
- **A4: leases.** A lease lookup that throws skips the unprotect pass for
  that tick, so a leased sandbox keeps its eviction protection.
  `node_seconds` counts each sandbox once per pass, from its oldest lease,
  under that lease's owner kind. The bad-row count read records each group
  with one `add(n)`.
- **A4: texts.** The `wake_at` result tells the agent to end its turn.
  The watch start says a full 64 KiB buffer can emit sooner than the
  interval. The deadline line names `max_hours` for a watch, and it does
  not offer a larger deadline when the deadline was `leaseMaxHours`. The
  child `wake_at` sentence uses the resolved
  `VALET_CHILD_SANDBOX_RETENTION_HOURS`, the bound the ChildWatcher holds.
- **A4: child replace.** The ChildWatcher keeps waiting while the child's
  attachment is `provisioning`, and `parkChildSandbox` leaves a
  provisioning sandbox alone. A forced replace or profile change sends its
  deferred signals only after the new sandbox is up. A settle during the
  replace was stale, and it destroyed the sandbox the route was building.
- **A4: kickoff prune.** The prune passes names through `find -exec`, so a
  workload-chosen name is never split or globbed. A job counts once, and
  only when its `.exit` and `.dead` are both gone after the `rm`.
- **A4: job log cap default.** The dead `resolveJobLogMaxBytes` copy in
  `wakeups-admin.ts` is gone. The seam imports the default from
  `providers/sandbox-backend.ts`.
