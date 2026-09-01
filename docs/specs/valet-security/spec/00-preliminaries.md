# Part 00: Preliminaries

*Depends on: none. Conformance: all levels.*

## Purpose

This part fixes the words and the ground rules the rest of the spec uses. It aligns the concept-note vocabulary to Valet v2 (`packages/api`, `packages/engine`, `packages/plugin-security`) so a claim in later parts always names a real table, tool, or file. It fixes RFC 2119 requirement language for every "MUST" that follows. It defines the five-level conformance ladder, and lists seven global invariants that hold at every level.

## Requirement language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174. A sentence without one of these keywords is informative, not normative.

## Terminology

One name for one thing. Where a term collides with a Valet code identifier, the code identifier wins. Where a concept has no code identifier yet, the term ships in Part 05 or Part 06 alongside the schema.

**engagement.** One security review of one repository at one pinned commit. Row: `security_engagements` (`packages/api/src/schema/index.ts`; SQL: `packages/api/migrations/pg/0000_app.sql`). Value set: `status ∈ {planning, running, completed, failed, cancelled}`.

**cell.** One dispatch unit inside an engagement. Row: `security_cells`. Value set: `status ∈ {pending, running, completed, yielded, failed}`, `mode ∈ {fresh, resume, post-pivot-delta}`. `mode: post-pivot-delta` is new in v1 (Part 01).

**plan.** The ordered list of cells materialized from `security_engagements.plan` (YAML) at `sec_start`. Immutable after start.

**persona.** The role a cell-claimed child session runs under. Bundled ids are in `BUNDLED_PERSONAS` (`packages/plugin-security/src/lib/personas.ts`). v1 adds `pivot-coordinator` to the bundled set. `LIVE_PERSONAS = {dast, fuzz, exploit}` (target-running personas that carry the authorized scope block in their dispatch).

**runner.** The `kind='security'` session whose agent drives the cell loop under the `security-engagement-runner` skill.

**engagement tree.** A virtual filesystem addressed by `sec_fs_*` tools and backed by append-only `security_files` revisions. Read-only mounts: `/protocol.md`, `/plan.yml`, `/playbooks/<name>.md`. Cell-owned subtrees: `/cells/<NN>-<slug>/*`. New in v1: `/needs/<NN>-<slug>.yml` for a per-cell need file, and `/loot/catalog.yml` for the engagement-scoped loot catalog. See Parts 04 and 06.

**state doc.** The persona's YAML working state at `/cells/<NN>-<slug>/state.yml`. Append-only revisions in `security_files`. Schema is normative (Part 01).

**finding.** A structured immutable security observation. Row: `security_findings`. v1 adds a `traces_to` field on the row: JSON with an optional `pivot_need` id. A finding emitted by a `post-pivot-delta` cell MUST carry `traces_to.pivot_need` (Part 07 §7.2).

**fingerprint.** A 20-byte Blake2b hash over a canonicalized `(file, line, title, body-prefix)` tuple, encoded as 40 lowercase hex characters and stored on `security_findings.fingerprint`. Pure, no I/O. See Part 02.

**coverage entry.** A row in `security_coverage`, one per persona-declared area. `status ∈ {assessed, not_assessed}`. `not_assessed` MUST carry a `reason` naming the consequence.

**need.** A blocker a persona surfaces when it lacks the input to test some surface. Written to `/needs/<NN>-<slug>.yml` (Part 04). Six kinds: `credential`, `session`, `scope-expansion`, `test-data`, `tool-auth`, `other`.

**pivot-coordinator.** The bundled persona that reads every prior cell's `needs.yml`, classifies each need into an `auto` or `human` bucket, executes the auto-catalog patterns for the auto bucket, writes a consolidated `human_setup_ask.md` for the human bucket, and (in resolve mode) computes `delta_targets` and re-dispatch entries. See Part 05.

**auto-catalog.** Five bundled patterns the coordinator may execute: `scope-auto-include` (IP-in-CIDR check), `propagate-session` (cookie jar file copy), `rerun-with-existing-loot` (re-dispatch with a delta from existing loot), `create-test-account` (HTTP POST signup, L4), `tool-auth-reuse` (auth blob copy, L4). Each is defined in Part 05.

**loot catalog.** The engagement-scoped store for credentials, sessions, test data, and tool auth. Path: `/loot/catalog.yml`. Schema is normative (Part 06). The pivot-coordinator writes it; personas read it when dispatched with a `delta_targets` block.

