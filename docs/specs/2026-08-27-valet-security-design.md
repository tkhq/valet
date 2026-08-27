# Valet Security — Design Spec

**Date:** 2026-08-27
**Status:** draft — for review
**Owner:** Applied AI
**Source:** concept note "Agentic engagement runner (for Valet)" (<https://gist.github.com/arawal/ceeab400cd51b54927f4ade5ef3377ce>), adapted to Valet v2 primitives the way Valet Design adapted Claude Design (`docs/specs/2026-08-23-valet-design-design.md`).

## Summary

Valet Security is an AI security-review surface inside Valet. A user points an engagement at a repository. A runner session dispatches persona agents (v1: `code-review`) as child sessions, one cell at a time. Personas coordinate through immutable state documents and report structured findings. The engagement survives crashes and restarts by construction: all coordination state lives in app tables, and resuming means reading the cell list and dispatching the first non-completed cell. The user watches cells and findings accumulate live in the session page, and gets a manifest when the engagement closes.

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
| `state.yml` per persona working dir | `/cells/<NN>-<goal slug>/state.yml`, append-only revisions (YAML verbatim) |
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
- **State doc** — a persona's YAML working state at `/cells/<NN>-<goal slug>/state.yml`, append-only revisions.
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
  "status" text DEFAULT 'pending' NOT NULL,
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
  "created_at" bigint NOT NULL
);
CREATE INDEX "security_findings_engagement" ON "security_findings" ("engagement_id");
```

Value sets:

- `security_engagements.status`: `planning` → `running` → `completed` | `failed`.
- `security_cells.status`: `pending` → `running` → `completed` | `failed`. A failed cell can be re-dispatched (a new `running` window on the same row; state docs persist across attempts).
- `security_cells.mode`: `fresh` (ignore own prior state docs) | `resume` (read own latest state doc and continue).
- `security_findings.severity`: `critical` | `high` | `medium` | `low` | `info`.
- `security_findings.status`: `open` → `verified` | `refuted`. Forward-only; no route mutates title, body, file, line, or severity after insert. This is the verifier-gate mechanism the note wants ("verifier flips bits, never rewrites") — v1 ships the enum and the transition rule, and no persona exercises it.

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

Cell directories are named `<ordinal, 2 digits>-<goal slug>` (the persona repeats across cells in a preset; the goal is what distinguishes them) and stamped on the cell row at `sec_start`, so paths are stable and dispatch prompts can name them literally.

A persona's state doc is YAML, stored verbatim. When a written path's basename is `state.yml`, the server validates two things: the content parses as YAML, and `protocol_version` is a known value. Other paths are free-form. Field-level schema enforcement stays out of v1 (the note's exclusion holds); the protocol markdown is the contract personas follow.

```yaml
protocol_version: 1
engagement: eng_abc123
cell: cell_01
persona: code-review
mode: fresh
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

**Exit condition (normative):** a cell is completable only when its latest state doc has `checklist.pending: 0` and `queue.pending: 0`. The note's orchestrator greps for this; here `sec_cell_complete` parses and checks it server-side, so a persona that stops looping early (silent truncation) cannot be marked done by a polite-but-wrong runner narration.

## Tools

Two tool sets, both built in `packages/api/src/engine/security-tools.ts`, both calling internal routes under `/api/sessions/:id/security/*` with the `x-valet-internal` token. Persona tools resolve the calling session's cell from `security_cells.child_session_id` matched against `ctx.sessionId` — one cell writes only its own state, the same shape as the sandbox gateway's `sid` claim check.

### Runner tools (attached to `kind='security'` sessions)

**sec_plan_set** — `{ plan: string }`. Replace the engagement plan (YAML: ordered cells with persona, mode, goal) while status is `planning`. Validates: personas exist in the registry, ordinals are dense, cell count ≤ 32. Refused once the engagement is running — the plan is immutable after start, like the note's `orchestration.yml`.

**sec_start** — `{}`. Requests an approval decision gate naming the repo, the resolved commit SHA, the cell count, and the personas. On approval: resolves and pins `repo_ref` to a SHA, materializes `security_cells` rows from the plan, flips status to `running`. This one gate covers every later dispatch — the cost surface is approved as a plan, not per child.

