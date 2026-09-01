# Valet Security, v1 spec (pivot-coordinator, tool inventory, delta re-runs)

**Status:** draft, 2026-08-31.
**Owner:** Applied AI.
**Base design:** `docs/specs/2026-08-27-valet-security-design.md`. This spec extends that design; it does not replace it.
**Scope:** the multi-persona security-engagement runner already shipped under `packages/plugin-security` and `packages/api/src/engine/security-tools.ts`. The base design covers the runner, cells, engagement tree, coverage ledger, triads, categories, invariants, and the `code-review` / `sast` / `dast` / `fuzz` / `exploit` / `threat-model` / `attack-tree` / `architect` / `verifier` / `reconcile` / `report` personas. This spec adds the pieces the base design named as re-entry seams.

## What this spec adds

1. **A per-persona tool inventory.** Every persona now names the exact scanner binaries or MCP daemons it invokes, the install method, the version pin, and the consequence when a tool is absent. The v0 preflight probe covered 6 tools (gitleaks, semgrep, bandit, gosec, npm, trivy). The v1 inventory covers 50+ tools across the seven scanner-bearing personas and pins one for each. Part 03 is the inventory. The `sec-preflight` script grows a per-persona mode.
2. **A `pivot-coordinator` persona.** A twelfth bundled persona that reads `needs.yml` from every prior cell, auto-executes three catalog patterns (`scope-auto-include`, `propagate-session`, `rerun-with-existing-loot`), surfaces one consolidated human ask for the rest, and computes `delta_targets` for the re-dispatched cells. Two L4 patterns (`create-test-account`, `tool-auth-reuse`) are specified but not required in v1. Part 05 is the persona spec; `packages/plugin-security/personas/pivot-coordinator.md` is its role markdown.
3. **A `needs.yml` schema and a `loot.catalog.yml` schema.** Two new virtual paths in the engagement tree, addressed through `sec_fs_read` / `sec_fs_write` like the existing `state.yml`. No new Postgres table. Parts 04 and 06.
4. **A `post-pivot-delta` cell mode.** A cell dispatched under this mode reads its own prior state doc, reads the `delta_targets` block from its dispatch prompt, and extends its findings list. Every new finding cites `traces_to.pivot_need`. Part 01 covers the mode; Part 07 covers the two anti-cap checks (`finding-count monotonicity` and `pivot_need citation`) enforced server-side in `sec_cell_complete`.
5. **A deterministic finding fingerprint.** Every implementation of the spec produces byte-identical fingerprint hex for the same finding inputs. Part 02 pins the function; the JSON vectors under `vectors/fingerprints.json` pin the outputs. The v0 code path in `security_findings.fingerprint` used a truncated sha256 over `(file, line/10, normalized title)`; v1 keeps the truncation shape and moves the input set to `(file, line, title, body prefix 200 codepoints)`. See Part 02 §2.2 for the migration note.

## Non-goals

Part 05 §5.9 and §5.10 specify `create-test-account` and `tool-auth-reuse` as L4 patterns. v1 does not require an implementation. Appendix C lists every other exclusion (multi-round pivots, loot encryption, MCP daemons for ZAP/Burp/Playwright, GPG signature verification for tool binaries, cross-engagement loot reuse, tool caching layer, deferred-needs bucket, fingerprint-collision audit, loot-expiry audit).

## Correctness bar

Two implementations of the L0 kernel produce byte-identical `fingerprint` hex, byte-identical `classify_need` bucket labels, and byte-identical `compute_delta_targets` JSON for identical inputs. The JSON vectors under `vectors/` pin the outputs. The conformance runner `scripts/run-vectors.py` reads every vector, dispatches by filename to the reference function, and exits non-zero on any diff.

The acceptance scenario (Appendix A) pins the observable at engagement level: a clean-start engagement runs `threat-model` -> `code-review` -> `sast` -> `dast` -> `fuzz`, three cells surface needs, `pivot-coordinator` auto-resolves one, the human resolves two, two cells re-run with `mode: post-pivot-delta`, and the final engagement carries 13 findings (9 from the first pass, 4 from the delta re-runs), every delta finding citing `traces_to.pivot_need`.

## Reading order