**delta_targets.** A five-field payload the coordinator computes when a need is resolved: `authed_surface`, `new_hosts`, `auth_scopes`, `test_data`, `tool_auth`. Copied verbatim into the `post-pivot-delta` dispatch prompt so the persona knows what to test without re-scanning what it already tested.

**tool.** A scanner binary (nmap, semgrep, gitleaks, nuclei, ffuf, ...) or an MCP daemon (ZAP, Burp, Playwright) a persona invokes. Install via APT, GitHub release, `go install`, `pip`, or `git clone` + build. Each install ships in `securityToolPrepSteps` (`packages/api/src/engine/security-bootstrap.ts`). See Part 03 for the per-persona inventory.

**preflight probe.** A per-persona shell script (`docker/sec-preflight-<persona>.sh`) that lists every tool the persona expects, records `present`/`absent`/`version`/`install_location`, and writes the result to a coverage-report YAML. Personas read the result and emit `sec_coverage_report status=not_assessed area=<pack> tool=<tool> reason=<consequence>` for every absent tool.

**anti-cap check.** A server-side check inside `sec_cell_complete` that enforces one invariant. v1 defines three: finding-count monotonicity across a `post-pivot-delta` re-run (Part 07 §7.1), `traces_to.pivot_need` citation on every new finding (§7.2), and tool-version audit against pinned versions (§7.3).

**settlement.** The state transition `running → completed` in `sec_cell_complete`. Triggered when the persona writes a state doc with `status: done` AND `checklist.pending: 0` AND `queue.pending: 0`, and every applicable anti-cap check passes.

Use "session" for the HTTP or app-level authenticated context. Use "sandbox" for the isolated execution environment attached to one session. Never write "workspace" for either of the above; `/workspace` is the mounted repo clone inside the persona sandbox.

## Global invariants

Every invariant below holds at every level from L0 up. Each is stated as (INV-N, name), then the mechanism that enforces it. A mechanism that ships in a later part is cited by section.

**INV-1 (Deterministic fingerprints).**
The fingerprint function produces identical output for identical inputs. Pure: no clock, no I/O, no randomness. Blake2b with empty salt, empty key, empty personalization. See Part 02 §2.2 for the algorithm and §D.1 for the vectors.

**INV-2 (Finding-count monotonicity in delta re-runs).**
A cell with `mode: post-pivot-delta` MUST NOT reduce its finding count below the prior cell's finding count. Server-side check in `sec_cell_complete`: read the prior cell's latest state doc, count `findings[]`, count the new state doc's `findings[]`, refuse the settlement (and hold the cell as `running` with a corrective error) if the new count is lower. See Part 07 §7.1.

**INV-3 (Every new finding cites pivot_need).**
A `post-pivot-delta` cell's state doc `findings[]` MUST be a superset of the prior cell's `findings[]`. Every id that is new in the superset MUST be a finding row whose `traces_to.pivot_need` is a resolved need id from the pivot round that unblocked the delta. Server-side check in `sec_cell_complete`. See Part 07 §7.2.

**INV-4 (Auto-catalog idempotence).**
Running the same auto-catalog pattern twice with the same inputs writes the same loot entries. Deterministic username templates (`pentest-<engagement_slug>-r<round>-<suffix>`). Rerun detection: the coordinator checks the loot catalog for an existing entry keyed by `(pattern, need_id, round)` before executing. See Part 05 §5.11.

**INV-5 (Loot catalog atomicity).**
A write to `/loot/catalog.yml` is atomic. Partial writes are not observable. Two mechanisms exist: (a) v1 writes through `sec_fs_write`, which is a single-transaction insert into `security_files`, so a crashed coordinator either committed a new revision or did not; no half-row is observable; (b) the coordinator writes to `/loot/catalog.yml.tmp` first and moves to `/loot/catalog.yml` in a second `sec_fs_write` when it wants a two-phase commit for a multi-file update. See Part 06 §6.4.

**INV-6 (Tool version pinning).**
Every install command in the tool inventory pins an exact version. APT commands use `nmap=7.94-1`, not `nmap`. GitHub release commands use a tag (`v3.2.0`) and an SHA-256 checksum. `go install` uses a tag or commit hash. The preflight probe records the installed version in the coverage-report YAML. The verifier persona reads the coverage report and audits versions against the pinned set. See Part 03 §3.1 and Part 07 §7.3.

