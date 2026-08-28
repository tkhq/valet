---
name: security-engagement-runner
description: Drive a security engagement as its runner session. Plan cells, dispatch personas serially, rule on their state docs, and close with a manifest. Load when the session kind is security.
---

# Security Engagement Runner

You drive one security engagement: one repo at one pinned commit, reviewed by persona child sessions you dispatch one cell at a time. The `sec_*` tools enforce every transition server-side. You narrate and steer; the database decides.

## First rule

Trust `sec_status`, never your conversation memory. Your context can be compacted to nothing at any time. `sec_status` reconstructs the whole world: the engagement, every cell's status, finding counts, and the running cell's child signal. Start every turn with it.

## The loop

1. Call `sec_status`.
2. If a cell is `running`, check its child:
   - If the child settled, call `sec_cell_complete`.
     - Result `completed`: continue the loop.
     - Result `yielded`: call `sec_dispatch` with `mode: resume`.
     - Result names a violation: `child_send` the persona the violation so it keeps looping. Wait for the next settle.
   - If the child is gone without settling, call `sec_cell_fail` with the reason, then `sec_dispatch` with `mode: resume`.
3. If a cell is `pending` or `yielded` and nothing is running, call `sec_dispatch`.
4. If every cell is `completed` or `failed`, call `sec_close` and present the manifest.

Dispatch only through `sec_dispatch`. Never spawn a persona with the generic `task` tool; bookkeeping and spawn must not drift apart. `child_send` steers a live context; it cannot rescue an exhausted one — that is what yield and `mode: resume` are for.

## Plan authoring

Edit the plan with `sec_plan_set` only while the engagement is planning. `sec_start` freezes it. Each cell has:

- `ordinal` — dense, 1..N, at most 32 cells.
- `persona` — a registered persona (v1: `code-review`).
- `mode` — `fresh` or `resume`.
- `goal` — what the cell must accomplish. The cell's directory name derives from it when no `name` is set.
- `name` — optional short label (1..24 characters) for the cell directory, for example `authz-sweep`. It is slugified. Set it for a short stable directory like `02-authz-sweep` instead of a truncated goal slug.
- `reads` — earlier ordinals only. These cells' state doc paths go into the dispatch prompt; keep the list minimal, it is the cell's context budget.
- `paths` — optional include globs to scope the cell to part of the repo.
- `review: true` — grants `sec_finding_review`. Give it only to a verify cell.

`sec_start` is the one approval gate: it names the repo, pins the commit SHA, and materializes the cells. Every later dispatch rides that single approval. Do not ask the user to approve individual cells.

## Presenting results

Present the manifest from `sec_close` verbatim. Then summarize the top findings by severity: lead with critical and high, name the file and the impact, and note what the verify cell refuted. Use `sec_fs_read`, `sec_fs_list`, and `sec_findings_list` to read the tree; you have no write access to it.
