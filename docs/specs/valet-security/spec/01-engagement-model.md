# Part 01: Engagement Model

*Depends on: Part 00. Conformance: L0+.*

## Purpose

This part fixes the cell state machine (`pending → running → completed | yielded | failed`), adds the new `mode: post-pivot-delta`, and normatively defines the state-doc schema written to `/cells/<NN>-<slug>/state.yml` in the engagement tree.

## Engagement lifecycle

An engagement (`security_engagements` row) moves through: `planning → running → completed | failed | cancelled`.

**planning.** The row exists. `plan` (YAML) may be edited via `sec_plan_set` or the structured `POST /security/plan/cells` route. Cells are NOT materialized yet.

**running.** `sec_start` (approval-gated) resolves `repo_ref` to a SHA, materializes `security_cells` rows from the plan (assigning `dir` and `reads`), and flips the engagement to `running`. The runner dispatches cells serially in ordinal order.

**completed.** Every cell is `completed`, `yielded`, or `failed`, and `sec_close` has computed the manifest. The base design's rule holds: `yielded` and `failed` are terminal at engagement-close time; only `pending` and `running` block close.

**cancelled.** A human cancelled the engagement before it settled. Terminal.

The runner MUST NOT dispatch two cells from the same engagement concurrently. `sec_dispatch` refuses if any cell in the engagement is `running` with a live child.

## Cell state machine

A cell (`security_cells` row) has:

- `ordinal` (integer, dense 1..N per engagement, ≤32).
- `persona` (string; a bundled id or a repo-declared key).
- `mode` (`fresh` | `resume` | `post-pivot-delta`).
- `goal` (string).
- `dir` (string, slugified: `<NN>-<slug>`).
- `reads` (JSON array of earlier ordinals whose state docs this cell may name in its dispatch).
- `review` (boolean; grants `sec_finding_review`).
- `status` (`pending` | `running` | `yielded` | `completed` | `failed`).
- `attempts` (integer).
- `child_session_id` (nullable).
- `dispatched_at`, `settled_at`, `compacted_at`, `created_at` (millis).

New in v1: `mode: post-pivot-delta`. `parsePlan` accepts it. `serializePlan` round-trips it. The web UI shows it as a read-only badge on the cell rail.

### Status transitions

1. `pending → running`. `sec_dispatch` spawns the child, stamps `child_session_id`, `dispatched_at`, increments `attempts`.
2. `running → yielded`. The persona writes a state doc revision with `status: yielding` (see §Yield below).
3. `running → completed`. `sec_cell_complete` reads the latest state doc, verifies the settlement condition holds, verifies every applicable anti-cap check (Part 07) passes, stamps `settled_at`.
4. `running → failed`. `sec_cell_fail` marks the cell `failed` with a `reason`. Explicit and agent-invoked.
5. `yielded → running`. `sec_dispatch mode=resume` reawakens the cell (same row; a new child session).
6. `failed → running`. Same shape as `yielded → running`.

The runner MUST NOT advance to the next `pending` cell until the current cell is `completed`, `yielded`, or `failed`. A `yielded` cell is terminal at cell-loop time but not at engagement-close time.

### Mode semantics

