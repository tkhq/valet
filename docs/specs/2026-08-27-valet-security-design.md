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

## Context Discipline

Long engagements exceed model contexts — for the personas, for the runner, or both. The design's stance: **context is a cache; the tree is the state.** Three mechanisms hold that line.

### Yield: the persona's deliberate stop

A checklist over a real repo does not fit one child context, so running out is normal operation, not failure. When a persona nears its limit (or finishes a natural phase), it writes a state doc with `status: yielding` and settles. The runner re-dispatches with `mode: resume`; the replacement child starts with a fresh context, reads its own state doc, and continues from `queue.pending`. This is the note's "agents resumeably loop until their local state says they're done", made first-class — v1 without yield would reach fresh-context resumption only through the failure path, mislabeling routine operation as failure and polluting the `attempts`/alert signals.

`child_send` ("keep looping") is for exit-condition violations only — it steers the same context, so it cannot rescue an exhausted one.

### Compaction hooks: checkpoint boundaries, not data loss

The engine already ships the seams (`CompactionConfig`, `compactionHooks`, `ToolDef.protectedFromPruning` — `packages/engine/src/types.ts`). Valet Security uses them as follows:

- **Persona threads compact safely by construction.** The checkpoint cadence keeps the durable state at most one stride stale, and the protocol's rehydration rule says: after any compaction, re-read `/protocol.md` and your own `state.yml` via `sec_fs_read` before continuing — trust the tree over the summary.
- **The contract survives pruning.** `sec_fs_read` results for `/protocol.md` are marked `protectedFromPruning`, so compaction cannot strip the rules the persona operates under.
- **Compaction is observable, not silent.** The host registers a `compactionHook` for cell-claimed threads: it stamps the event on the cell (surfaced as a badge on the cell rail) and emits a metric when a thread compacts while the cell's latest state doc is older than the checkpoint stride — a persona compacting on stale state is exactly the moment work silently evaporates, and it should page attention, not disappear (alert, don't auto-repair).
- **The runner needs no memory.** `sec_status` reconstructs the loop's entire world; runner compaction is harmless by design, and the skill says so explicitly.

### Selective context: the plan is a DAG, dispatch follows its edges

Every cell naming every predecessor would re-inflate the contexts yield just freed. Plan cells declare `reads: [ordinals]` — the DAG edges — and `sec_dispatch` injects only those cells' state doc paths into the dispatch prompt. The authz cell reads recon's map; it does not carry the injection cell's history. The full tree stays discoverable through `sec_fs_list` for the persona that genuinely needs more, but the default context cost of a cell is its declared dependencies, not the engagement's whole past.

The same edges are the concurrency seam: cells with disjoint `reads` have no ordering dependency, so lifting the serial-dispatch restriction later is a scheduling change, not a data model change.

## plugin-security

`packages/plugin-security` follows the standard v2 plugin shape (`plugin.yaml` with `v2: true`, `./plugin` export, registry regeneration). It ships no actions. Contents:

- **Skill: `security-engagement-runner`** — the runner loop above, plan-authoring guidance, and how to present findings and the manifest.
- **Role: `code-review` persona** — the v1 persona. Instructs: build a checklist (from the clone in recon; seeded by your `reads` cells otherwise), loop it, follow the checkpoint cadence, yield deliberately when context runs short, report findings with evidence the moment they are confirmed, and settle with `status: done` only when both pending counts are zero. **Tools are first-class:** the sandbox has bash and the clone; run the pre-baked read-only scanners and triage their output instead of re-deriving what deterministic tools do better — the persona's value is the reasoning tools cannot do. Carries the severity rubric (what separates `critical` from `high` from noise) and the evidence standard (excerpt plus source-to-impact reasoning). Forbids: editing files, network access beyond the clone, installing tools, claiming `done` with a non-empty queue.
- **Protocol: `protocol/state-doc.md`** — the state doc contract (fields, checkpoint cadence, yield and exit conditions, immutability rules), the rehydration rule (after a compaction, re-read `/protocol.md` and your own `state.yml` before continuing), and the two-filesystems rule: **engagement state exists only behind `sec_fs_*`; `/workspace` is the scan target, never state storage** — personas conflate a real filesystem and an imagined one unless told not to. Mounted read-only at `/protocol.md` in the engagement tree and injected verbatim into every dispatch prompt. Shipping it in the package instead of at a URL removes the note's schema-drift-by-unreachable-URL failure mode; the protocol version personas see is the version the server validates.
- **Plan presets** — v1 ships one: `code-review`, five cells, all the `code-review` persona with different goals and `reads` edges: `01-recon` (map the codebase, seed the checklist from the file inventory, note trust boundaries), `02-authz-sweep` (reads: 01), `03-injection-sweep` (reads: 01), `04-secrets-config` (reads: 01; primarily deterministic-scanner triage), `05-verify` (reads: 01–04; `review: true`; attack every open finding, `sec_finding_review` each, refute what does not survive). The hub offers presets; chat can edit the plan before `sec_start`.

**Sandbox image:** no variant image (single-image lineage is locked). The stock image adds pinned, offline-capable read-only scanners — a secrets scanner and a pattern scanner (gitleaks and semgrep or equivalents) — the way it carries marp for design exports. Personas run them against the clone; rule updates ride image rebuilds, not runtime downloads, so sandbox egress stays closed.