**sec_status** — `{}`. Returns the engagement, all cells with statuses, finding counts by severity, and for a `running` cell its child's settled/liveness signal. This is the resume primitive: a fresh runner turn calls `sec_status` and knows exactly where the engagement stands.

**sec_dispatch** — `{ cell_id?: string, mode?: 'fresh' | 'resume' }`. Dispatches the first `pending` cell (or re-dispatches a named `failed`/stuck `running` cell whose child is gone; `mode` overrides the cell's planned mode on re-dispatch, typically to `resume`). Refuses if another cell has a live child — v1 is serial, per the note's scope. In one transaction: spawns the child session (same repo binding, `ref` = pinned SHA, headless profile), stamps `child_session_id` and `dispatched_at`, sets status `running`. The dispatch prompt contains: the persona role, the shared protocol, the cell goal and mode, the cell's own directory path, and the literal tree paths of completed cells' state docs to read via `sec_fs_read`.

**sec_cell_complete** — `{ cell_id: string }`. Validates: the child settled, the cell's `/cells/<dir>/state.yml` exists, its latest revision parses, and the exit condition holds. On pass: status `completed`, `settled_at` stamped. On fail: returns the violation (for example `queue.pending is 2, not 0`) so the runner can `child_send` the persona to keep looping.

**sec_cell_fail** — `{ cell_id: string, reason: string }`. Marks a cell `failed` with a reason. Explicit and agent-invoked; nothing sweeps cells to `failed` on a timer (see Invariants).

**sec_close** — `{}`. Allowed when no cell is `pending` or `running`. Computes the manifest — per cell: persona, status, attempts, state doc revisions, finding count; per engagement: findings by severity — flips the engagement to `completed` (or `failed` when any cell failed), and returns the manifest as the tool result, durable in the thread.

### Persona tools (attached to cell-claimed child sessions)

**sec_fs_write** — `{ path: string, content: string }`. The path must sit under the calling session's own cell directory (`/cells/<own>/...`); anything else is refused — the path prefix IS the write claim, resolved from `security_cells.child_session_id`. A write to an existing path appends the next revision; nothing updates in place, so history rewrite is structurally impossible. Writes whose basename is `state.yml` get the YAML parse + `protocol_version` validation.

**sec_fs_read** — `{ path: string, revision?: number }`. Reads any path in the engagement tree, latest revision by default. This is the note's "read peers' findings by absolute path", with the engagement as the visibility boundary. Also serves the read-only mounts `/protocol.md` and `/plan.yml`.

**sec_fs_list** — `{ prefix?: string }`. Lists paths under a prefix with each path's latest revision number and size. Personas discover peers' work the way the note intends: by looking at the filesystem.

**sec_finding_report** — `{ severity, title, file?, line?, body }`. Inserts a finding for the calling cell. The server computes the fingerprint — sha256 over persona, file, line bucket (÷10), and normalized title, first 16 hex — and returns the finding id plus any existing findings sharing the fingerprint (advisory dedup; the persona decides whether it found something new).

**sec_findings_list** — `{ cell_id?, severity? }`. Lists findings across the engagement.

Runner sessions also get `sec_fs_read` / `sec_fs_list` / `sec_findings_list` (read-only on the tree) so the runner can summarize without a child. The generic `task` / `child_read` / `child_send` / `child_status` tools stay available to the runner for steering; dispatch itself goes through `sec_dispatch` only, so bookkeeping and spawn cannot drift apart.

## The Loop, Crash, and Resume

The engagement-runner skill instructs this loop:

1. Call `sec_status`.
2. If a cell is `running`: check its child. If the child settled, call `sec_cell_complete`. If the exit condition fails, `child_send` the persona to continue and wait for the next settle. If the child is gone without settling, call `sec_cell_fail`, then re-dispatch with `mode: resume`.
3. If a cell is `pending` and nothing is running: `sec_dispatch`.
4. If no cell is `pending` or `running`: `sec_close` and present the manifest.

Crash recovery needs no machinery beyond this. The api restarts, the runner session's next turn (user says "continue", or the settled-child signal wakes the thread) starts at step 1, and the database answers. Completed cells never re-run. A persona that crashed after its last `sec_fs_write` lost nothing; its replacement reads its own revisions in `resume` mode. This is the note's acceptance step 12, held by the substrate rather than by careful file ordering.

**Invariants: alert, don't auto-repair.** Cell status has one owner: the security routes. No TTL kills a long-running cell and no sweep re-syncs statuses. The api emits a `security_cells` created/settled counter pair and an over-age `running` gauge (cell running with no child activity for 30+ minutes); the session page shows the same condition on the cell rail. A stuck cell is a page to a human (or the runner agent), not a silent repair. Re-dispatch is always an explicit `sec_dispatch` call.

## plugin-security

`packages/plugin-security` follows the standard v2 plugin shape (`plugin.yaml` with `v2: true`, `./plugin` export, registry regeneration). It ships no actions. Contents:

- **Skill: `security-engagement-runner`** — the runner loop above, plan-authoring guidance, and how to present findings and the manifest.
- **Role: `code-review` persona** — the v1 persona. Instructs: build a file checklist from the clone, loop it, write a state doc revision at every checkpoint (after each checklist section, before any long analysis), report findings the moment they are confirmed, keep looping until both pending counts are zero, and only then settle. Forbids: editing files, network calls beyond the clone, claiming completion with a non-empty queue.
- **Protocol: `protocol/state-doc.md`** — the state doc contract (fields, exit condition, immutability rules). Mounted read-only at `/protocol.md` in the engagement tree and injected verbatim into every dispatch prompt. Shipping it in the package instead of at a URL removes the note's schema-drift-by-unreachable-URL failure mode; the protocol version personas see is the version the server validates.
- **Plan presets** — v1 ships one: `code-review` (four cells: recon, authz sweep, injection sweep, secrets-and-config sweep — all the `code-review` persona with different goals). The hub offers presets; chat can edit the plan before `sec_start`.

The pure library (plan YAML parse/validate, state doc parse, exit-condition check, fingerprint computation) lives in the plugin as importable code with unit tests, and the API imports it — the `plugin-design` lib precedent.

## Web Surfaces

### `/security` — hub

Mirrors the `/design` hub pattern: a repo picker (the existing new-session repo binding UX), a preset picker (v1: Code review), an optional prompt ("focus on the token minting paths"), and a list of past engagements with status and finding counts. Creating one calls `POST /api/sessions` with `kind='security'` and the repo binding; the engagement row is seeded in the same transaction with the preset plan, status `planning`.

### `/sessions/:id/security` — engagement panel

The session page for `kind='security'` sessions adds a security panel beside the thread (the design-canvas layout precedent, including the mobile Chat | Panel tab toggle so approval gates never hide):

- **Cell rail** — ordered cells with persona, status, attempt count, elapsed time, and a link to each cell's child session page. An over-age running cell shows a warning state with the last child activity time.
- **Findings table** — severity, title, `file:line`, source cell. Sortable by severity, filterable by cell. Finding bodies render as escaped text/markdown — findings are data from an agent that read hostile code, never HTML.
- **Manifest** — after `sec_close`, the manifest renders at the top of the panel.

Data over REST (`GET /api/sessions/:id/security` for engagement + cells, `/security/findings` for findings); live updates over `security.cell.updated` / `security.finding.added` wire events on the session WebSocket via the engine `host_event` seam, with query polling as the fallback until that seam lands.

Tool renderers: `sec_dispatch` (cell card with child link), `sec_finding_report` (severity-badged finding card), `sec_cell_complete` / `sec_close` (status summaries). New renderer files listed before the fallback in the registry.

## Security Model

The note's threat list, plus what running inside Valet adds:

1. **Schema drift** (note #1). `sec_fs_write` validates YAML parse and `protocol_version` server-side on every `state.yml` write; the protocol ships in the plugin, so personas and server cannot see different versions.
2. **History rewrite** (note #2). Every tree path is append-only revisions; findings are insert-only with forward-only status. No update route exists to abuse.
3. **Silent truncation** (note #3). The exit condition is checked by `sec_cell_complete` on the server, not grepped by the runner.
4. **Lost work across restarts** (note #4). State doc writes are single-row transactions; dispatch and completion are transactional with their side effects. Recovery is a read.
5. **Cross-contamination** (note #5). Report generation is out of scope for v1; findings are immutable once written, so a future report writer consumes fixed inputs.
6. **Child recursion blowup** (note #6). The engine gives child sessions no spawner. Structural, not contractual.
7. **Stranded partial work** (note #7). Over-age running cells surface in metrics and the cell rail; re-dispatch is explicit. Alert, don't auto-repair.
8. **Prompt injection from the scanned repo.** Personas read hostile code by design. Blast radius: a compromised persona can write only under its own cell directory (path-prefix claim) and report findings for its own cell, cannot spawn children, cannot reach other sessions' sandboxes (gateway `sid` check), and holds only repo-read credentials. Findings render escaped in the client.
9. **Cost blowout.** The `sec_start` gate names the cell count and personas before anything spawns; dispatch is serial; the plan is capped at 32 cells. Per-engagement token budgets are a re-entry seam (the Valet Design threat-7 precedent).
10. **Cross-tenant reads.** Every `/security/*` route resolves session → engagement → owner and applies the session's existing access checks; persona tools additionally require the cell claim. Mutating routes get named `can*` checks, per the explicit-authz rule.
11. **Findings disclosure.** v1 has no export or share surface. Findings are visible only to principals who can view the session.

## Dependencies

- **`agent_sessions.kind`** ships in the Valet Design PR (#396). Valet Security extends the value set with `'security'`. If this lands first, it carries the same `ALTER TABLE` + repair statement and #396 rebases; the column shape is identical either way.
- **`host_event` engine seam** (also #396) carries `security.*` wire events. Until it lands, the panel polls; no spec change either way.

## Non-Goals (with Re-Entry Seams)

| What | Why out | Re-entry |
|---|---|---|
| Report writer / report designer | Note excludes; v1 output is the manifest + findings table | New persona + a `security_reports` table consuming immutable findings |
| Active verifier persona | Mechanism ships (status enum, forward-only); no persona uses it | A `verifier` persona flipping `open → verified/refuted` |
| Concurrent cell dispatch | Note excludes; serial keeps the loop and cost legible | Lift the one-live-child check in `sec_dispatch`; cells already key state by cell id |
| Concurrent engagements per session | One engagement per session keeps session == engagement | Drop the unique index on `session_id`, add engagement id to tool args |
| Field-level state doc schema validation | Note excludes; parse + version check only | TypeBox schema on `sec_fs_write` for `state.yml` behind `protocol_version` 2 |
| Scheduled / CI-triggered engagements | v1 is chat-initiated | Workflow trigger node creating `kind='security'` sessions |
| SARIF / GitHub code-scanning export | Disclosure surface needs its own review | Export route reading immutable findings |
| Org-authored custom personas | v1 personas ship in the plugin | Persona registry keyed by org, same dispatch path |
| Multi-repo engagements | One repo, one pinned SHA keeps determinism | `repos` array on the engagement; cells name a target dir |
| Cross-engagement finding memory | Dedup is per-engagement fingerprint only | Fingerprint lookup across an org's engagements |

## Acceptance Scenarios

Integration tests at the API level, `packages/api/src/integration/security-acceptance.test.ts`, virtual sandbox provider.

### Scenario A: code-review engagement end to end

1. Hub creates a session with `kind='security'` and a repo binding; engagement seeded with the code-review preset, status `planning`.
2. Runner refines the plan via `sec_plan_set` (chat: "skip the secrets sweep"); plan validates.
3. `sec_start` opens an approval gate naming repo, SHA, 3 cells, persona. User approves; cells materialize; status `running`.
4. `sec_dispatch` spawns cell 1's child with the repo pinned to the SHA; cell 1 is `running` with a `child_session_id`.
5. The persona writes state doc revisions and reports two findings; rows appear via REST while the child runs.
6. Child settles with pending counts zero; `sec_cell_complete` passes; cell 1 `completed`.
7. Cells 2 and 3 repeat; cell 2's persona calls `sec_fs_read { path: "/cells/01-recon/state.yml" }` and sees cell 1's state doc verbatim.
8. `sec_close` returns a manifest: 3 completed cells, findings by severity. Engagement `completed`.
9. The findings table and cell rail reflect every transition (REST assertions).

### Scenario B: crash and resume

1. Run Scenario A through step 4, then simulate an api restart mid-cell-2 (engine reload).
2. User posts "continue". Runner calls `sec_status`: cell 1 `completed`, cell 2 `running` with a gone child.
3. Runner calls `sec_cell_fail` then `sec_dispatch { cell_id }` with `mode: resume`; the new child reads cell 2's existing state doc revisions and continues from its own queue.
4. Cell 1 never re-ran; cell 1's findings and state docs are unchanged (assert row ids stable).

### Scenario C: exit condition enforced

1. A persona settles while its latest state doc shows `queue.pending: 2`.
2. `sec_cell_complete` refuses, naming the violation.
3. Runner `child_send`s the persona to continue; the persona drains the queue, writes a final state doc, settles.
4. `sec_cell_complete` passes. Assert the cell never showed `completed` before the pass.

## Resolved Decisions

**Decision 1: substrate is app tables; the interface stays a filesystem. RESOLVED.** Child sessions do not share a filesystem, and the gateway's `sid` check makes cross-sandbox reads impossible by design. Rows give the same recovery-by-read property plus transactionality, immutability enforcement, and a free UI read path. The tools stay path-addressed (`sec_fs_write`/`sec_fs_read`/`sec_fs_list`, the `mem_write` path-param shape) so personas keep the note's filesystem mental model, dispatch prompts name literal paths, and new artifact types need no new tools. The persona's YAML state doc survives verbatim at a conventional path.

**Decision 2: the runner is an agent session with server-enforced transitions, not a workflow DAG. RESOLVED.** Plans are authored and edited in chat, cells re-dispatch adaptively, and locked decision 5 makes agent sessions the orchestration primitive. The routes enforce every transition, so agent unreliability cannot corrupt the state machine — it can only stall it, which `sec_status` makes visible. Compiling a plan to a workflow definition is a re-entry seam, not v1.

**Decision 3: dispatch is a dedicated tool, not the generic `task` tool. RESOLVED.** `sec_dispatch` wraps the same `ChildSpawner` but binds spawn + cell bookkeeping in one transaction and pins the repo ref. A generic `task` call could spawn a child the engagement does not track.

**Decision 4: findings are structured rows, not parsed out of state docs. RESOLVED.** The UI, dedup, and the future verifier need typed findings; scraping YAML for them is the shape-drift bug this repo keeps paying for. The state doc references finding ids instead of embedding bodies.

**Decision 5: one persona in v1 — `code-review`. RESOLVED.** The note's scope: prove the coordination model with one concrete persona. Presets express multi-cell plans with that one persona.

**Decision 6: the protocol ships in the plugin, not at a URL. RESOLVED.** Injected into every dispatch prompt and validated by the same server build — no fetch dependency, no drift window.

## Deviations from the Concept Note

1. **The disk is a database; the interface is still a filesystem.** Forced by session-isolated sandboxes; see The Move. Personas keep path-addressed reads and writes (`sec_fs_*`), the note's thesis properties are preserved, and two of its exclusions (transactional work-list writes, atomic state-before-status ordering) dissolve.
2. **Exit condition moves server-side.** The note's orchestrator greps the persona's file; a Valet runner is an LLM, so the check that defeats silent truncation cannot live in its judgment. `sec_cell_complete` owns it.
3. **Findings are first-class rows** referenced by the state doc, not embedded in it (Decision 4).
4. **Recursion prevention is structural.** The engine's children get no spawner; the note enforces this in persona markdown.
5. **State doc writes are validated at write time** (YAML parse + protocol version). The note defers all validation to trust; a parse check at the write boundary is nearly free and converts threat #1 from "state becomes unreadable" to a tool error the persona fixes immediately. Field-level schema validation remains excluded, as in the note.
6. **The plan gains a human gate.** `sec_start` puts an approval in front of the spawn plan — Valet's cost and audit posture, absent from the note's CLI framing.
