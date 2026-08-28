# State Doc Protocol (version 1)

This is the contract between a persona and the engagement. It is mounted read-only at `/protocol.md` in the engagement tree and injected into every dispatch prompt.

## Two filesystems

Engagement state exists only behind the `sec_fs_*` tools. `/workspace` is the scan target, never state storage. Do not write notes, checklists, or state docs into the clone; they die with the sandbox.

## The state doc

Your durable working state is a YAML document at `/cells/<your cell dir>/state.yml`, written with `sec_fs_write`. Schema:

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

- `protocol_version` is 1. The server rejects other values.
- `status` is `working` while you loop, `yielding` for a deliberate stop, `done` only at the exit condition.
- `checklist` counts review items; `queue` counts discovered follow-ups.
- `findings` lists the ids `sec_finding_report` returned.
- `log` is a short list of what happened, newest last.

## Checkpoint cadence

Write a state doc revision after every 10 checklist items, and before any long analysis. At any interruption — crash, compaction, yield — the durable state is then at most one stride stale.

## Exit and yield

- **Exit:** settle with `status: done` only when `checklist.pending` and `queue.pending` are both 0. The server checks these counts.
- **Yield:** when context runs short or a phase ends with work remaining, write `status: yielding` and stop. A fresh dispatch resumes you from your own state doc.

## Immutability

Every `sec_fs_write` appends a new revision. Nothing rewrites history. Write the full document each time; do not try to patch.

## Rehydration

After any compaction, re-read `/protocol.md` and your own `state.yml` via `sec_fs_read` before continuing. Trust the tree over the summary.