The pure library (plan YAML parse/validate, state doc parse, exit-condition check, fingerprint computation) lives in the plugin as importable code with unit tests, and the API imports it — the `plugin-design` lib precedent.

## Web Surfaces

### `/security` — hub

Mirrors the `/design` hub pattern: a repo picker (the existing new-session repo binding UX), a preset picker (v1: Code review), an optional prompt ("focus on the token minting paths"), and a list of past engagements with status and finding counts. Creating one calls `POST /api/sessions` with `kind='security'` and the repo binding; the engagement row is seeded in the same transaction with the preset plan, status `planning`.

### `/sessions/:id/security` — engagement panel

The session page for `kind='security'` sessions adds a security panel beside the thread (the design-canvas layout precedent, including the mobile Chat | Panel tab toggle so approval gates never hide):

- **Cell rail** — ordered cells with persona, status, attempt count, elapsed time, and a link to each cell's child session page. The running cell shows live progress parsed from its latest state doc (`checklist 14/47 · queue 3 pending`) — the tree makes progress free to render, and a scan that shows motion beats a static "running" badge for the half hour before the first finding. A compaction badge appears when the cell's thread compacted (from the compaction hook). An over-age running cell shows a warning state with the last child activity time.
- **Findings review** — the triage surface, specified below.
- **Manifest** — after `sec_close`, the manifest renders at the top of the panel: distinct-fingerprint counts by severity with the verified/refuted/open breakdown, and triage tallies (issues filed, findings dismissed by a human).

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
- **Settlement signals to a non-orchestrator parent.** The runner is hub-created (engine purpose `interactive`), and the loop's self-advance depends on `child.settled` signals being admitted to it (`admitSignal`'s edge ACL, `packages/api/src/orchestrator/signals.ts`). The child edge exists in `child_watches` because `sec_dispatch` creates it, but the ACL's treatment of interactive-purpose parents is an implementation checkpoint: verify it, or the loop silently degrades to user-poked. Same check for the runner's `child_send`/`child_status` wiring outside orchestrator purpose.

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

Integration tests at the API level, `packages/api/src/integration/security-acceptance.test.ts`, virtual sandbox provider.

### Scenario A: code-review engagement end to end

1. Hub creates a session with `kind='security'` and a repo binding; engagement seeded with the code-review preset, status `planning`.
2. Runner refines the plan via `sec_plan_set` (chat: "skip the secrets sweep"); plan validates; `reads` edges re-validate.
3. `sec_start` opens an approval gate naming repo, SHA, 4 cells, persona, cost estimate. User approves; cells materialize with `dir` and `reads` stamped; status `running`.
4. `sec_dispatch` spawns cell 1's child with the repo pinned to the SHA; cell 1 is `running` with a `child_session_id`.
5. The recon persona writes state doc revisions; the cell rail's progress counts update from them.
6. Child settles with `status: done` and pending counts zero; `sec_cell_complete` passes; cell 1 `completed`.
7. Cell 2 (authz, reads: 01) dispatches; its prompt names only `/cells/01-recon/state.yml`; the persona reads it verbatim via `sec_fs_read` and reports two findings with evidence bodies.
8. Cell 3 (injection) repeats. The verify cell dispatches, reads all prior state docs, and `sec_finding_review`s one finding to `refuted` with a reason.
9. `sec_close` returns a manifest: 4 completed cells, distinct-fingerprint counts by severity, 1 refuted. Engagement `completed`.
10. The findings table and cell rail reflect every transition (REST assertions); a finding row carries the GitHub blob link at the pinned SHA.

### Scenario B: api restart is a non-event

1. Run Scenario A through step 4, then simulate an api restart mid-cell-2 (engine reload).
2. On boot, `ChildWatcher` re-arms the unsettled watch; cell 2's child resumes and settles with no user action.
3. The settle signal wakes the runner; the loop continues through `sec_cell_complete` and the next dispatch.
4. Assert: no re-dispatch happened (cell 2 `attempts` is 1), cell 1 never re-ran, and cell 1's finding and state doc row ids are unchanged.

### Scenario C: exit condition enforced

1. A persona settles while its latest state doc shows `status: done` but `queue.pending: 2`.
2. `sec_cell_complete` refuses, naming the violation.
3. Runner `child_send`s the persona to continue; the persona drains the queue, writes a final state doc, settles.
4. `sec_cell_complete` passes. Assert the cell never showed `completed` before the pass.

### Scenario D: yield and child death

1. A persona checkpoints and settles with `status: yielding`, `queue.pending: 31`.
2. `sec_cell_complete` marks the cell `yielded`; the runner calls `sec_dispatch { cell_id, mode: 'resume' }`; `attempts` becomes 2.
3. The fresh child reads its own latest state doc, continues from the queue, and completes; assert findings reported before the yield survive with stable ids.
4. Separately: a running cell's child is destroyed (sandbox reclaimed, no settle). `sec_status` shows the child gone; the runner calls `sec_cell_fail` then re-dispatches with `mode: resume`; the cell completes on attempt 2.

### Scenario E: triage, export, file issues

Web-level tests beside the panel components; API-level tests for the routes.

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

**Decision 5: one persona in v1 — `code-review`. RESOLVED.** The note's scope: prove the coordination model with one concrete persona. Presets express multi-cell plans with that one persona.

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