| Part | Contents |
|---|---|
| [Part 00: Preliminaries](spec/00-preliminaries.md) | Purpose, RFC 2119 language, vocabulary aligned to Valet v2, invariants, conformance levels. |
| [Part 01: Engagement Model](spec/01-engagement-model.md) | Cell states (`pending -> running -> completed | yielded | failed`), `mode: post-pivot-delta`, state-doc schema (`security_files` at `/cells/<NN>-<slug>/state.yml`), settlement condition. |
| [Part 02: Finding Fingerprints](spec/02-finding-fingerprints.md) | Deterministic fingerprint function, canonicalization rules (with path-traversal rejection), collision resistance, migration note vs v0 `security_findings.fingerprint`. |
| [Part 03: Tool Provisioning and Coverage](spec/03-tool-provisioning.md) | Per-persona tool inventory (60+ tools across seven personas), install mechanisms (APT, GitHub release, `go install`, `pip`, `git clone` + build), preflight probe, coverage report schema, NOT_ASSESSED contract. |
| [Part 04: Needs Schema and Classification](spec/04-needs-schema.md) | `needs.yml` schema (6 need kinds), `would_unblock` semantics, auto vs human bucket classification. |
| [Part 05: Pivot Coordinator and Delta Re-runs](spec/05-pivot-coordinator.md) | Persona modes (discover, resolve), five auto-catalog patterns (three L3 + two L4), `delta_targets` computation, dispatch contract for `post-pivot-delta` cells. |
| [Part 06: Loot Catalog](spec/06-loot-catalog.md) | `loot.catalog.yml` schema (credentials, sessions, test_data, tool_auth), atomic writes, session propagation (Netscape cookies.txt format). |
| [Part 07: Anti-Fabrication and Anti-Cap Checks](spec/07-anti-fabrication.md) | Finding-count monotonicity, `traces_to.pivot_need` citation, tool-version audit, enforcement inside `sec_cell_complete`. |
| [Part 08: UX and Web Flow](spec/08-ux-flow.md) | Hub, setup wizard, running view, consolidated ask card, delta rendering, per-flow rules for source-only, live pentest, live-plus-pivot, re-scan. |
| [Part 09: Resume from Terminal + Launch Checklist](spec/09-resume-and-launch-checklist.md) | Resume contract for closed engagements with open needs or failed cells; late needs answer; scope schema extensions (login_url, signup_url, rate_limit_rps); Launch checklist replacing the passive Review step. |
| [Appendix A: Acceptance Scenario](spec/appendix-a-acceptance.md) | Normative end-to-end integration test (clean start -> 5 personas -> pivot round -> delta re-runs -> 13 findings), mapped to Valet routes. |
| [Appendix B: Threat Model](spec/appendix-b-threat-model.md) | Threats to the runner, tools, loot, findings, coordinator, cross-engagement isolation, and their mitigations. |
| [Appendix C: Non-Goals](spec/appendix-c-non-goals.md) | v1 exclusions with a re-entry seam per item (multi-round pivots, loot encryption, MCP daemons, GPG signatures, cross-engagement loot reuse, tool caching, deferred needs bucket, collision audit, expiry audit). |
| [Appendix D: Test Vectors](spec/appendix-d-test-vectors.md) | Vector file format, dispatch-by-filename, level filter (int-mapped), 30 vectors across 5 JSON files. |

## Conformance levels

An implementation conforms to one of five cumulative levels. Each includes every requirement from every lower level.

| Level | Name | An L0..L4 implementation ships |
|---|---|---|
| L0 | Pure decision kernel | Fingerprint function, needs classification, `delta_targets` computation, auto-catalog outcome computation, anti-cap check outcome computation. No I/O. |
| L1 | Tool provisioning | L0 plus the in-sandbox tool install (APT, GitHub release, `go install`, `pip`, `git clone` + build), the per-persona preflight probe, and the coverage report schema. Personas mark missing-tool oracles NOT_ASSESSED. |
| L2 | Coordinator (discover mode) | L1 plus the pivot-coordinator persona in discover mode, `needs.yml` reads across prior cells, classification, and the consolidated `human_setup_ask.md`. No auto-catalog execution required. |
| L3 | Coordinator (resolve mode) plus delta re-runs | L2 plus resolve mode, three auto-catalog patterns (`scope-auto-include`, `propagate-session`, `rerun-with-existing-loot`), `loot.catalog.yml` writes, `delta_targets` computation, the `post-pivot-delta` dispatch contract. |
| L4 | Full system | L3 plus `create-test-account`, `tool-auth-reuse`, and the three anti-cap checks enforced in `sec_cell_complete` (finding-count monotonicity, `pivot_need` citation, tool-version audit). |

