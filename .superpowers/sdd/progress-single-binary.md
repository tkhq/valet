# Progress Ledger — Single Binary + CLI (spec #5)

Branch: `feat/single-binary-cli` (worktree). Plan: `docs/plans/2026-07-17-single-binary-cli.md`.

## Status legend
- [ ] not started · [~] in progress · [x] done (reviewed green) · [!] blocked/owed

## Tasks
- [x] Plan written + committed
- [x] T1 — Uniform asset-read seam (kill migration readdir) — commit 53c870cc; both reviews PASS
- [ ] T2 — esbuild bundle + inline/copy assets + bundle guard
- [ ] T3 — CLI scaffold + config/profiles + precedence
- [ ] T4 — HTTP/WS InstanceClient library
- [ ] T5 — `valet serve` command + sandbox detect + implicit local profile
- [ ] T6 — Scriptable commands (sessions/send/gates/status) + health version
- [ ] T7 — Profile admin (login/logout/instance/config) + reset
- [ ] T8 — `valet chat` TUI (lazy deps) + pty smoke
- [ ] T9 — CLI integration suite (spawned serve)
- [ ] T10 — `valet mcp setup`
- [ ] T11 — Bun compile spike (3-part gate) — verdict may be fallback
- [ ] T12 — CI distribution (may be owed)

## Decisions / deviations log
- Phase A does NOT string-inline `.md`/`.sql`; ships them as on-disk sibling assets under `dist/assets/**` resolved via `assetBase()` when `VALET_BUNDLED=1`. True inlining deferred to Phase C (binary). Rationale: tractable, still kills tsx + slims image.
- `GET /api/health` gains `version` (+ maybe `sandboxBackend`) — only api surface change; no engine/auth change.

## Test evidence
(to be filled per task)
