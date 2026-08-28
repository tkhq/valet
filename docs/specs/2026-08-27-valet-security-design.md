# Valet Security — Design Spec

**Date:** 2026-08-27
**Status:** draft — for review
**Owner:** Applied AI
**Source:** concept note "Agentic engagement runner (for Valet)" (<https://gist.github.com/arawal/ceeab400cd51b54927f4ade5ef3377ce>), adapted to Valet v2 primitives the way Valet Design adapted Claude Design (`docs/specs/2026-08-23-valet-design-design.md`).

## Summary

Valet Security is an AI security-review surface inside Valet. A user points an engagement at a repository. A runner session dispatches persona agents (v1: `code-review`) as child sessions, one cell at a time. Personas coordinate through immutable state documents and report structured findings. The engagement survives crashes and restarts by construction: all coordination state lives in app tables, and resuming means reading the cell list and dispatching the first non-completed cell. The user watches cells and findings accumulate live in the session page, triages findings in a review surface (verify, refute, file a Linear or GitHub issue, spawn a fix session), exports the result set (Markdown, SARIF, JSON), and gets a manifest when the engagement closes.

## Motivation

The concept note's move: **stop treating agent coordination as a control-flow problem (DAGs, RPCs, channels); treat it as a data-discovery problem.** Agents do not call each other — they read each other's state. The orchestrator does not manage agent lifecycles — it manages a work list, and agents loop until their own state says they are done. Restart-ability and cross-agent visibility fall out of the data format, not the coordination layer.

The note proves this with files: `orchestration.yml` for the work list, per-persona `state.yml` files read by absolute path. Valet Security keeps the note's thesis — recovery by re-reading state, immutability of written findings, personas that discover peers' work as data — and swaps the substrate, because Valet's primitives force it and reward it (see The Move).

What Valet adds over a filesystem prototype: every persona runs in an isolated sandbox with a pinned clone of the target repo, every dispatch is a durable, observable child session, approval gates put a human in front of cost and scope, and the findings surface renders live in the web client.

## The Move: State Files Become State Rows

The note's personas share one filesystem. Valet's sessions do not: each session — parent or child — gets its own sandbox, and the sandbox gateway rejects one session's JWT in another session's sandbox. "Read your peer's `state.yml` by absolute path" cannot hold across Valet sessions.

So the substrate moves from the filesystem to the app database, behind session-scoped tools:

- `orchestration.yml` becomes a `security_engagements` row plus ordered `security_cells` rows.
- The personas' shared working directory becomes the **engagement tree**: a virtual filesystem addressed by `sec_fs_*` tools (`sec_fs_write`, `sec_fs_read`, `sec_fs_list`) and backed by append-only `security_files` revisions — the `mem_*` memory-tools shape, which is itself path-addressed. The persona still imagines a filesystem; the rows are the disk. Each cell's `state.yml` lives at a conventional path (`/cells/01-recon/state.yml`), stored verbatim — the note's interchange format survives, only the disk changes.
- "Read peers' findings by absolute path" stays literal: `sec_fs_read` takes the path, and every persona in the engagement can read the whole tree.
- "Atomic write of state.yml before the cell status flips" becomes a database transaction — an exclusion the note had to make (transactional `orchestration.yml` writes) that the substrate now gives for free.

The properties the note derives from the file format hold identically: if a persona crashes after `sec_fs_write`, its work persists; if the runner crashes, re-reading the cells resumes from the first non-completed cell. No transaction log, no heartbeat, no acknowledgments — the recovery path IS the read path.

| Concept note | Valet Security |
|---|---|
| Orchestrator process | Runner: an app session with `kind='security'` and the engagement-runner skill |
| `orchestration.yml` (18 cells) | `security_engagements.plan` + `security_cells` rows |
| Persona agent (fresh Claude instance) | Child session spawned per cell, persona role attached |
| Shared filesystem of working dirs | Engagement tree: `sec_fs_*` tools over `security_files` rows |
| `state.yml` per persona working dir | `/cells/<NN>-<name slug>/state.yml`, append-only revisions (YAML verbatim) |
| Findings list inside `state.yml` | `security_findings` rows via `sec_finding_report`; the state doc references finding ids |
| Shared protocol file at a URL | Protocol markdown shipped in `packages/plugin-security`, mounted read-only at `/protocol.md`, injected into every dispatch prompt |
| Dispatch prompt naming paths | Dispatch prompt naming the cell, the goal, and the tree paths of completed cells' state docs |
| grep `checklist_pending=0` exit check | Server-side exit-condition check in `sec_cell_complete` |
| Orchestrator crash → re-run same yml | Runner session resumes; `sec_status` + `sec_dispatch` pick the first non-completed cell |
| Manifest of completed cells | `sec_close` computes the manifest from cells + findings |

## Vocabulary

One name for one thing, used in code, copy, and this spec:

- **Engagement** — one security review of one repo at one pinned commit. One engagement per session.
- **Cell** — one unit of dispatch: a persona, a mode, a goal. Cells run serially in ordinal order.
- **Persona** — a specialist role (v1: `code-review`) a child session runs under.
- **Runner** — the `kind='security'` session whose agent drives the cell loop.
- **Engagement tree** — the engagement's virtual filesystem: paths addressed by `sec_fs_*` tools, backed by append-only `security_files` rows.
- **State doc** — a persona's YAML working state at `/cells/<NN>-<name slug>/state.yml`, append-only revisions.
- **Finding** — a structured, immutable security observation tied to a cell.

## Architecture Overview

1. **The runner is a full agent session** (locked decision 5: orchestrators are agent sessions). The hub creates it via `POST /api/sessions` with `kind='security'`. The engagement-runner skill instructs the loop; the `sec_*` tools enforce it. The agent cannot corrupt the state machine because every transition is validated server-side — the skill is guidance, the routes are law.

2. **Cell transitions are server-enforced.** `pending → running` happens only inside `sec_dispatch` (which also spawns the child, in one transaction). `running → completed` happens only inside `sec_cell_complete`, and only when the child has settled and its latest state doc passes the exit condition. The agent narrates; the database decides.

3. **Personas are child sessions.** `sec_dispatch` spawns a child through the host `ChildSpawner` with the same repo binding pinned to the engagement's resolved commit SHA, so every persona reads an identical tree. The engine gives children no spawner, so persona recursion is structurally impossible — stronger than the note's contract-in-a-markdown-file.

4. **Tools follow the `mem_*` / `design_*` precedent.** `sec_*` tools are API-built engine `ToolDef`s (`packages/api/src/engine/security-tools.ts`), attached by session role: runner tools to `kind='security'` sessions, persona tools to child sessions that a cell row claims. Each tool's `execute` calls internal security routes over `ctx.config.apiBaseUrl` with the internal token. Underscore names — the Anthropic tool-name charset forbids dots.

5. **The web client reads REST, live-updates over the session WebSocket.** Findings and cells are rows, so the security panel is a query away. `security.*` wire events ride the `host_event` seam the Valet Design PR adds to the engine (see Dependencies); until that lands, the panel polls.

## Data Model

All app-side. Edit `packages/api/migrations/pg/0000_app.sql` in place. Every table and column also gets a repair statement in `addColumnsMissingFromAppliedMigrations` (`packages/api/src/lib/drizzle.ts`), or deployed databases never pick it up. After editing, wipe dev data (`make dev-clean` per worktree). Drizzle schema updates land in `packages/api/src/schema/index.ts`; row types come from `$inferSelect`.

```sql
CREATE TABLE "security_engagements" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "status" text DEFAULT 'planning' NOT NULL,
  "repo_full_name" text NOT NULL,
  "repo_ref" text DEFAULT '' NOT NULL,
  "plan" text DEFAULT '' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "security_engagements_session_unique"
  ON "security_engagements" ("session_id");

CREATE TABLE "security_cells" (
  "id" text PRIMARY KEY NOT NULL,
  "engagement_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "persona" text NOT NULL,
  "mode" text DEFAULT 'fresh' NOT NULL,
  "goal" text NOT NULL,
  "dir" text NOT NULL,
  "reads" text DEFAULT '[]' NOT NULL,
  "review" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "compacted_at" bigint,
  "child_session_id" text,
  "dispatched_at" bigint,
  "settled_at" bigint,
  "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "security_cells_engagement_ordinal_unique"
  ON "security_cells" ("engagement_id", "ordinal");

CREATE TABLE "security_files" (
  "id" text PRIMARY KEY NOT NULL,
  "engagement_id" text NOT NULL,
  "cell_id" text NOT NULL,
  "path" text NOT NULL,
  "revision" integer NOT NULL,
  "content" text NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "security_files_path_revision_unique"
  ON "security_files" ("engagement_id", "path", "revision");

CREATE TABLE "security_findings" (
  "id" text PRIMARY KEY NOT NULL,
  "engagement_id" text NOT NULL,
  "cell_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "file" text,
  "line" integer,
  "body" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "status_reason" text,
  "status_actor" text,
  "created_at" bigint NOT NULL
);
CREATE INDEX "security_findings_engagement" ON "security_findings" ("engagement_id");

CREATE TABLE "security_finding_links" (
  "id" text PRIMARY KEY NOT NULL,
  "finding_id" text NOT NULL,
  "engagement_id" text NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "url" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "security_finding_links_provider_unique"
  ON "security_finding_links" ("finding_id", "provider");
```

Value sets:

- `security_engagements.status`: `planning` → `running` → `completed` | `failed`.
- `security_cells.status`: `pending` → `running` → `completed` | `yielded` | `failed`. `yielded` is a deliberate checkpoint-and-stop (see Context Discipline): the persona settled with work remaining and a fresh state doc; re-dispatch continues it with a fresh context. `failed` is reserved for real failures (child died, terminal error). Both re-dispatch onto the same row; `attempts` counts dispatches; state docs persist across attempts.
- `security_cells.reads`: JSON array of earlier ordinals whose state docs this cell's dispatch prompt names (the plan's DAG edges; see Context Discipline).
- `security_cells.mode`: `fresh` (ignore own prior state docs) | `resume` (read own latest state doc and continue).
- `security_findings.severity`: `critical` | `high` | `medium` | `low` | `info`, per the rubric in the persona role.
- `security_findings.status`: `open` → `verified` | `refuted`. Forward-only; no route mutates title, body, file, line, or severity after insert ("verifier flips bits, never rewrites"). Two actors flip bits: a persona cell via `sec_finding_review` (the preset's verify cell), and a human with session-admin rights via the review route. `status_reason` and `status_actor` (cell id or `user:<id>`) record who and why.
- `security_finding_links.provider`: `github` | `linear`. One link per finding per provider (the unique index is the idempotency guard — a double-click files one issue, not two). `created_by` is always a user id: only humans file issues (Decision 10).

`security_files.cell_id` is the owning cell — in v1 every writable path belongs to exactly one cell. The read-only mounts (`/protocol.md`, `/plan.yml`) are virtual: `sec_fs_read` serves them from the plugin package and the engagement row, not from `security_files`.

Foreign keys are by id-string convention, not SQL constraints, matching every other app table. Size guard: `sec_fs_write` rejects content over 256 KB per file and 512 revisions per path; the tree holds working state, not report bodies.

### Column changes to `agent_sessions`

None new. Valet Security uses the `kind` column the Valet Design spec adds (`kind text DEFAULT 'code' NOT NULL`), extending its value set with `'security'`. See Dependencies.

## The Engagement Tree and the State Doc

The tree's layout is conventional, not enforced beyond the write-scope rule:

```
/protocol.md                    read-only mount (from plugin-security)
/plan.yml                       read-only mount (from security_engagements.plan)
/cells/01-recon/state.yml       cell 1's state doc
/cells/01-recon/notes.md        anything else the persona wants to keep
/cells/02-authz-sweep/state.yml
```

Cell directories are named `<ordinal, 2 digits>-<name slug>`, where a plan cell's optional short `name` labels the directory, falling back to the goal when absent (the persona repeats across cells in a preset; the name or goal is what distinguishes them). The directory is stamped on the cell row at `sec_start`, so paths are stable and dispatch prompts can name them literally.

A persona's state doc is YAML, stored verbatim. When a written path's basename is `state.yml`, the server validates two things: the content parses as YAML, and `protocol_version` is a known value. Other paths are free-form. Field-level schema enforcement stays out of v1 (the note's exclusion holds); the protocol markdown is the contract personas follow.

```yaml
protocol_version: 1
engagement: eng_abc123
cell: cell_01
persona: code-review
mode: fresh
status: working        # working | yielding | done
checklist:
  pending: 0
  done: 14
queue:
  pending: 0
  done: 22
findings: [fnd_9a1, fnd_9a2, fnd_9b0]   # ids from sec_finding_report
log:
  - "swept packages/api/src/routes for authz gaps"
  - "queued follow-up on token minting path"
```

**Checkpoint cadence (normative):** the protocol requires a state doc write after every 10 checklist items and before any long analysis. At any interruption point — crash, compaction, yield — the durable state is at most one stride stale.

**Exit condition (normative):** a cell is completable only when its latest state doc has `status: done`, `checklist.pending: 0`, and `queue.pending: 0`. `status: yielding` with pending work is a deliberate stop (see Context Discipline), not a completion. The note's orchestrator greps for the counts; here `sec_cell_complete` parses and checks them server-side, so a persona that stops looping early by accident cannot be marked done by a polite-but-wrong runner narration. Honest limit: the counts are the persona's own arithmetic, so this check defeats accidental truncation, not a persona that self-certifies `pending: 0` without doing the work. The recon cell narrows that gap by seeding the checklist from the clone's file inventory — later cells inherit a checklist they did not invent — and the verify cell attacks the findings themselves. Server-seeded checklists are a re-entry seam.

## Tools

Two tool sets, both built in `packages/api/src/engine/security-tools.ts`, both calling internal routes under `/api/sessions/:id/security/*` with the `x-valet-internal` token. Persona tools resolve the calling session's cell from `security_cells.child_session_id` matched against `ctx.sessionId` — one cell writes only its own state, the same shape as the sandbox gateway's `sid` claim check.

### Runner tools (attached to `kind='security'` sessions)

**sec_plan_set** — `{ plan: string }`. Replace the engagement plan (YAML: ordered cells with persona, mode, goal, optional short `name` to label the cell directory, optional `reads` ordinals, optional `paths` include globs to scope a cell to part of a monorepo, optional `review: true` to grant `sec_finding_review`) while status is `planning`. Validates: personas exist in the registry, ordinals are dense, `reads` reference only earlier ordinals (the DAG is acyclic by construction), cell count ≤ 32. Refused once the engagement is running — the plan is immutable after start, like the note's `orchestration.yml`.

**sec_start** — `{}`. Requests an approval decision gate naming the repo, the resolved commit SHA, the cell count, the personas, and a rough cost estimate (a static per-persona token estimate times cell count — imprecise, but the user approves a number, not a shrug). On approval: resolves and pins `repo_ref` to a SHA, materializes `security_cells` rows from the plan (stamping each cell's `dir` and `reads`), flips status to `running`. This one gate covers every later dispatch — the cost surface is approved as a plan, not per child.

**sec_status** — `{}`. Returns the engagement, all cells with statuses, finding counts by severity, and for a `running` cell its child's settled/liveness signal. This is the resume primitive: a fresh runner turn calls `sec_status` and knows exactly where the engagement stands.

**sec_dispatch** — `{ cell_id?: string, mode?: 'fresh' | 'resume' }`. Dispatches the first `pending` cell, or re-dispatches a named `yielded` cell (default `mode: resume`), a `failed` cell, or a stuck `running` cell whose child is gone. Refuses if another cell has a live child — v1 is serial, per the note's scope. In one transaction: spawns the child session (same repo binding, `ref` = pinned SHA, headless profile), stamps `child_session_id` and `dispatched_at`, increments `attempts`, sets status `running`. The dispatch prompt is selective, not exhaustive: the persona role, the shared protocol, the cell goal, mode, and `paths` scope, the cell's own directory path, and the tree paths of ONLY the cells named in `reads` (see Context Discipline). The persona can still discover the rest of the tree via `sec_fs_list`; the prompt just does not spend its context on it.

**sec_cell_complete** — `{ cell_id: string }`. Validates the child settled and the cell's `/cells/<dir>/state.yml` exists and parses, then rules on the latest revision:

- `status: done` + both pending counts zero → cell `completed`, `settled_at` stamped.
- `status: yielding` → cell `yielded`; the result tells the runner to `sec_dispatch` with `mode: resume`.
- Anything else → the cell stays `running` and the result names the violation (for example `status is done but queue.pending is 2`) so the runner can `child_send` the persona to keep looping.

**sec_cell_fail** — `{ cell_id: string, reason: string }`. Marks a cell `failed` with a reason. Explicit and agent-invoked; nothing sweeps cells to `failed` on a timer (see Invariants).

**sec_close** — `{}`. Allowed when no cell is `pending`, `running`, or `yielded`. Computes the manifest — per cell: persona, status, attempts, state doc revisions, finding count; per engagement: distinct-fingerprint finding counts by severity, with the verified/refuted/open breakdown — flips the engagement to `completed` (or `failed` when any cell failed), and returns the manifest as the tool result, durable in the thread. Distinct fingerprints keep near-duplicate reports from inflating the headline numbers.

**sec_handoff** — `{ finding_id: string, task?: string }`. Spawns a child coding session (the `design_handoff` precedent): same repo binding at the pinned SHA, brief containing the finding (title, file, line, body, evidence) plus the optional task. The child is an ordinary coding session that can branch and open a PR through the user's existing GitHub integration. This is the "so what" of the findings table — a finding becomes a fix session in one call.

### Persona tools (attached to cell-claimed child sessions)

**sec_fs_write** — `{ path: string, content: string }`. The path must sit under the calling session's own cell directory (`/cells/<own>/...`); anything else is refused — the path prefix IS the write claim, resolved from `security_cells.child_session_id`. A write to an existing path appends the next revision; nothing updates in place, so history rewrite is structurally impossible. Writes whose basename is `state.yml` get the YAML parse + `protocol_version` validation.

**sec_fs_read** — `{ path: string, revision?: number }`. Reads any path in the engagement tree, latest revision by default. This is the note's "read peers' findings by absolute path", with the engagement as the visibility boundary. Also serves the read-only mounts `/protocol.md` and `/plan.yml`.

**sec_fs_list** — `{ prefix?: string }`. Lists paths under a prefix with each path's latest revision number and size. Personas discover peers' work the way the note intends: by looking at the filesystem.

**sec_protocol_read** — `{}`. Returns `/protocol.md` and nothing else. The ToolDef carries `protectedFromPruning`, so the contract the persona operates under survives context pruning while ordinary `sec_fs_read` results stay prunable (see Context Discipline and implementation deviation 4).

**sec_finding_report** — `{ severity, title, file?, line?, body }`. Inserts a finding for the calling cell. The body must carry evidence: a code excerpt and the reasoning from source to impact. The server rejects bodies under 200 characters with a corrective error naming the evidence requirement — an unevidenced finding is noise wearing a severity badge. Caps at 100 findings per cell; the cap error tells the persona to consolidate instead of enumerate. The server computes the fingerprint — sha256 over file, line bucket (÷10), and normalized title, first 16 hex — and returns the finding id plus any existing findings sharing the fingerprint (advisory dedup; the persona decides whether it found something new).

**sec_finding_review** — `{ finding_id: string, status: 'verified' | 'refuted', reason: string }`. Forward-only status flip, recorded with the calling cell as `status_actor`. Attached only to cells the plan marks `review: true` (the preset's verify cell) — a prompt-injected sweep persona must not be able to refute its peers' findings. Refuting requires the reason to name what the original evidence missed.

**sec_findings_list** — `{ cell_id?, severity?, status?, cursor? }`. Lists findings across the engagement, paginated.

Runner sessions also get `sec_fs_read` / `sec_fs_list` / `sec_findings_list` (read-only on the tree) so the runner can summarize without a child. The generic `task` / `child_read` / `child_send` / `child_status` tools stay available to the runner for steering; dispatch itself goes through `sec_dispatch` only, so bookkeeping and spawn cannot drift apart.

## The Loop, Crash, and Resume

The engagement-runner skill instructs this loop:

1. Call `sec_status`.
2. If a cell is `running`: check its child. If the child settled, call `sec_cell_complete` — on `completed`, continue; on `yielded`, `sec_dispatch` with `mode: resume`; on a violation, `child_send` the persona to keep looping and wait for the next settle. If the child is gone without settling, call `sec_cell_fail`, then re-dispatch with `mode: resume`.
3. If a cell is `pending` or `yielded` and nothing is running: `sec_dispatch`.
4. If every cell is `completed` or `failed`: `sec_close` and present the manifest.

The loop self-advances: a child's settlement is admitted to the runner's thread as a `child.settled` signal through the engine's own prompt machinery, so each settle starts a runner turn without the user touching anything. The runner skill's first rule: trust `sec_status`, never your own conversation memory — the loop must survive the runner's context being compacted to nothing.

Crash recovery needs no machinery beyond this, and usually needs nothing at all: sessions are durable, and `ChildWatcher` re-arms every unsettled watch at boot, so after an api restart a mid-flight child resumes, settles, and wakes the runner as if nothing happened. The explicit resume path (user posts "continue", runner starts at step 1) covers the rarer cases — a child whose sandbox was reclaimed, a terminal error. Completed cells never re-run. A persona that crashed after its last `sec_fs_write` lost nothing; its replacement reads its own revisions in `resume` mode. This is the note's acceptance step 12, held by the substrate rather than by careful file ordering.

**Invariants: alert, don't auto-repair.** Cell status has one owner: the security routes. No TTL kills a long-running cell and no sweep re-syncs statuses. The api emits a `security_cells` created/settled counter pair and an over-age `running` gauge (cell running with no child activity for 30+ minutes); the session page shows the same condition on the cell rail. A stuck cell is a page to a human (or the runner agent), not a silent repair. Re-dispatch is always an explicit `sec_dispatch` call.

### Autonomy: the nudge sweep

The runner is autonomous. It drives the loop to `sec_close` and never stops to ask the user for permission. The one legitimate pause is the `sec_start` approval gate (and any tool approval). The self-advance loop above is the primary driver, but a turn can end early — a settle signal that never landed, a model that stopped short of the next tool call. A server-side sweep re-drives the runner in that gap.

`SecurityRunnerDriver` (`packages/api/src/orchestrator/security-runner-driver.ts`) is a stateless poll, not an event watcher. Every interval it reads each planning/running engagement and nudges the runner when all three hold: the runner session is live, no cell is `running`, and the runner has no unsettled submission. A gated or actively-working submission is UNSETTLED, so `listUnsettledSubmissions` empty cleanly means idle — and the sweep never nudges during the `sec_start` approval, because the gate holds an unsettled submission. The nudge is one prompt through the same `submitSessionPrompt` path the kickoff uses: "call `sec_status` now and continue the loop."

A stall cap bounds the driver. It tracks a per-engagement progress signature (engagement status, every cell's status, finding count). While the signature changes, nudges continue. After N no-progress nudges (default 3, `VALET_SECURITY_NUDGE_MAX_STALLS`) the sweep stops nudging, posts ONE message asking the user to step in, and emits `valet.security.runner.stalled`. User intervention changes the signature and resumes nudging. This is alert, don't auto-repair: the driver is explicit, observable, and capped — a genuinely stuck runner pages a human instead of looping forever. `VALET_SECURITY_NUDGE_INTERVAL_MS` (default 20000) sets the poll interval; a value `<= 0` disables the sweep. The stall budget is in-memory only, so a restart resets it — a re-issued nudge costs one turn, not correctness.

## Context Discipline

Long engagements exceed model contexts — for the personas, for the runner, or both. The design's stance: **context is a cache; the tree is the state.** Three mechanisms hold that line.

### Yield: the persona's deliberate stop

A checklist over a real repo does not fit one child context, so running out is normal operation, not failure. When a persona nears its limit (or finishes a natural phase), it writes a state doc with `status: yielding` and settles. The runner re-dispatches with `mode: resume`; the replacement child starts with a fresh context, reads its own state doc, and continues from `queue.pending`. This is the note's "agents resumeably loop until their local state says they're done", made first-class — v1 without yield would reach fresh-context resumption only through the failure path, mislabeling routine operation as failure and polluting the `attempts`/alert signals.

`child_send` ("keep looping") is for exit-condition violations only — it steers the same context, so it cannot rescue an exhausted one.

### Compaction hooks: checkpoint boundaries, not data loss

The engine already ships the seams (`CompactionConfig`, `compactionHooks`, `ToolDef.protectedFromPruning` — `packages/engine/src/types.ts`). Valet Security uses them as follows:

- **Persona threads compact safely by construction.** The checkpoint cadence keeps the durable state at most one stride stale, and the protocol's rehydration rule says: after any compaction, re-read the protocol with `sec_protocol_read` and your own `state.yml` with `sec_fs_read` before continuing — trust the tree over the summary.
- **The contract survives pruning.** `sec_protocol_read` returns `/protocol.md` and carries `protectedFromPruning`, so compaction cannot strip the rules the persona operates under (why a dedicated tool: implementation deviation 4).
- **Compaction is observable, not silent.** The host registers a `compactionHook` for cell-claimed threads: it stamps the event on the cell (surfaced as a badge on the cell rail) and emits a metric when a thread compacts while the cell's latest state doc is older than the checkpoint stride — a persona compacting on stale state is exactly the moment work silently evaporates, and it should page attention, not disappear (alert, don't auto-repair).
- **The runner needs no memory.** `sec_status` reconstructs the loop's entire world; runner compaction is harmless by design, and the skill says so explicitly.

### Selective context: the plan is a DAG, dispatch follows its edges

Every cell naming every predecessor would re-inflate the contexts yield just freed. Plan cells declare `reads: [ordinals]` — the DAG edges — and `sec_dispatch` injects only those cells' state doc paths into the dispatch prompt. The authz cell reads recon's map; it does not carry the injection cell's history. The full tree stays discoverable through `sec_fs_list` for the persona that genuinely needs more, but the default context cost of a cell is its declared dependencies, not the engagement's whole past.

The same edges are the concurrency seam: cells with disjoint `reads` have no ordering dependency, so lifting the serial-dispatch restriction later is a scheduling change, not a data model change.

## plugin-security

`packages/plugin-security` follows the standard v2 plugin shape (`plugin.yaml` with `v2: true`, `./plugin` export, registry regeneration). It ships no actions. Contents:

- **Skill: `security-engagement-runner`** — the runner loop above, plan-authoring guidance, and how to present findings and the manifest.
- **Role: `code-review` persona** — the v1 persona. Instructs: build a checklist (from the clone in recon; seeded by your `reads` cells otherwise), loop it, follow the checkpoint cadence, yield deliberately when context runs short, report findings with evidence the moment they are confirmed, and settle with `status: done` only when both pending counts are zero. **Tools are first-class:** the sandbox has bash and the clone; run the pre-baked read-only scanners and triage their output instead of re-deriving what deterministic tools do better — the persona's value is the reasoning tools cannot do. Carries the severity rubric (what separates `critical` from `high` from noise) and the evidence standard (excerpt plus source-to-impact reasoning). Forbids: editing files, network access beyond the clone, installing tools, claiming `done` with a non-empty queue.
- **Methodology playbooks: `playbooks/*.md`** — one per preset cell (`recon`, `authz`, `injection`, `secrets-config`, `verify`), each a framework-grounded checklist that tells the persona what to actually look for, not invented advice. Each playbook heads with the exact standards it draws from — OWASP Top 10 2021, OWASP API Security Top 10 2023, OWASP ASVS 4.0.3, OWASP WSTG v4.2, the CWE catalog, and CVSS v3.1 for severity. A plan cell names its playbook with an optional `playbook` field (validated against the bundled set); the API serves it read-only in the engagement tree at `/playbooks/<name>.md`, and the cell's dispatch prompt tells the persona to read it before starting. This is what separates a review that finds real bugs from one that leans on the model's memory — the harness carries the tradecraft, not just the workflow.
- **Protocol: `protocol/state-doc.md`** — the state doc contract (fields, checkpoint cadence, yield and exit conditions, immutability rules), the rehydration rule (after a compaction, re-read `/protocol.md` and your own `state.yml` before continuing), and the two-filesystems rule: **engagement state exists only behind `sec_fs_*`; `/workspace` is the scan target, never state storage** — personas conflate a real filesystem and an imagined one unless told not to. Mounted read-only at `/protocol.md` in the engagement tree and injected verbatim into every dispatch prompt. Shipping it in the package instead of at a URL removes the note's schema-drift-by-unreachable-URL failure mode; the protocol version personas see is the version the server validates.
- **Plan presets** — v1 ships three, all the `code-review` persona, differing only in which middle sweeps run between a shared recon (cell 1) and verify (last cell). `code-review` (full, five cells): `01-recon` (map the codebase, seed the checklist from the file inventory, note trust boundaries), `02-authz-sweep` (reads: 01), `03-injection-sweep` (reads: 01), `04-secrets-config` (reads: 01; primarily deterministic-scanner triage), `05-verify` (reads: 01–04; `review: true`; attack every open finding, `sec_finding_review` each, refute what does not survive). `secrets-config` (three cells): recon, the secrets/config sweep, verify. `access-injection` (four cells): recon, authz, injection, verify. Every preset keeps dense ordinals, recon reads nothing, each middle sweep reads recon `[1]`, and verify reads every prior ordinal with `review: true`. The hub picks the preset at create time and can scope the middle sweeps to include globs (`paths`); recon and verify stay repo-wide. Chat can edit the plan before `sec_start`.

**Sandbox image:** no variant image (single-image lineage is locked). The stock image adds pinned, offline-capable read-only scanners — a secrets scanner and a pattern scanner (gitleaks and semgrep or equivalents) — the way it carries marp for design exports. Personas run them against the clone; rule updates ride image rebuilds, not runtime downloads, so sandbox egress stays closed.

The pure library (plan YAML parse/validate, state doc parse, exit-condition check, fingerprint computation) lives in the plugin as importable code with unit tests, and the API imports it — the `plugin-design` lib precedent.

## Dynamic configuration

A scanned repo configures its own review. It commits `.valet/security.yml`; Valet reads that file at create time and seeds the review from it. A repo without the file falls back to the bundled presets. This makes a review self-describing and versioned with the code it reviews. See `docs/plans/2026-08-28-valet-security-dynamic-config.md` for the phased plan; M-F1 ships the persona registry, the config loader, and the stored config context.

### The persona registry

A persona is the role a cell-claimed child session runs under. The registry is extensible:

- **Bundled personas** ship in `plugin-security` (`personas/<id>.md` + `BUNDLED_PERSONAS`). v1 bundles one: `code-review`. `KNOWN_PERSONAS` equals the bundled ids, so `parsePlan`'s persona check gates against the registry. The plugin manifest builds one `RoleSpec` per bundled persona.
- **Repo-defined personas** come from `.valet/security.yml`'s `personas` map (id → the persona markdown path in the clone). A step may name a repo persona; a repo persona wins over a bundled id of the same name.
- **Host attach** — the host attaches ONLY the role matching a claimed cell's `persona`, read from `security_cells.persona`, not every security role. A repo-defined persona has no bundled role yet; M-F1 falls back to the `code-review` role with a logged note. Loading a repo persona's markdown from the clone at attach time is a noted M-F1 follow-up.

### The `.valet/security.yml` schema

```yaml
version: 1                 # required; must be 1
focus: string              # optional free-text focus note (M-F3)
invariants: [string]       # optional known invariants (M-F3)
categories: [string]       # optional threat-category names to load (M-P2a)
personas: { id: path }     # optional repo-defined personas: id → markdown path in the clone
tools: [string]            # optional declared tools a step needs (M-P4)
steps:                     # optional ordered review steps (each a plan cell)
  - ordinal: 1
    persona: code-review   # a bundled id OR a key in `personas`
    mode: fresh
    name: recon
    playbook: recon
    goal: string
    reads: []
```

`parseSecurityConfig(yaml, knownPersonas)` validates the file: `version === 1`, `invariants`/`categories`/`tools` are string lists, `personas` maps ids to non-empty paths, and `steps` (if present) parse as a plan through `parsePlan`'s cell rules against the union of bundled ids and the config's persona keys. It throws a corrective error naming `.valet/security.yml` on the first violation. `configToPlanYaml(config)` serializes the config's steps to plan YAML (through `serializePlan`); it throws when the config declares no steps.

### Load and fall back

The security create route reads the config through the GitHub contents API BEFORE the sandbox exists — `fetchRepoFile(deps, token, owner, repo, ".valet/security.yml")` (default branch, 404 → null). When the file is present and its `steps` parse, the plan is seeded from `configToPlanYaml(config)` and the config context is stored on the engagement. When the file is absent, unreadable, or invalid, the route falls back to `presetPlan(preset, { paths })` and logs the reason; `has_repo_config` stays false so the panel shows the preset source. A re-scan (`rescanOf`) inherits the parent's plan as today; re-fetching the config on re-scan is a later concern.

### Stored config context

The engagement row carries the parsed config for later milestones: `focus` (text), `invariants`/`categories`/`config_personas`/`config_tools` (JSON), and `has_repo_config` (boolean). M-F1 stores and exposes these on the `GET /security` response; it does NOT wire invariants into prompts yet (that is M-F3). The hub/panel shows the review source: `Configured by .valet/security.yml` vs `Preset: Code review`.

### The step editor (M-F2)

A user edits the review's steps from the UI during planning, without steering the runner in chat. Two seams support it:

- **Structured plan in the read.** `GET /security` adds `planCells`: the engagement's `plan` YAML parsed into structured steps `{ ordinal, persona, name?, goal, playbook?, paths?, reads, review }`. The editor reads this. It is meaningful in `planning`, before cells materialize at `sec_start`. A malformed plan row yields `[]`.
- **Structured plan-edit route.** `POST /security/plan/cells` accepts `{ cells: SecurityPlanCellInput[] }`, where a step names `persona`, `goal`, and the optional `name`/`playbook`/`paths`/`reads`/`review` — no ordinal. The route assigns dense ordinals 1..N in array order, serializes the cells (`serializePlan`), and validates the plan against the bundled personas ∪ the engagement's repo-declared personas. It calls `setPlan`, which refuses a running engagement with a corrective error. Auth rides the same `resolveToolSession` "mutate" ladder as the YAML route, so a human admin OR the internal tool path may call it. The YAML `POST /security/plan` stays for the `sec_plan_set` tool.

The panel shows the editor only while `engagement.status === 'planning'` AND the caller can administer the session (the route enforces both; the UI hides a button that would 403). Each step is an editable row: persona (a select mirroring the bundled persona ids), name, goal, playbook (an optional select mirroring `KNOWN_PLAYBOOKS`), paths (a comma/space list), reads (a multi-check of the earlier ordinals), and a review checkbox. Controls add, remove, and reorder steps. A "Save plan" button posts the structured cells; the client mirrors the plan rules (`reads` name earlier steps only, at most 32 steps) with inline errors, and the server is the real gate. The editor's local draft seeds from `planCells` and resyncs when `planCells` changes and the user has not edited it (a `userTouched` ref), keyed by a stable per-step id, not the array index. Once the engagement runs, the plan freezes: the editor hides and the read-only cell rail takes over. The editor stays usable during the `sec_start` approval gate (still `planning`), so editing then approving materializes the edited plan.

### Focus + invariants injection (M-F3)

A review focuses better when the team states two things: a FOCUS (where to weight the review) and the INVARIANTS it already holds ("every admin route sits behind requireAdmin", "tenant id is always checked in the repository layer"). Both seed from `.valet/security.yml` at create (`focus` text, `invariants` string list) and both ride on EVERY persona dispatch.

- **Injection.** `buildDispatchPrompt` takes the engagement's `focus` + parsed `invariants` and, when either is present, adds a delimited block just before the protocol:
  - Focus: "Focus of this review (from the engagement): `<focus>`. Weight your checklist toward this, but do not skip your cell's core coverage."
  - Invariants: "Known invariants the team asserts hold. Treat a VIOLATION of any as a high-signal finding — a broken invariant is exactly what the team wants to know:" followed by one bullet per invariant.
  - An absent focus and empty invariants add nothing — the prompt is byte-identical to before. `buildDispatchPrompt` stays pure; `dispatchCell` passes `{ focus, invariants }` from the engagement row.
- **The persona uses it.** The code-review persona role gains: "If your dispatch names known invariants, verify each against the code you review. A confirmed violation is a finding; cite the invariant. Do not assume an invariant holds just because it is asserted."
- **The edit route.** `POST /security/config` accepts `{ focus?, invariants? }`. `focus` of `null` or `""` clears the note; `invariants` of `[]` clears the list; an omitted field is left unchanged. The service method `setEngagementConfig` writes the columns and refuses a running engagement with the immutable-config error, matching `setPlan`. Auth rides the same `resolveToolSession` "mutate" ladder (human admin or the internal tool path). The route returns the saved values.
- **The panel.** During planning an admin edits focus (a textarea) and invariants (an add/remove line list) and Saves through `useSetEngagementConfig`, seeded from the engagement with the `userTouched` resync rule. Once running or closed, the panel shows the active focus + invariants READ-ONLY, so the user sees what the review was told. A finding that cites an invariant reads clearly from the model's own output; no special finding UI is needed.

### Threat-category library (M-P2a)

The invariants a team writes cover what THEY already know. A domain also has KNOWN attack patterns the team may not think to list. The threat-category library ships that domain knowledge, modeled on Akshar's `.claude/threat-model-categories/*.yml`. A category names concrete threat patterns for one domain (authorization, key management, multi-tenancy), each with its CWE/CAPEC identifiers, prerequisites, and what to look for. A persona reviewing a repo in that domain gets the domain's known attack surface in front of it.

- **The library.** `plugin-security` ships ten category YAMLs under `categories/`: `authz`, `authn`, `multi-tenancy`, `key-management`, `crypto-wallets`, `secrets-handling`, `policy-engines`, `webhooks`, `parsers`, `state-machines`. Each follows the reference shape: `name`, `detect_when`, an optional `dedup` (which sibling category owns which threat), and `threat_patterns` (each with `description`, `cwe`, `capec`, `mitre_attack`, `skill`, `likelihood`, `prereqs`, `look_for`). The ids are grounded in real CWE/CAPEC; a `mitre_attack` may be null. `src/lib/categories.ts` exposes `KNOWN_CATEGORIES`, `isKnownCategory`, `categoryYaml`, `parseCategory`, and `categoryDigest`. Each YAML read is a static single-call `readFileSync(new URL("<literal>", import.meta.url), "utf8")` per id, the one shape the api bundle's inline-assets step embeds (the `.yml` extension is in its `ASSET_EXTS`).
- **Injection.** `buildDispatchPrompt` gained a `categories` field on its config parameter. When the engagement names categories, the pure function adds a "Threat categories loaded (domain attack surface to check against)" block to the same "Engagement configuration" section, set to `categoryDigest(categories)`: one heading per category, then one bounded line per pattern — `<pattern>: <description> (CWE-x, CAPEC-y) — look for: <first look_for items>`. `categoryDigest` skips unknown ids and returns `""` when none load, so an absent or stale list adds nothing. `dispatchCell` passes the engagement's parsed `categories` JSON column.
- **The edit route.** `POST /security/config` accepts `categories?` alongside `focus?`/`invariants?`. It validates every id against `isKnownCategory` and rejects an unknown one with a corrective error naming the known set. `setEngagementConfig` writes the `categories` column and refuses a running engagement, matching the focus + invariants rule. `parseSecurityConfig` applies the same validation to `.valet/security.yml`.
- **The panel + list.** During planning an admin picks categories from a checkbox multi-select and Saves through `useSetEngagementConfig`; once running or closed, the panel shows the loaded categories READ-ONLY. The web MIRRORS the known ids with a small local label list (`KNOWN_CATEGORIES` in `config-editor.tsx`); the server validates every saved id, so the mirror only names ids and labels. No GET endpoint lists the library.

## Web Surfaces

### `/security` — hub

Mirrors the `/design` hub pattern: a repo picker (the existing new-session repo binding UX), a preset picker (Full code review, Secrets & config, Access control & injection), an optional path-scope input, an optional prompt ("focus on the token minting paths"), and a list of past engagements with status and finding counts. Creating one calls `POST /api/sessions` with `kind='security'`, the repo binding, the chosen `preset`, and any `paths` globs; the engagement row is seeded in the same transaction with the preset plan, status `planning`.

### `/sessions/:id/security` — engagement panel

The session page for `kind='security'` sessions adds a security panel beside the thread (the design-canvas layout precedent, including the mobile Chat | Panel tab toggle so approval gates never hide):

- **Cell rail** — ordered cells with persona, status, attempt count, elapsed time, and a link to each cell's child session page. The running cell shows live progress parsed from its latest state doc (`checklist 14/47 · queue 3 pending`) — the tree makes progress free to render, and a scan that shows motion beats a static "running" badge for the half hour before the first finding. A compaction badge appears when the cell's thread compacted (from the compaction hook). An over-age running cell shows a warning state with the last child activity time.
- **Findings review** — the triage surface, specified below.
- **Manifest** — after `sec_close`, the manifest renders at the top of the panel: distinct-fingerprint counts by severity with the verified/refuted/open breakdown, and triage tallies (issues filed, findings dismissed by a human).

### Re-scan / iterate

A review is repeatable. After the team fixes issues, a re-scan re-runs the review against the newer code and shows what is new, still open, and fixed — without re-triaging the false positives the prior review already dismissed.

A re-scan is a NEW security session and engagement, linked to the prior one. `security_engagements.parent_engagement_id` (nullable, indexed, no unique constraint) names the engagement this run re-scans. `POST /api/sessions` accepts `rescanOf`, a prior security SESSION id: the create route loads that session's engagement (404 if the caller cannot view it or it has no engagement), reuses its repo binding and plan, and stamps the new engagement's `parent_engagement_id`. The request wins on any override — `preset`, `paths`, `model`, or a repo binding. The re-scan picks up new commits for free: `sec_start` resolves the LATEST default-branch SHA, so the same plan sweeps the newer tree.

**Carry-forward refutations.** When the engagement has a parent, `sec_finding_report` (the service) compares the reported fingerprint against the parent's findings. A parent finding that is `refuted` on this fingerprint makes the new finding land already `refuted`, with `status_reason` "Carried from the previous review: `<prior reason>`" and `status_actor` `carry-forward`. Only a dismissal carries. A parent `open` or `verified` fingerprint does NOT carry — a real issue resurfaces `open` for confirmation, so the reviewer re-checks live issues but never re-triages a false positive.

**Diff.** `GET /api/sessions/:id/security` adds a `diff` block when the engagement has a parent: `{ parentEngagementId, parentSessionId, newCount, recurringCount, fixedCount, carriedRefutedCount }`, compared by distinct fingerprint. `newCount` = fingerprints here, absent from the parent. `recurringCount` = fingerprints in both. `carriedRefutedCount` = findings this run auto-refuted by carry-forward. `fixedCount` = parent fingerprints that were `open` or `verified` and are ABSENT here — a fix. `fixedCount` is meaningful ONLY once the engagement is `completed`/`failed`: a still-running scan has not looked everywhere yet, so an absent fingerprint is not yet a fix. It is `null` while running and a number once terminal. The findings-list route marks each finding `recurring: boolean` (its fingerprint was in the parent) on a re-scan; the field is absent on a first review.

The hub row and the manifest card carry a "Re-scan latest" button on a terminal engagement — it creates with `rescanOf` and navigates to the new session. The new engagement's panel shows a banner ("Re-scan of the prior review — 3 new, 5 recurring, 2 fixed", the fixed count deferred while running) that links back to the parent session. Findings rows show a `new` / `recurring` badge; a carried-refuted finding shows the refuted chip, and its carry-forward reason reads in the detail pane's status history.

**Diff-scoped, reasoning-seeded re-scan.** A re-scan carries the prior reasoning and scopes the new work to the git diff, so the personas re-reason about the delta instead of re-deriving the whole review. The reasoning is the expensive part; a re-scan must not repeat it.

*Diff capture.* `sec_start` resolves the new HEAD SHA. When the engagement has a parent, `POST /security/start` computes the changed files between the parent's pinned SHA (base) and the new HEAD through the GitHub compare API (`GET /repos/{owner}/{repo}/compare/{base}...{head}`, read as `files[].filename`; `resolveChangedFiles` in `source-service.ts`). The base SHA persists on the child as `security_engagements.base_ref`, and the changed-file list as `changed_paths` (JSON array). Graceful fallback: a compare failure (a force-pushed base, an API error, or a parent with no pinned SHA) leaves the diff uncaptured and the re-scan runs a FULL scan. The start never fails on a diff error; the reason logs.

*Diff-scoped sweeps.* `startEngagement` derives changed-directory globs from the changed files (top-level and one-level dirs as `<dir>/**`, deduped, capped at 24 — a wider diff falls back to a full scan) and REWRITES the plan: the globs land on the sweep cells' `paths` (a cell that is not recon (ordinal 1) and not a `review` cell). Recon and verify stay repo-wide. Because the plan is rewritten, `/plan.yml`, the materialized `security_cells`, and the dispatch prompt's Scope line all carry the diff scope. A first review or a full-scan fallback materializes the plan unchanged.

*Prior-reasoning mounts.* A re-scan seeds C's tree with three read-only `/prior/` mounts, resolved against the parent engagement P: `/prior/diff.md` (the base→head SHA range and the changed-file list, or a full-re-scan note on the fallback), `/prior/recon.md` (P's recon state doc — P's ordinal-1 cell dir — or a short "no prior recon map" note), and `/prior/findings.md` (a digest of P's findings grouped by status: verified, open, refuted, each with severity, title, file:line, and a body excerpt). The mounts appear in `sec_fs_list` only on a re-scan; reading `/prior/*` on a first review returns a corrective error.

*Rescan-aware prompts.* `buildDispatchPrompt` takes a `rescan` flag (the engagement has a parent). The recon cell reads /prior/recon.md and /prior/diff.md and updates the prior map only for the changed files. Sweep cells read /prior/diff.md and /prior/findings.md, confirm which prior findings still apply, and do not re-review unchanged code. The verify cell reconciles /prior/findings.md against the current code — a prior verified/open finding whose file changed and no longer applies is reported or noted as fixed; the rest carry. The existing playbook and reads lines stay.

*Finding comments carry the human's reasoning.* During triage a human comments on a finding — "intended, the check is in middleware X", "confirm this is fixed next scan". A comment is a note on one finding, not a status flip. `security_finding_comments` holds one row per note (id, finding id, engagement id, body, author user id, created-at), with no unique constraint — a finding carries a thread. The comment route is VIEW-gated: any viewer may comment, because commenting is collaboration, not an admin action. It is human-only — a valid internal token is refused, so the runner and personas do not comment through it. On a re-scan, each parent finding's comments ride into `/prior/findings.md` under a "Notes:" line (as "team note: …"), so the persona reads the prior human reasoning, not just the status. This is the load-bearing carry: the digest is the one place the re-scan personas see the human's triage rationale.

The panel surfaces the scope near the re-scan banner: "Scoped to N changed files since `<short base sha>`", or "Full re-scan (prior commit unavailable)" on the fallback. Both read from `base_ref`/`changed_paths` on the engagement GET.

### Findings review

Triage is the product's core loop for the human, so it gets a real surface, not a table with a scrollbar. Master-detail layout:

**List (left)** — one row per finding: severity badge, title, `file:line`, status chip, source cell, link chips for filed issues (Linear/GitHub icons, opening the external issue). Groups collapse by fingerprint so five near-duplicates read as one row with a count. Filters across the top: severity, status, cell, path substring; sort by severity (default) or recency. The filter state drives export scope (below).

**Detail (right)** — the selected finding in full:

- Evidence body rendered as escaped markdown with the code excerpt in a block — findings are data from an agent that read hostile code, never HTML.
- `file:line` linking to the GitHub blob at the pinned SHA (derivable from the repo binding; a finding the user cannot jump to is dead text).
- Provenance: reporting cell and persona, state doc revision at report time, reported/reviewed timestamps, `status_actor` and `status_reason` history.
- Fingerprint siblings: other findings sharing the fingerprint, one click away.
- Actions: **Verify** / **Refute** (session admin; the forward-only review route with `status_actor: user:<id>` — false-positive fatigue is the product's first failure mode, and a finding the user cannot dismiss is fatigue with no relief valve), **File issue** (Linear or GitHub, below), **Fix** (invokes `sec_handoff` through the runner), **Copy permalink**.

Triage is keyboard-first: `j`/`k` move, `v` verify, `r` refute (with a reason prompt), `i` opens the file-issue dialog, `enter` opens the blob link. Reviewing forty findings must not take forty mouse trips.

### Export

An Export button on the findings header opens a dialog: format (**Markdown report** | **SARIF 2.1.0** | **JSON**), scope (**current filter** | **all findings**), then a download via authenticated fetch (`GET /api/sessions/:id/security/export?format=...&<filters>`). Export is view-gated, generated from rows (no sandbox involvement), and every export writes an audit event naming the actor, format, and row count.

SARIF mapping, normative: one `run` per engagement; `tool.driver.name = "valet-security"` with the persona as the rule source; `result.ruleId` = fingerprint; severity maps `critical`/`high` → `error`, `medium` → `warning`, `low`/`info` → `note`; `physicalLocation.artifactLocation.uri` = repo-relative file with `region.startLine`; the pinned SHA rides in `versionControlProvenance`. Refuted findings export with `suppressions` populated, not silently dropped — an auditor wants to see what was dismissed and why. The Markdown report is the manifest plus per-finding sections (evidence fenced with collision-safe fences); it is an export of the data, not a designed report (the report writer stays a non-goal).

### Filing issues

The file-issue dialog offers the providers whose integrations are connected; a missing one shows its corrective action ("Connect the Linear integration in Settings"). Filing goes through the existing integration actions via the server-side action invoker (`packages/api/src/plugins/action-invoker.ts`) with the acting user's credentials — no bespoke API clients:

- **GitHub** — `github.create_issue` (plugin-github, `issues:write`), default target the engagement's repo, override allowed in the dialog.
- **Linear** — the Linear MCP integration (plugin-linear); the dialog asks for the team on first use and remembers it per engagement.

The issue body is generated from the finding alone: severity, title, evidence, blob permalink, and a permalink back to the finding in Valet — never state docs or other findings. On success the server writes a `security_finding_links` row (the per-provider unique index makes filing idempotent) and the list shows the link chip. Bulk filing creates one digest issue from the current filter (a checklist of findings with permalinks), not N issues — a tracker flooded with forty auto-filed tickets is worse than no integration.

Issue filing and export are human-driven REST actions only. No agent tool files issues or exports findings (Decision 10): content derived from hostile code leaves Valet only on a human's click.

### Data and events

Data over REST (`GET /api/sessions/:id/security` for engagement + cells, `/security/findings` for findings with filters and cursor, `POST /security/findings/:findingId/status` for human review, `POST /security/findings/:findingId/issues` and `POST /security/issues/digest` for filing, `GET /security/export` for export); live updates over `security.cell.updated` / `security.finding.updated` wire events on the session WebSocket via the engine `host_event` seam, with query polling as the fallback until that seam lands.

Tool renderers: `sec_dispatch` (cell card with child link), `sec_finding_report` (severity-badged finding card), `sec_cell_complete` / `sec_close` (status summaries). New renderer files listed before the fallback in the registry.

## Security Model

The note's threat list, plus what running inside Valet adds:

1. **Schema drift** (note #1). `sec_fs_write` validates YAML parse and `protocol_version` server-side on every `state.yml` write; the protocol ships in the plugin, so personas and server cannot see different versions.
2. **History rewrite** (note #2). Every tree path is append-only revisions; findings are insert-only with forward-only status. No update route exists to abuse.
3. **Silent truncation** (note #3). The exit condition is checked by `sec_cell_complete` on the server, not grepped by the runner. Scope honestly: this defeats accidental early exit. A persona that self-certifies `pending: 0` without doing the work passes the arithmetic — the recon-seeded checklist and the verify cell narrow that gap, server-seeded checklists close it later.
4. **Lost work across restarts** (note #4). State doc writes are single-row transactions; dispatch and completion are transactional with their side effects. Recovery is a read.
5. **Cross-contamination** (note #5). Report generation is out of scope for v1; findings are immutable once written, so a future report writer consumes fixed inputs.
6. **Child recursion blowup** (note #6). The engine gives child sessions no spawner. Structural, not contractual.
7. **Stranded partial work** (note #7). Over-age running cells surface in metrics and the cell rail; re-dispatch is explicit. Alert, don't auto-repair.
8. **Prompt injection from the scanned repo.** Personas read hostile code by design. Blast radius: a compromised persona can write only under its own cell directory (path-prefix claim) and report findings for its own cell, cannot flip other cells' finding statuses unless its plan cell carries `review: true`, cannot spawn children, cannot reach other sessions' sandboxes (gateway `sid` check), and holds only repo-read credentials. Findings render escaped in the client.
9. **Cost blowout.** The `sec_start` gate names the cell count, personas, and a rough cost estimate before anything spawns; dispatch is serial; the plan is capped at 32 cells; findings are capped at 100 per cell. Per-engagement token budgets are a re-entry seam (the Valet Design threat-7 precedent).
10. **Cross-tenant reads.** Every `/security/*` route resolves session → engagement → owner and applies the session's existing access checks; persona tools additionally require the cell claim. Mutating routes get named `can*` checks, per the explicit-authz rule.
11. **Findings disclosure.** Findings are visible only to principals who can view the session. The two egress channels — export and issue filing — are human-initiated REST actions, never agent tools, so hostile-code-derived content leaves Valet only on a human's click. Exports are view-gated and audit-logged with actor, format, and row count. A filed issue carries only its own finding, never state docs or peers. There is no anonymous share link.

## Dependencies

- **`agent_sessions.kind`** ships in the Valet Design PR (#396). Valet Security extends the value set with `'security'`. If this lands first, it carries the same `ALTER TABLE` + repair statement and #396 rebases; the column shape is identical either way.
- **`host_event` engine seam** (also #396) carries `security.*` wire events. Until it lands, the panel polls; no spec change either way.
- **Settlement signals to a non-orchestrator parent.** The runner is hub-created (engine purpose `interactive`), and the loop's self-advance depends on `child.settled` signals being admitted to it (`admitSignal`'s edge ACL, `packages/api/src/orchestrator/signals.ts`). The child edge exists in `child_watches` because `sec_dispatch` creates it, but the ACL's treatment of interactive-purpose parents is an implementation checkpoint: verify it, or the loop silently degrades to user-poked. Same check for the runner's `child_send`/`child_status` wiring outside orchestrator purpose. **Checkpoint result (M3):** verified — the ACL's parent↔child rule authorizes from the child's durable `parentSessionId` and never reads the parent's purpose, so the edge admits with no `signals.ts` change. `packages/api/src/integration/security-settlement.test.ts` is the tripwire: dispatch through the real spawner, settle the child, assert the signal lands on the runner thread with an empty drop log.

## Non-Goals (with Re-Entry Seams)

| What | Why out | Re-entry |
|---|---|---|
| Report writer / report designer | Note excludes; v1 output is the manifest + findings table | New persona + a `security_reports` table consuming immutable findings |
| Independent-model verification | v1's verify cell is the same persona/model refuting itself | A `verifier` persona pinned to a different model via the child `model` param |
| Server-seeded checklists | Recon seeds the checklist in v1; the server only checks arithmetic | Server derives the file inventory at `sec_start`, writes it as a read-only mount, measures coverage against it |
| Concurrent cell dispatch | Note excludes; serial keeps the loop and cost legible | Lift the one-live-child check in `sec_dispatch`; the `reads` DAG already names which cells are independent |
| Concurrent engagements per session | One engagement per session keeps session == engagement | Drop the unique index on `session_id`, add engagement id to tool args |
| Field-level state doc schema validation | Note excludes; parse + version check only | TypeBox schema on `sec_fs_write` for `state.yml` behind `protocol_version` 2 |
| Scheduled / CI-triggered engagements | v1 is chat-initiated | Workflow trigger node creating `kind='security'` sessions |
| GitHub code-scanning upload | SARIF export ships; pushing it into GitHub's code-scanning API is a separate disclosure surface | Upload action on the existing export, gated like issue filing |
| Org-wide findings dashboard | v1 findings are engagement-scoped | Cross-engagement query over the same tables, keyed by org and fingerprint |
| Org-authored custom personas | v1 personas ship in the plugin | Persona registry keyed by org, same dispatch path |
| Multi-repo engagements | One repo, one pinned SHA keeps determinism | `repos` array on the engagement; cells name a target dir |
| Cross-engagement finding memory | Dedup is per-engagement fingerprint only | Fingerprint lookup across an org's engagements |

## Acceptance Scenarios

Integration tests at the API level, `packages/api/src/integration/security-acceptance.test.ts`, virtual sandbox provider. [M10: the suite runs with no ANTHROPIC_API_KEY — runner threads stay paused, children settle by abort (a real settlement), and `sec_*` tool calls are emulated as the tools perform them: internal token + acting session header against the same routes. Shared moves live in `security-harness.ts`.]

### Scenario A: code-review engagement end to end

1. Hub creates a session with `kind='security'` and a repo binding; engagement seeded with the code-review preset, status `planning`.
2. Runner refines the plan via `sec_plan_set` (chat: "skip the secrets sweep"); plan validates; `reads` edges re-validate.
3. `sec_start` opens an approval gate naming repo, SHA, 4 cells, persona, cost estimate. User approves; cells materialize with `dir` and `reads` stamped; status `running`. [M10: the gate payload is asserted in `engine/security-tools.test.ts`; the acceptance test drives the post-approval start route with a fake 40-hex SHA, which resolves offline.]
4. `sec_dispatch` spawns cell 1's child with the repo pinned to the SHA; cell 1 is `running` with a `child_session_id`.
5. The recon persona writes state doc revisions; the cell rail's progress counts update from them.
6. Child settles with `status: done` and pending counts zero; `sec_cell_complete` passes; cell 1 `completed`.
7. Cell 2 (authz, reads: 01) dispatches; its prompt names only `/cells/01-recon/state.yml`; the persona reads it verbatim via `sec_fs_read` and reports two findings with evidence bodies.
8. Cell 3 (injection) repeats. The verify cell dispatches, reads all prior state docs, and `sec_finding_review`s one finding to `refuted` with a reason.
9. `sec_close` returns a manifest: 4 completed cells, distinct-fingerprint counts by severity, 1 refuted. Engagement `completed`.
10. The findings table and cell rail reflect every transition (REST assertions); a finding row carries the GitHub blob link at the pinned SHA. [M10: the wire carries rows, not rendered links (deviation 12's precedent) — the test asserts the pinned `repoRef` the client derives the blob link from.]

### Scenario B: api restart is a non-event

1. Run Scenario A through step 4, then simulate an api restart mid-cell-2 (engine reload). [M10: emulated in-process — `engineHost.evictAll()` drops all in-memory session state, then the test mirrors main.ts's boot over the same PGlite db (`sessionFor` every unsettled session, `rearm()` on a FRESH `ChildWatcher`). The process boundary itself (fresh WASM handle) is held by `orchestrator-restart.test.ts` for the same spawn/watch/rearm machinery; repeating it here would gate the suite on a real model key.]
2. On boot, `ChildWatcher` re-arms the unsettled watch; cell 2's child resumes and settles with no user action.
3. The settle signal wakes the runner; the loop continues through `sec_cell_complete` and the next dispatch.
4. Assert: no re-dispatch happened (cell 2 `attempts` is 1), cell 1 never re-ran, and cell 1's finding and state doc row ids are unchanged.

### Scenario C: exit condition enforced

1. A persona settles while its latest state doc shows `status: done` but `queue.pending: 2`.
2. `sec_cell_complete` refuses, naming the violation.
3. Runner `child_send`s the persona to continue; the persona drains the queue, writes a final state doc, settles. [M10: the steer's EFFECT is asserted — the same claimed child writes the corrected doc while the durable watch stays settled; `child_send` itself is generic children.ts plumbing with its own suite.]
4. `sec_cell_complete` passes. Assert the cell never showed `completed` before the pass.

### Scenario D: yield and child death

1. A persona checkpoints and settles with `status: yielding`, `queue.pending: 31`.
2. `sec_cell_complete` marks the cell `yielded`; the runner calls `sec_dispatch { cell_id, mode: 'resume' }`; `attempts` becomes 2.
3. The fresh child reads its own latest state doc, continues from the queue, and completes; assert findings reported before the yield survive with stable ids.
4. Separately: a running cell's child is destroyed (sandbox reclaimed, no settle). `sec_status` shows the child gone; the runner calls `sec_cell_fail` then re-dispatches with `mode: resume`; the cell completes on attempt 2. [M10: steps 1–3 are held by `security-yield.test.ts`; step 4's destruction rides the session DELETE route — the "gone" signal the child status reader reports.]

### Scenario E: triage, export, file issues

Web-level tests beside the panel components; API-level tests for the routes. [M10: split across suites — steps 1 (admin flip + actor stamp), 2 (audit row), and 3's link chip live in `security-triage.test.ts`; the acceptance suite adds SARIF provenance from a started engagement, route-level filing through a faked `github.create_issue` with a provider call count, the digest body, the Linear corrective 400, and the non-admin 403.]

1. From Scenario A's completed engagement, a session admin refutes one open finding with a reason; the row's status chip updates; `status_actor` is `user:<id>`; a non-admin gets a 403 naming the required right.
2. The user filters to `severity: high, status: open` and exports SARIF; the download contains only the filtered set, `result.ruleId`s equal fingerprints, the pinned SHA is in `versionControlProvenance`, and the refuted finding appears in `suppressions` when exported unfiltered. An audit event records actor, format, and row count.
3. The user files a GitHub issue from a finding; `github.create_issue` is invoked with the user's credential; a `security_finding_links` row appears; the list shows the link chip. Filing again is a no-op returning the existing link.
4. With Linear not connected, the dialog's Linear option names the corrective action ("Connect the Linear integration in Settings").
5. Bulk-filing the current filter creates one digest issue whose body lists each finding with a permalink.

## Resolved Decisions

**Decision 1: substrate is app tables; the interface stays a filesystem. RESOLVED.** Child sessions do not share a filesystem, and the gateway's `sid` check makes cross-sandbox reads impossible by design. Rows give the same recovery-by-read property plus transactionality, immutability enforcement, and a free UI read path. The tools stay path-addressed (`sec_fs_write`/`sec_fs_read`/`sec_fs_list`, the `mem_write` path-param shape) so personas keep the note's filesystem mental model, dispatch prompts name literal paths, and new artifact types need no new tools. The persona's YAML state doc survives verbatim at a conventional path.

**Decision 2: the runner is an agent session with server-enforced transitions, not a workflow DAG. RESOLVED.** Plans are authored and edited in chat, cells re-dispatch adaptively, and locked decision 5 makes agent sessions the orchestration primitive. The routes enforce every transition, so agent unreliability cannot corrupt the state machine — it can only stall it, which `sec_status` makes visible. Compiling a plan to a workflow definition is a re-entry seam, not v1.

**Decision 3: dispatch is a dedicated tool, not the generic `task` tool. RESOLVED.** `sec_dispatch` wraps the same `ChildSpawner` but binds spawn + cell bookkeeping in one transaction and pins the repo ref. A generic `task` call could spawn a child the engagement does not track.

**Decision 4: findings are structured rows, not parsed out of state docs. RESOLVED.** The UI, dedup, and the future verifier need typed findings; scraping YAML for them is the shape-drift bug this repo keeps paying for. The state doc references finding ids instead of embedding bodies.

**Decision 5: one persona in v1 — `code-review`. RESOLVED.** The note's scope: prove the coordination model with one concrete persona. Presets express multi-cell plans with that one persona. Three presets ship — `code-review`, `secrets-config`, `access-injection` — differing only in which middle sweeps run; all share the recon and verify bookends. The hub chooses the preset and an optional path scope at create time. Create-time control is the robust MVP: the planning window is brief and an in-panel plan editor carries ordering subtleties, so plan edits stay in chat before `sec_start`.

**Decision 6: the protocol ships in the plugin, not at a URL. RESOLVED.** Injected into every dispatch prompt and validated by the same server build — no fetch dependency, no drift window.

**Decision 7: yield is first-class, not a failure. RESOLVED.** Real repos exceed one child context, so fresh-context resumption is the loop's normal gait. A persona settles with `status: yielding`; the cell goes `yielded`; re-dispatch resumes it. Without this, every long cell reaches resumption through `sec_cell_fail`, which poisons the attempts metric and the alerting built on it. `child_send` is reserved for exit-condition violations, where the existing context is still viable.

**Decision 8: the plan is a DAG and dispatch context follows its edges. RESOLVED.** Cells declare `reads: [ordinals]` (earlier ordinals only — acyclic by construction). The dispatch prompt injects only the declared cells' state doc paths; `sec_fs_list` keeps the rest discoverable. Selective context keeps persona contexts small at the source, and the same edges are the future parallel-dispatch seam.

**Decision 9: verification ships in v1, inside the preset. RESOLVED.** The verify cell is the same `code-review` persona with a refute goal, using `sec_finding_review` and the status enum — no new machinery, one more cell. Evidence requirements at `sec_finding_report` (excerpt + reasoning, 200-char floor) raise the refutation target above vibes. Unverified LLM findings are the product's dominant failure mode; shipping the mechanism unused (the earlier draft) optimized for a bad first demo. Independent-model verification stays a re-entry seam.

**Decision 10: findings leave Valet only on a human's click. RESOLVED.** Export and issue filing are REST actions from the review surface; no `sec_*` tool exposes them to the runner or personas. A persona reads hostile code by design, and an agent-drivable egress path is the exfiltration channel threat 8 works to contain. `sec_handoff` stays agent-reachable because its output is another Valet session, not an external write.

**Decision 11: issue filing reuses integration actions, not bespoke clients. RESOLVED.** GitHub goes through `github.create_issue` (plugin-github, `issues:write`); Linear goes through the Linear MCP integration (plugin-linear); both invoked server-side via the action invoker (`packages/api/src/plugins/action-invoker.ts`) with the acting user's credentials. A second GitHub client or a raw Linear API dependency would duplicate auth, scopes, and error handling the plugins already own. The `security_finding_links` unique index, not the provider, is the idempotency guard.

## Deviations from the Concept Note

1. **The disk is a database; the interface is still a filesystem.** Forced by session-isolated sandboxes; see The Move. Personas keep path-addressed reads and writes (`sec_fs_*`), the note's thesis properties are preserved, and two of its exclusions (transactional work-list writes, atomic state-before-status ordering) dissolve.
2. **Exit condition moves server-side.** The note's orchestrator greps the persona's file; a Valet runner is an LLM, so the check that defeats silent truncation cannot live in its judgment. `sec_cell_complete` owns it.
3. **Findings are first-class rows** referenced by the state doc, not embedded in it (Decision 4).
4. **Recursion prevention is structural.** The engine's children get no spawner; the note enforces this in persona markdown.
5. **State doc writes are validated at write time** (YAML parse + protocol version). The note defers all validation to trust; a parse check at the write boundary is nearly free and converts threat #1 from "state becomes unreadable" to a tool error the persona fixes immediately. Field-level schema validation remains excluded, as in the note.
6. **The plan gains a human gate.** `sec_start` puts an approval in front of the spawn plan — Valet's cost and audit posture, absent from the note's CLI framing.

## Deviations from this spec (implementation, M4–M9)

1. **`sec_dispatch` stamps `child_session_id` BEFORE the spawn**, not after. The Tools section's "in one transaction: spawns ..., stamps ..." ordering is impossible in practice: the host builds the child's engine session inside the spawn, and that build resolves the cell claim to attach the persona tool set and role — the claim must already exist. The claim UPDATE (status `running`, `attempts` + 1, pre-minted `child_session_id`, `dispatched_at`) runs first; a spawn failure restores the row's prior values.
2. **The write claim expires with the attempt.** The persona routes resolve the claim only while the cell is `running`. A settled cell's child gets the corrective 403 ("This session is not a dispatched persona cell."); a yielded cell's replacement child holds the next claim.
3. **The persona role rides the engine's per-turn role mechanism.** The claimed child's build registers plugin-security's `code-review` `RoleSpec` in its `roles` option, and the dispatch prompt is submitted with `role: <persona>` — the engine overlays the role's markdown on the system prompt for that turn (`Thread.applyRoleForTurn`). Steered turns (`child_send`) run without the overlay; the protocol mount and the persona's own state doc carry the contract across them.
4. **Protocol pruning protection is a dedicated tool, not a `sec_fs_read` flag.** The engine's pruning protection is per tool name (`planPrune` matches `part.toolName`; `ToolDef.protectedFromPruning` is all-or-nothing for the tool) — there is no per-arguments protection. Flagging `sec_fs_read` would pin EVERY tree read into context forever: personas re-read state docs by design, state docs run to 256 KB, and a long cell would drown in its own protected reads. So the persona set gains `sec_protocol_read` (`{}` → `/protocol.md`) with `protectedFromPruning`, and `sec_fs_read` stays prunable. The protocol's rehydration rule names both tools.
5. **The export audit event rides `action_invocations`.** The codebase has no user-facing audit table; the closest durable mechanism is the policy audit sink (`persistInvocationAudit` over `action_invocations`, `policies/service.ts`). Each export writes one row: `invocation_id` `sec:export:<uuid>`, `action_id` `security.export`, the actor's user/org/session ids, and `params` `{ format, rowCount, engagementId }`. A dedicated audit table would be a new subsystem this feature does not justify alone.
6. **The Linear issue-creation tool name resolves upstream at run time.** plugin-linear is an `mcpActionPlugin`: the invoker discovers tools via `tools/list` on each dispatch. Filing invokes `linear.create_issue` with `{ title, description, team }` — the sibling of the `list_issues` name the plugin's templates verified live. An upstream rename fails the filing with the invoker's own "unknown action" error rather than silently. The MCP result is text, so the link mapper reads JSON-text shapes first and falls back to scraping the `linear.app` URL and `ABC-123` identifier from prose.
7. **SARIF ships as `application/sarif+json`,** the media type the SARIF tooling ecosystem and GitHub code scanning use, with a `.sarif` filename extension. Markdown ships as `text/markdown`, JSON as `application/json`; all three set a `Content-Disposition` attachment named `valet-security-<engagementId>.<ext>`.
8. **Triage authz answers 403 only to viewers.** A caller who cannot view the session keeps the existence-hiding 404. A viewer without the admin right gets the named 403 ("Only a session admin can verify or refute findings (canAdministerSession)…"). All four triage routes refuse a valid internal token with 403 before any lookup (Decision 10 — the runner must not review, export, or file).
9. **The digest is deliberately not idempotent.** It writes no `security_finding_links` rows (it is not per-finding linkage), so a repeated digest call files a new issue. The per-finding route stays idempotent through the unique index.
10. **The hub list shows engagement status, not finding counts.** `GET /api/sessions?kind=security` returns session summaries, and `GET /api/sessions/:id/security` (the hub's per-row read) returns the engagement and cells; the per-severity counts live only on `GET /api/sessions/:id/security/status`, which also performs a child-status read per call. Rather than widen the list API or make the hub pay that read per row, counts stay on M8's engagement panel.
11. **Evidence renders through the chat markdown renderer, which never parses HTML.** `~/components/markdown` is react-markdown without `rehype-raw`: embedded HTML in a finding body stays escaped text, never elements. This satisfies "escaped markdown" without a second renderer; a hostile-body component test asserts no `img`/`script` element reaches the DOM. Finding titles in tool cards render as plain text nodes.
12. **The manifest card derives from rows, not from `sec_close`.** The manifest exists only in the runner's tool result text; no GET returns it. The panel computes distinct-fingerprint severity counts, the status breakdown, and the triage tallies from the cells + findings queries it already holds, so the card needs no new route.
13. **The Fix action seeds the composer, it does not auto-send.** It writes "Spawn a fix session for finding `<id>` via sec_handoff" into the composer-prefill store (the memory-doc precedent) and focuses the input. Sending stays a human keystroke — consistent with the human-gate posture, and it avoids a second message-submission path outside the composer.
14. **Verify stamps a default reason.** The status route requires a non-empty reason for both verdicts, but the keyboard contract makes `v` a single keystroke. Verify sends "Verified from the findings review surface."; refute always prompts.
15. **The Linear team picker is a text input.** The web app has no Linear team-listing client (plugin-linear is MCP-backed; its tools resolve at run time), so the dialog takes a team id/key and remembers it per engagement in localStorage (`sec-linear-team-<engagementId>`).
16. **The export scope carries severity/status/cell, not the path filter.** The export route does not accept `path`; the dialog says so when a path filter is active instead of silently narrowing or silently widening the scope.
17. **The panel's GitHub availability reads two signals.** GitHub filing is available when the repos read reports a usable GitHub connection (`GET /api/me/repos` `connected`) or the `github` credential service is connected — the same pair the server-side token resolver draws from. Linear reads only its credential service.
18. **Severity colors map to the theme's tokens.** The theme ships no orange or standalone yellow scale, so: critical → danger (red), high → amber, medium → the warning wash, low → accent (the brand blue), info → neutral. One spelling in `components/security/severity.tsx`, shared by the review list and the `sec_*` tool cards.
19. **The stock image bakes gitleaks only; semgrep is deferred.** The image base (`node:22-bookworm-slim`) carries no Python runtime, and semgrep is a Python package — baking it would add a whole toolchain for one scanner (plan risk 6 pre-authorizes gitleaks-only). gitleaks 8.30.1 is pinned in `docker/Dockerfile.sandbox-k8s` with a per-arch sha256 check, and its default ruleset is compiled into the binary, so it scans offline. The persona role names gitleaks plus any repo-local scanners the clone carries instead of promising semgrep. Semgrep returns if the image ever gains a Python runtime for another reason.
20. **The engagement-runner skill does not attach globally.** Plugin skills have no scoping mechanism — `pluginSessionExtras` attaches every registry plugin's skills to every session. The skill instructs a loop only `kind='security'` runners have the `sec_*` tools for, so the host (`basePlugins` in `packages/api/src/engine/host.ts`) filters the security plugin out of the registry set on every session build and re-adds the directly imported manifest only on the runner path. The plugin stays registry-enabled for discovery; the code-review role likewise attaches only on cell-claimed children (and on the runner itself).
21. **A security session gets a capable default model, and personas inherit it.** `resolveModelForBuild` (`packages/api/src/engine/host.ts`) bottoms out at `claude-haiku-4-5`, which is too weak for review. So `POST /api/sessions` now accepts an optional `model`, and the effective session model is `body.model ?? (kind === "security" ? "claude-sonnet-4-6" : undefined)`. The create route persists it before the kickoff turn through the same `setModel` path PATCH uses — the security kickoff fires during create, so the model must be set first or the first turn runs on haiku. The setModel call is best-effort, like the kickoff: it logs and does not fail the create. The hub's New review card ALWAYS sends a model (a picker defaulting to `claude-sonnet-4-6`, sourced from `GET /api/models` or the curated `MODEL_CATALOG` fallback). The dispatch and handoff routes read the live runner session's resolved model and pass it into the child spawn (`SpawnChildRequest.model` → `childSessionFor` `modelId` → `resolveModelForBuild` override), so every persona and every handoff fix session runs on the runner's model, not the haiku floor.
22. **The autonomy nudge is a stateless sweep, not a settlement watcher.** `SecurityRunnerDriver` polls planning/running engagements and re-drives an idle runner (no cell `running`, no unsettled submission) through `submitSessionPrompt`, the same path the kickoff uses. A settlement watcher would miss the gaps the poll covers: a turn that ended without the next tool call, a signal that never landed. Idle is defined by `listUnsettledSubmissions` being empty, which is why an approval gate (an unsettled submission) never draws a nudge. The stall cap keys an in-memory budget by a progress signature and alerts once via `valet.security.runner.stalled` after N no-progress nudges — alert, don't auto-repair. The runner skill's Autonomy note tells the runner not to depend on the sweep.
23. **A full-SHA repo ref clones by checkout, not `--branch`.** The engagement pins `repo_ref` to a resolved commit SHA (the determinism guarantee), but `git clone --branch <sha>` fails — the flag takes a branch or tag name only. `cloneFresh` (`packages/api/src/engine/workspace-prep.ts`) detects a 40-hex ref, clones without `--branch`, then does a detached `git checkout <sha>` from the fetched history. Public repos resolve and clone anonymously: `resolveApiTokenOrNull` returns `null` when no credential is configured, `resolveRefSha` with an empty ref resolves the default-branch HEAD unauthenticated, and a public clone needs no token.
24. **The hub reviews any public repo, not only listed ones.** The repo picker lists a user's connection and org-App repos, but a public repo needs neither. The New review card adds a free-text input (`parsePublicRepo`: `owner/repo`, a GitHub URL, or an SSH URL → an `https://` clone binding with `auth: "auto"` and no ref). The card shows it even with no GitHub connection. The create route already accepts any binding and does not gate on org membership, so this is a hub-only affordance over machinery that already supported it.
25. **Handoff fix sessions are recorded and surfaced per finding.** `sec_handoff` spawned a fix child but recorded nothing, so no surface listed or opened it — persona cell children show in the cell rail, handoff children had no home. The handoff route now writes one `security_handoffs` row (id, engagement id, finding id, child session id, title, optional task, creator, created-at) after the spawn. The insert runs in the route's spawn try but wrapped in its own catch: the child already exists, so a lost link row logs and still returns the child id — it must not 500 the tool. The findings-list route attaches `handoffs` per finding through one grouped `inArray` query, the same shape as the issue-link chips. The finding detail pane adds a "Fix sessions" section that opens each child through the in-page `?child=` slide-over (`onOpenChild`), falling back to the child's standalone page when no handler is threaded; the finding list row shows an "N fix" count badge as the entry point. A finding may spawn several fix sessions, so the table has no unique constraint.
26. **Preset and path scope are create-time, and the web mirrors the preset list.** `POST /api/sessions` accepts `preset` (default `code-review`) and `paths`. For a security session the route validates `preset` with `isKnownPreset` (400 naming the known ids), checks `paths` is a string list, and seeds `presetPlan(preset, { paths })`. `presetPlan` injects the globs onto the middle sweeps only (authz, injection, secrets-config); recon and verify stay repo-wide, and `code-review` with no paths returns the exact string `codeReviewPresetPlan` emits. The hub can not import `@valet/plugin-security` — its barrel pulls node builtins through the playbooks module — so the New review card mirrors `SECURITY_PRESETS` as a local const; the server-side `isKnownPreset` check is the gate. The path input splits on commas and whitespace and sends `paths` only when non-empty.
26. **A running engagement can be cancelled — a human action.** `POST /api/sessions/:id/security/cancel` stops a `planning` or `running` engagement. The engagement gains a fifth status, `cancelled`; the column is `text`, so the value needs no migration (only the Drizzle enum and the wire union list it). `cancelEngagement` (the service, the one owner of every transition) fails every unsettled cell (`pending`/`running`/`yielded`) with settled-at stamped, flips the engagement to `cancelled`, and returns a running cell's `child_session_id` in one transaction. `dispatchCell` and `closeEngagement` refuse a cancelled engagement, so it never re-runs or re-closes. The route is human-only: `resolveHumanSession(.., "administer")` refuses a valid internal token with 403 (the runner must not cancel itself, the triage-route posture) and gates on `canAdministerSession`. If a cell had a running child, the route tears it down through the session-terminate seam DELETE `/api/sessions/:id` uses — `engineHost.destroy` then a `status: 'deleted'` soft-delete, not a hand-rolled sandbox destroy. Teardown is best-effort: the status flip is the source of truth, so a destroy failure logs and the cancel still succeeds. The nudge sweep is unaffected — it queries `planning`/`running` only, so a cancelled engagement draws no nudge. The panel shows a "Cancel review" button (a `ConfirmDialog` step) while the engagement is `planning`/`running` and the caller can administer; the hub badges `cancelled` as neutral.
27. **A completion notification fires when a review ends.** `closeEngagement` and `cancelEngagement` flip the engagement to a terminal status, but the service holds no attention deps — so the ROUTE emits the ping after the service returns. The close route and the cancel route call `routeAttention` (the one path that writes a `notifications` row) with kind `notification`, the session owner as audience (`sessionOwner(row)`), an href to the session page (the `attentionHref` shape attention-wiring uses), and a body naming the repo and the distinct-fingerprint severity roll-up ("12 findings — 2 critical, 3 high" on complete; "… ended" on a failed close; "… cancelled" on cancel). The `AttentionDeps` reuse the boot-time deliverer: `{ db, channels: [channelHost.attentionDeliverer()] }`, the same pair `wireAttentionRouter` passes at boot, so web and any wired channel both fire. A stable dedupe key `security-close:<engagementId>` makes a re-close or retry a no-op — a review ends once, whether the human or the runner (via `sec_close`) closes it, or the human cancels it. The emit is best-effort: a notification failure logs and never fails the close or cancel.
28. **The engagement carries its spend, runner plus cell children.** `getEngagementCost` (the service) sums `cost_entries` over the runner session (`engagement.session_id`) and every cell's `child_session_id`. Fix-session handoffs (`security_handoffs.child_session_id`) are separate follow-up work and are NOT counted — the review cost is the runner and its cells. The sum reads `cost_total` and `total_tokens`; `priced` is false when any counted turn is unpriced (`cost_total IS NULL`, an unpriced provider), never treated as zero. An empty id list (planning, no runner turn) returns zeros without a malformed `IN ()`. `GET /api/sessions/:id/security` adds `cost { costUsd, totalTokens, priced }` — one extra query per poll, kept live during the run and after close. The panel header shows a compact chip ("1.2M tokens · ~$0.42") next to the status, and the closed-engagement manifest card shows a final "Review cost" line; both reuse the usage dashboard's `formatTokens`/`formatUsd`. When `priced` is false the surface shows tokens plus a muted "cost n/a"; a zero total renders nothing.
29. **Re-scan lineage is `parent_engagement_id`, and carry-forward runs at report time.** `security_engagements.parent_engagement_id` (nullable, indexed, no unique constraint) links a re-scan to the engagement it re-scans; a parent may be re-scanned any number of times. It is an in-place `0000_app.sql` edit with a matching `SCHEMA_REPAIRS` column-and-index pair — the whole-table `CREATE TABLE IF NOT EXISTS` does not add a column to an existing table. `POST /api/sessions` takes `rescanOf` (a prior SESSION id): the route loads the prior engagement (existence-hiding 404 on a non-viewable session, a non-security session, or one with no engagement), reuses its repo binding and plan unless the request overrides `preset`/`paths`/`model`/repo, and passes `parentEngagementId` to `createEngagement`. Carry-forward is a `reportFinding` responsibility, not a separate sweep: on a child engagement, a reported fingerprint that the parent `refuted` inserts already `refuted` (`status_actor` `carry-forward`), and the result carries `carriedFrom` so the persona-report tool text notes it. Only a refuted verdict carries; an open/verified parent fingerprint resurfaces `open`. The diff (`diffEngagement`) and the per-finding `recurring` flag are computed by distinct fingerprint against the parent; `fixedCount` returns `null` until the engagement is terminal, because a running scan's absent fingerprint is "not looked yet", not "fixed". The "Re-scan latest" button (`useRescanReview`) lives on the hub row and the manifest card of a terminal engagement; the diff banner (`RescanDiffBanner`) renders in the panel — above the header while running, inside the manifest card once closed.
30. **A re-scan carries the prior reasoning and scopes to the git diff, injected by rewriting the plan.** The re-scan re-derived every checklist and recon map from scratch and re-scanned the whole repo — the reasoning is the expensive part. Now `POST /security/start` computes the changed files between the parent's pinned SHA (`base_ref`) and the new HEAD through the GitHub compare API (`resolveChangedFiles`, `source-service.ts`), captured on the child as `base_ref` + `changed_paths` (two in-place `0000_app.sql` columns with matching `SCHEMA_REPAIRS` entries). The diff is computed in the ROUTE because the new SHA arrives only there; a compare failure logs and falls back to a full scan, never failing the start. `startEngagement` derives changed-directory globs (top-level and one-level `<dir>/**`, deduped, capped at 24) and REWRITES `engagement.plan` — the globs land on the sweep cells' `paths` (not recon (ordinal 1), not `review` cells). Rewriting the plan (rather than adding a `security_cells.paths` column) makes `/plan.yml`, the materialized cells, and the dispatch-prompt Scope line all carry the scope for free, because `buildDispatchPrompt` already reads `planCell.paths`. Three read-only `/prior/` mounts seed C's tree from the parent P: `/prior/diff.md` (SHA range + changed files, or a full-re-scan note), `/prior/recon.md` (P's ordinal-1 recon state doc), `/prior/findings.md` (P's findings grouped by status). The mounts list only on a re-scan; `/prior/*` on a first review errors. `buildDispatchPrompt` takes a `rescan` flag (parent present) that adds recon-inherit, sweep-scoped, and verify-reconcile language naming the `/prior/` files. The panel shows "Scoped to N changed files since `<short base sha>`" or "Full re-scan (prior commit unavailable)" from `base_ref`/`changed_paths` on the engagement GET.
31. **Dynamic config is loaded at create, and the persona role attaches per cell (M-F1).** The persona registry moved to `plugin-security`'s `BUNDLED_PERSONAS` (`src/lib/personas.ts`), keyed by id; `KNOWN_PERSONAS` now equals the bundled ids, so a new bundled persona gates `parsePlan` for free. The plugin manifest builds one `RoleSpec` per bundled persona, and the host attaches ONLY the role matching a claimed cell's `security_cells.persona` (`securityRolesForCell` in `packages/api/src/engine/host.ts`), not every security role — a repo-defined persona with no bundled role falls back to `code-review` with a logged note (loading a repo persona's markdown from the clone is a noted follow-up). `POST /api/sessions` reads `.valet/security.yml` through the GitHub contents API before the sandbox exists (`fetchRepoFile`, `source-service.ts`, 404 → null, default branch); a present-and-valid config with `steps` seeds the plan from `configToPlanYaml(config)` and stores the config context, while an absent, unreadable, or invalid config falls back to `presetPlan(preset, { paths })` and logs the reason. `parseSecurityConfig` validates `version === 1`, the string-list fields, the `personas` map, and the `steps` (through `parsePlan` against bundled ids ∪ repo persona keys). Six in-place `0000_app.sql` columns hold the context — `focus` (text), `invariants`/`categories`/`config_personas`/`config_tools` (JSON), `has_repo_config` (boolean, default false) — each with a matching `SCHEMA_REPAIRS` entry. `GET /api/sessions/:id/security` exposes them; the panel header shows `Configured by .valet/security.yml` vs `Preset: Code review`. A `rescanOf` re-scan inherits the parent's plan (config re-fetch on re-scan is deferred). M-F1 stores and exposes the context but does NOT wire invariants into prompts (that is M-F3).
32. **The planning-phase step editor edits the plan through a structured route (M-F2).** `GET /api/sessions/:id/security` adds `planCells`: the engagement's `plan` YAML parsed into structured steps (`planCellsToWire`, personas = bundled ids ∪ the engagement's `config_personas`, a malformed row → `[]`). `POST /api/sessions/:id/security/plan/cells` accepts `{ cells: SecurityPlanCellInput[] }` — no ordinal per step. The route shape-validates each cell (corrective 400 through `PlanCellInputError`), assigns dense ordinals 1..N in array order, serializes with `serializePlan`, and calls `setPlan(id, yaml, personas)` against the same persona union; `setPlan` gained an optional `knownPersonas` parameter so a repo-declared persona stays valid. A plan-level violation (unknown persona, later-step read) surfaces as the 409 the YAML route already returns; a running engagement returns the immutable-plan error. Auth rides the same `resolveToolSession` "mutate" ladder as the YAML route, so a human admin or the internal tool path may call it; the YAML `POST /security/plan` stays for `sec_plan_set`. The panel renders `PlanEditor` only while `status === 'planning'` AND `canAdminister`. The editor's draft seeds from `planCells` and resyncs on a real `planCells` change while `userTouched` is false, keyed by a stable per-step id. Persona and playbook pickers mirror the bundled registries as local consts (the web can not import `@valet/plugin-security`, same reason the preset list is mirrored). The hub's New review card notes that a repo `.valet/security.yml` overrides the preset.
33. **Focus + invariants inject into every dispatch, and edit through a structured route (M-F3).** `buildDispatchPrompt` gained a sixth parameter `{ focus?, invariants? }`; `dispatchCell` passes the engagement's `focus` column and the parsed `invariants` JSON. When either is present, the pure function adds one delimited "Engagement configuration" block just before the protocol: a Focus line ("… Weight your checklist toward this, but do not skip your cell's core coverage.") and an Invariants list ("Treat a VIOLATION of any as a high-signal finding …") with one bullet per invariant. An absent focus and empty (or whitespace-only) invariants add nothing — the prompt is byte-identical to the pre-M-F3 call, so every existing dispatch-prompt test still holds. The code-review persona role gained one paragraph telling the persona to verify each named invariant and cite a confirmed violation, and to not assume an invariant holds just because it is asserted (the plugin dist rebuilds; the markdown reads at runtime from `personas/`). `POST /api/sessions/:id/security/config` accepts `{ focus?, invariants? }`: an omitted field is left unchanged, `focus` of `null`/`""` clears the note, `invariants` of `[]` clears the list, and blank invariants are dropped. The service method `setEngagementConfig` refuses a running engagement with "The focus and invariants are immutable once the engagement is running.", matching `setPlan`. Auth rides the same `resolveToolSession` "mutate" ladder as the plan routes. No new columns — M-F1 already added `focus` + `invariants`. The panel renders `ConfigEditor` above the plan editor: an editable focus textarea + invariants line list (seeded with the `userTouched` resync rule, posting through `useSetEngagementConfig`) while planning for an admin, and a read-only focus + invariants view once running or closed so the user sees what the review was told. A finding that cites an invariant reads clearly from the model's own output; no special finding UI.
34. **Finding comments carry a human's triage reasoning into a re-scan (M-F4).** `security_finding_comments` (id, finding id, engagement id, body, author user id, created-at) holds one row per note, indexed on finding id and engagement id, with no unique constraint — a finding carries a thread. It is an in-place `0000_app.sql` table with a matching `SCHEMA_REPAIRS` table-and-two-index set (dev databases auto-repair on boot). `addFindingComment` (the service) validates a non-empty body capped at 4000 characters and inserts; `listFindingComments` returns notes oldest-first (thread order). `POST /api/sessions/:id/security/findings/:findingId/comments { body }` is VIEW-gated and human-only: it rides `resolveHumanSession(.., "view")`, so any viewer may comment (commenting is collaboration, not an admin action — unlike verify/refute) and a valid internal token is refused (the runner and personas do not comment through this route). The route confirms the finding belongs to the engagement (404 otherwise) and stamps `author_user_id` = the acting user. The findings-list route attaches `comments` per finding through one grouped `inArray` query, the same shape as the issue-link chips and the handoff list. The load-bearing carry is server-side: `buildPriorFindingsMd` appends each parent finding's comments under a "Notes:" line (as "team note: …", author not named), so on a re-scan the persona reads the prior human reasoning in `/prior/findings.md`, not just the status. The finding detail pane adds a "Notes" thread (author + relative time + escaped body — comments are human but keep the escape discipline) and an "Add a note" input any viewer can use (`useAddFindingComment` invalidates the findings query); the finding list row shows a note-count indicator, like the "N fix" badge.

35. **The threat-category library injects domain attack patterns into every dispatch (M-P2a).** `plugin-security` ships ten category YAMLs under `categories/` (`authz`, `authn`, `multi-tenancy`, `key-management`, `crypto-wallets`, `secrets-handling`, `policy-engines`, `webhooks`, `parsers`, `state-machines`), ported from Akshar's `.claude/threat-model-categories/*.yml`. Each has `name`, `detect_when`, an optional `dedup`, and `threat_patterns` (`description`, real `cwe`/`capec`, nullable `mitre_attack`, `skill`, `likelihood`, `prereqs`, `look_for`). `src/lib/categories.ts` exposes `KNOWN_CATEGORIES`, `isKnownCategory`, `categoryYaml`, `parseCategory`, and `categoryDigest`. `categoryYaml` reads each id through a `switch` of static single-call `readFileSync(new URL("<literal>", import.meta.url), "utf8")` reads — the ONLY shape the api bundle's inline-assets step embeds. A record-indexed read (the playbooks precedent) is NOT matched and would survive to the bundle as a broken read, so this milestone also added `.yml` to the inliner's `ASSET_EXTS` and a category case to the asset-parity test. `buildDispatchPrompt` gained a `categories` field on its config parameter; when set, it adds a "Threat categories loaded" block (set to `categoryDigest(categories)`, one bounded line per pattern with its CWE/CAPEC and first look-for cues) to the "Engagement configuration" section, and `dispatchCell` passes the parsed `categories` column. `categoryDigest` skips unknown ids and returns `""` when none load, so an absent list keeps the prompt byte-identical. `POST /security/config` accepts `categories?` and rejects an unknown id with a corrective error; `parseSecurityConfig` and `setEngagementConfig` apply the same validation. The panel's `ConfigEditor` adds a checkbox multi-select of the ten categories (a local id+label mirror; the server validates) that saves through `useSetEngagementConfig`, and a read-only loaded-categories view once running. No GET endpoint lists the library; the web mirrors. The `categories` column already existed from M-F1; no schema change.

## Revisions from the Adversarial Review (2026-08-27)

A review pass against UX, agent experience, and result quality forced eight corrections, folded into the sections above:

1. **Yield semantics** (Decision 7): context exhaustion was only reachable through the failure path; it is the primary loop event and is now first-class.
2. **Verification in v1** (Decision 9): the verify cell, `sec_finding_review`, and the evidence floor on `sec_finding_report` — the shipped-but-unused verifier maximized the odds of a noisy first impression.
3. **Tool-assisted scanning**: personas were implicitly specced as a slow grep; the role now directs them to run pre-baked read-only scanners and triage, and the stock image carries the scanners.
4. **Scenario B rewrite**: the original scenario required fail + re-dispatch after an api restart, contradicting `ChildWatcher.rearm()` — children survive restarts, and the test now asserts the non-event.
5. **Findings become actionable**: GitHub blob links at the pinned SHA, human verify/refute (`canAdministerSession`), `sec_handoff` to spawn a fix session, per-cell finding caps, distinct-fingerprint manifest counts.
6. **Context Discipline section**: compaction is a checkpoint boundary (engine `compactionHooks`, `protectedFromPruning` on protocol reads, staleness metric), and the plan's `reads` DAG scopes each dispatch prompt's context.
7. **Exit-condition claim re-scoped**: it defeats accidental truncation, not self-certification; the mitigations that narrow the rest are named (recon-seeded checklist, verify cell), and server-seeded checklists are a listed seam.
8. **The `interactive`-parent settlement seam** is named as an implementation checkpoint in Dependencies — the loop's self-advance depends on it.

A product review pass the same day promoted triage from a table to a surface:

9. **Findings review UI**: master-detail with evidence, provenance, fingerprint siblings, keyboard-first triage, and human verify/refute — a findings list the user cannot act on is a demo, not a product.
10. **Export in v1**: Markdown, SARIF 2.1.0 (suppressions carry refutations), JSON; filter-scoped; audit-logged. The former SARIF non-goal narrowed to the GitHub code-scanning *upload*.
11. **Issue filing in v1**: Linear and GitHub through existing integration actions (Decision 11), `security_finding_links` for idempotent linkage, digest issues for bulk — with the egress rule that only humans file or export (Decision 10).