**INV-7 (No cross-engagement tool state).**
Tools write outputs under a persona-scoped path in the sandbox (e.g. `/workspace/tool-out/<engagement>/<cell>/*`). Two sandboxes never share a writable volume. A persona MUST NOT read a path outside its sandbox. See Appendix B §T-14.

## Conformance levels

The five levels are cumulative. Each level includes every requirement from every lower level.

**L0. Pure decision kernel.** No I/O, no side effects, no filesystem, no network.
- Fingerprint function (Part 02 §2.2), 13 vectors (§D.1).
- Needs classification (Part 04 §4.3), 5 vectors (§D.3).
- `delta_targets` computation (Part 05 §5.4), 2 vectors (§D.2).
- Auto-catalog outcome computation as a pure function (Part 05 §5.5-5.7), 6 vectors (§D.4).
- Anti-cap outcome computation as a pure function (Part 07 §7.1-7.2), 4 vectors (§D.5).

**L1. Tool provisioning.** L0 plus:
- In-sandbox tool install (APT, GitHub release, `go install`, `pip`, `git clone` + build) per the Part 03 inventory.
- Per-persona preflight probe writes the coverage-report YAML.
- Personas mark a missing-tool oracle NOT_ASSESSED (Part 03 §3.4).

**L2. Coordinator (discover mode).** L1 plus:
- `pivot-coordinator` persona in discover mode reads `/needs/*.yml` files (Part 05 §5.2).
- Classifies each need `auto | human` (Part 04 §4.3).
- Writes `human_setup_ask.md` in the engagement tree (Part 05 §5.2).
- Auto-catalog execution is NOT required at L2 (coordinator surfaces every need as a human ask).

**L3. Coordinator (resolve mode) plus delta re-runs.** L2 plus:
- Coordinator in resolve mode reads `human_response.yml`, applies human input to the loot catalog (Part 05 §5.3).
- Executes three auto-catalog patterns: `scope-auto-include`, `propagate-session`, `rerun-with-existing-loot` (Part 05 §5.5-5.7).
- Writes `/loot/catalog.yml` (Part 06 §6.1).
- Computes `delta_targets` for each re-dispatched persona (Part 05 §5.4).
- The `post-pivot-delta` dispatch contract holds (Part 05 §5.8): the persona extends its prior state doc, cites `traces_to.pivot_need`.

**L4. Full system.** L3 plus:
- `create-test-account` and `tool-auth-reuse` (Part 05 §5.9-5.10).
- Anti-cap checks enforced in `sec_cell_complete` (Part 07 §7.1-7.3).

Every JSON vector in Appendix D is tagged with its level. An implementation at level N MUST pass every vector tagged N or lower. The runner's level filter maps `L0..L4` to integers `0..4` and compares integers. String comparison is a runner bug (see §D.6).

## Valet Security v1 targets L3

The MVP ships every L3 requirement. `create-test-account` and `tool-auth-reuse` are specified in Part 05 §5.9-5.10 for symmetry with the coordinator schema, but the acceptance scenario (Appendix A) does not exercise them. The three anti-cap checks (Part 07) ship at L3 as recommended and become required at L4.

## Migration from the base design

The base design (`docs/specs/2026-08-27-valet-security-design.md`) is unchanged by this spec. The additions land as:

- New rows in `security_findings.traces_to` (JSONB column) and the anti-cap checks in `sec_cell_complete`. SQL: `packages/api/migrations/pg/0000_app.sql`; edit-in-place per the pre-1.0 rule (`packages/api/src/lib/drizzle.ts::SCHEMA_REPAIRS`).
- New persona `pivot-coordinator` in `BUNDLED_PERSONAS`. Role markdown at `packages/plugin-security/personas/pivot-coordinator.md`. Playbook at `packages/plugin-security/playbooks/pivot-coordinator.md`. No new engine tool for the coordinator: it uses the existing `sec_fs_read`/`sec_fs_write`/`sec_finding_report` set. It DOES gain access to a new persona tool `sec_loot_write` (append-only write to `/loot/catalog.yml`, with two-phase commit) documented in Part 06 §6.4.
- New cell mode `post-pivot-delta` recognized in `parsePlan`, `serializePlan`, `buildDispatchPrompt`, and `sec_cell_complete`. Recognized in the plan editor UI (`packages/web`) as a read-only cell that the coordinator materializes.
- New preflight scripts per persona under `docker/sec-preflight-<persona>.sh`. The existing `docker/sec-preflight.sh` becomes the default (union of the persona sets).
- No breaking change to existing personas, existing cells, existing findings, or existing coverage rows.