Valet Security v1 targets **L3**. The tool inventory (Part 03) and the pivot-coordinator persona (Part 05) are the two large land items.

## Where each artifact lives

The spec doc directory maps to Valet paths as follows.

| Doc artifact | Ships at (Valet path) |
|---|---|
| Every persona role markdown | `packages/plugin-security/personas/<id>.md` |
| Every methodology playbook | `packages/plugin-security/playbooks/<name>.md` |
| Every threat category YAML | `packages/plugin-security/categories/<name>.yml` |
| Every runner or persona tool | An engine `ToolDef` in `packages/api/src/engine/security-tools.ts`, attached in `packages/api/src/engine/host.ts::buildSecurityRunnerTools` / `buildSecurityPersonaTools`. |
| Every SQL schema change | `packages/api/migrations/pg/0000_app.sql` and `packages/api/src/schema/index.ts`, with a `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`. |
| Every scanner install step | `packages/api/src/engine/security-bootstrap.ts::securityToolPrepSteps`. |
| Per-persona preflight scripts | `docker/sec-preflight-<persona>.sh` and the merged `docker/sec-preflight.sh` for the default set. |
| L0 reference implementation | `docs/specs/valet-security/reference/*.py`. |
| Normative test vectors | `docs/specs/valet-security/vectors/*.json`. |
| Prose validator | `docs/specs/valet-security/scripts/check-prose.py`. |
| Conformance runner | `docs/specs/valet-security/scripts/run-vectors.py`. |

## Local build and test

**Prose validation** (em-dash blocks; sentence length warns):
```bash
python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/README.md docs/specs/valet-security/spec/*.md
```

**Conformance runner** at a level:
```bash
python3 docs/specs/valet-security/scripts/run-vectors.py --impl docs/specs/valet-security/reference --level L4
```

Exit code 0 iff every vector at the requested level or lower passes. Non-zero exit prints a per-vector diff.

## Repository layout

```
docs/specs/valet-security/
├── README.md
├── spec/
│   ├── 00-preliminaries.md
│   ├── 01-engagement-model.md
│   ├── 02-finding-fingerprints.md
│   ├── 03-tool-provisioning.md
│   ├── 04-needs-schema.md
│   ├── 05-pivot-coordinator.md
│   ├── 06-loot-catalog.md
│   ├── 07-anti-fabrication.md
│   ├── appendix-a-acceptance.md
│   ├── appendix-b-threat-model.md
│   ├── appendix-c-non-goals.md
│   └── appendix-d-test-vectors.md
├── reference/
│   ├── fingerprint.py
│   ├── needs.py
│   ├── delta_targets.py
│   ├── auto_catalog.py
│   └── anti_cap.py
├── vectors/
│   ├── fingerprints.json          # Part 02, L0, 13 vectors
│   ├── needs-classification.json  # Part 04, L2, 5 vectors
│   ├── delta-targets.json         # Part 05, L3, 2 vectors
│   ├── auto-catalog.json          # Part 05, L3, 6 vectors
│   └── anti-cap.json              # Part 07, L4, 4 vectors
└── scripts/
    ├── check-prose.py
    └── run-vectors.py
```

## Changelog

`v1-draft, 2026-08-29`: first pass, prose only. Vectors placeholder; concept-note vocabulary not aligned to Valet.

`v1, 2026-08-31`: this pass. Rewrote every part to name Valet v2 tables, tools, and personas. Added Part 03 tool inventory. Added Part 05 pivot-coordinator persona spec, its role markdown, and its playbook. Reference implementation and vector files under `reference/` and `vectors/`. Two prose + conformance scripts under `scripts/`. Advisor-flagged fixes: `normalize_path` now rejects paths that escape repo root; the `rerun-with-existing-loot` derivation rule (`https://<session.host>/*`) is documented in Part 05 §5.7; the level filter examples in Appendix D map `L0..L4` to `0..4` and compare integers. Fingerprint values replace the v1-draft placeholders; the placeholder set had no conformant implementation so nothing on the wire is invalidated.