**fresh.** No prior state doc for this cell. The persona builds its checklist from `reads` cells (or, for the recon cell, from the clone's file inventory).

**resume.** The cell has one or more prior state doc revisions. The persona reads the latest revision and continues from `queue.pending`.

**post-pivot-delta.** The cell has ONE prior original run at an earlier ordinal, named in this cell's `reads[]`. The pivot-coordinator materializes this cell after resolve mode. The persona reads:
- the ORIGINAL cell's latest state doc (from `reads[<original ordinal>]`);
- the `delta_targets` block in its dispatch prompt (Part 05 §5.4);
- `/loot/catalog.yml` for any needed session, credential, test data, or tool auth.

It tests ONLY the delta surface. It writes a new state doc whose `findings[]` is a superset of the original state doc's `findings[]`. Every new finding id is a `security_findings` row whose `traces_to.pivot_need` is a resolved need id. See Part 07 §7.1-7.2 for the two anti-cap checks that guard this contract.

**Example plan with a delta re-run:**
```yaml
cells:
  - ordinal: 1
    persona: threat-model
    mode: fresh
    reads: []
  - ordinal: 2
    persona: dast
    mode: fresh
    reads: [1]
  - ordinal: 3
    persona: fuzz
    mode: fresh
    reads: [1]
  - ordinal: 4
    persona: pivot-coordinator
    mode: fresh
    reads: [2, 3]
  - ordinal: 5
    persona: dast
    mode: post-pivot-delta
    reads: [2]
  - ordinal: 6
    persona: fuzz
    mode: post-pivot-delta
    reads: [3]
```

## The state doc

Every persona writes a YAML state doc to `/cells/<NN>-<slug>/state.yml` through `sec_fs_write`. The base design's `security_files` append-only revision behavior applies. The schema is normative.

```yaml
protocol_version: 1
engagement: <engagement id, matches parent row>
cell: <cell ordinal>
persona: <persona id>
mode: fresh | resume | post-pivot-delta
status: working | yielding | done
checklist:
  pending: <int, 0 at settlement>
  done: <int>
queue:
  pending: <int, 0 at settlement>
  done: <int>
findings: [<finding id, string>, ...]
log: [<string>, ...]
```

**Field notes.**
- `protocol_version` MUST be 1. `sec_fs_write` refuses any other value on any state doc path.
- `findings[]` carries IDS, not full finding objects. The rows are in `security_findings`.
- `log[]` is informative. Personas MAY write structured log entries. The server does NOT parse them. Test vectors (Appendix D) do NOT pin them.
- For `mode: post-pivot-delta`, `findings[]` MUST be a superset of the original cell's `findings[]`.

## Settlement condition

A cell is COMPLETABLE only when the latest state doc has:
1. `status: done`;
2. `checklist.pending: 0`;
3. `queue.pending: 0`.

`sec_cell_complete` server-side parses the state doc and validates the three conditions plus every applicable anti-cap check (Part 07). If all pass, the cell moves to `completed`. If any fails, the cell stays `running` and the tool result names the violation (`status is done but queue.pending is 2`, `finding-count decreased from 3 to 2`, `finding F-dast-4 missing traces_to.pivot_need`, etc.). The runner may `child_send` the persona to keep looping or, on a hard violation (`traces_to.pivot_need` missing), instruct the persona to backfill and re-emit.

The base design's honest limit holds: the pending counts are the persona's own arithmetic. The recon cell narrows that gap by seeding the checklist from the file inventory; the verifier cell attacks the findings themselves. Server-seeded checklists remain a v2 re-entry seam.

## Yield deliberately

A persona MAY write a state doc with `status: yielding` before running out of context. `sec_cell_complete` treats `yielding` as a checkpoint-and-stop:
- Cell moves to `yielded`.
- Runner re-dispatches with `mode: resume` (a NEW child session, same row).
- The replacement child reads the state doc and continues from `queue.pending`.

A yield is normal operation, not failure. The `attempts` counter counts dispatches so alerting can distinguish a routinely long cell from a stuck one. See the base design §Context Discipline.

## Delta re-run contract

A `post-pivot-delta` cell MUST:

1. Read the original state doc from `sec_fs_read /cells/<original NN>-<slug>/state.yml`. Populate a "seen" set from `findings[]`.
2. Read `delta_targets` from the dispatch prompt. Test only the surface it names (`authed_surface`, `new_hosts`, `auth_scopes`, `test_data`, `tool_auth`).
3. Read `/loot/catalog.yml` for any needed session, credential, test data, tool auth.
4. Report every new finding via `sec_finding_report`. The tool automatically stamps `traces_to.pivot_need` from the dispatch context. The persona MAY override the need id by passing `traces_to: {pivot_need: <need id>}` in the finding body if a specific need in the pivot round unblocked this finding; if omitted, the server sets it to the FIRST resolved need in the delta.
5. Write a new state doc whose `findings[]` is the seen set plus every new finding id. `sec_cell_complete` server-side confirms the superset and the pivot_need citation on every new id.

If step 5 violates monotonicity or citation, `sec_cell_complete` refuses the settlement and returns the specific violation. The persona re-emits the missing rows and calls `sec_cell_complete` again.

## Anti-cap check application

`sec_cell_complete` applies the three anti-cap checks (Part 07 §7.1-7.3) when the cell has `mode: post-pivot-delta`. For any other mode, only the tool-version audit is emitted (as informational findings from the verifier persona, not as a settlement gate).

**L0 through L3 implementations MAY skip anti-cap enforcement in `sec_cell_complete`** (the settlement condition remains: `status: done`, both pending counts 0). At L4 the checks are gate conditions.

## Conformance

**L0.** Implementations MUST define the settlement condition as a pure predicate: given a state doc JSON, return true iff `status == "done"` AND `checklist.pending == 0` AND `queue.pending == 0`. No I/O.

**L1+.** Implementations MUST write state docs via `sec_fs_write` on the `security_files` append-only path. The server MUST validate `protocol_version == 1` on every state.yml write.

**L2+.** The `pivot-coordinator` persona reads state docs from `reads[]` cells (Part 05).

**L3+.** The `post-pivot-delta` dispatch contract holds (§5.8 in Part 05).

**L4.** `sec_cell_complete` MUST enforce the three anti-cap checks (Part 07 §7.1-7.3) and refuse the settlement on any violation.
