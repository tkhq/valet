# State Doc Protocol (version 1)

This is the contract between a persona and the engagement. It is mounted read-only at `/protocol.md` in the engagement tree and injected into every dispatch prompt.

## Two filesystems

The engagement tree (`/cells/...`, `/protocol.md`, `/playbooks/...`) exists ONLY behind the `sec_fs_*` tools. It is NOT a real filesystem: the generic Read, Write, and Edit tools operate on the sandbox filesystem and will fail on a `/cells/...` path ("no such file or directory"). Read the tree with `sec_fs_read`/`sec_fs_list`; write it with `sec_fs_write`.

The sandbox filesystem is a separate disk. `/workspace` is the scan target — read-only, never state storage. `/tmp` is scratch you may write.

`sec_fs_write` takes the content two ways. Inline `content` is fine for a small write. For anything you revise often — the state doc especially — author it once at a real scratch path (for example `/tmp/state.yml`) with the Write/Edit tools, then commit each revision with `sec_fs_write path=/cells/<your dir>/state.yml from_file=/tmp/state.yml`. The server reads the file, so you never re-paste or re-escape the whole document into a tool call.

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

Every `sec_fs_write` appends a new revision. Nothing rewrites history. Each revision is the whole document — but you do not have to re-type it: keep the working copy at your scratch path (for example `/tmp/state.yml`), Edit it in place, and commit with `from_file`. The tree stores the full file; the Edit tool does the incremental work.

## Rehydration

After any compaction, re-read the protocol with `sec_protocol_read` and your own `state.yml` with `sec_fs_read` before continuing. Trust the tree over the summary.
