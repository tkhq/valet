# Security v2 Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Record of the original design.** This plan drove the first implementation. The review-fix pass that followed changed two things it describes: the needs column shipped as `security_needs.credential_label` (not `credential_ref`), and one shared validator in `@valet/shared` replaced the per-package copies (`OP_REFERENCE_MIRROR` and friends no longer exist). The specs in `docs/specs/valet-security/spec/` are the source of truth.

**Goal:** Land Parts 11, 12, and a new normative Part 13 for Valet Security v1 against current dev-v2, plus the four deferred implementation items (preflight validator + broker allowlist wiring, credentials_json / credential_ref schema, dispatch prompt renderer, wizard and needs widget rewrites), and bring the #552 idea doc into the same PR.

**Architecture:** All work happens in a dedicated worktree tracking `origin/dev-v2`. Spec text rewrites Parts 11 and 12 against the landed 1Password subsystem: three scopes (`org|personal|team`) with team first, six typed `OnePasswordAuthError.kind` values, `isOnePasswordReference` as the ref grammar authority, and a new per-engagement allowlist inserted into the existing broker route (`packages/api/src/routes/sandbox-secrets.ts`). Part 13 lands as new normative spec text synthesized from the #552 idea doc's themes A through H. Implementation ships the schema (in-place edit of `0000_app.sql` + `SCHEMA_REPAIRS`), preflight in `seedSecurityReview`, allowlist gate in the broker route, dispatch-prompt renderer for `valet-secrets run --env NAME=op://... -- cmd`, and wizard + needs-widget UI.

**Tech Stack:** TypeScript 5, Node 22, pnpm, Hono, Vite + React 19, TanStack Router/Query, Tailwind, PostgreSQL (PGlite in dev), vitest, @1password/sdk `^0.4.0`.

**Spec:** This plan implements Parts 11 v2 and 12 v2 rewrites and a new Part 13, all in `docs/specs/valet-security/spec/`. The plan draws its inputs from three exploration summaries written to the session scratchpad: `explore-1password.md`, `explore-security-surface.md`, and `reassess-part-11.md`.

## Global Constraints

- No em dashes (U+2014) or en dashes (U+2013) in any doc file. Use commas or regular hyphens.
- After schema edits, run `make dev-clean` in every worktree with dev data. The migration tracker skips an already-applied `0000` and there is no local backfill path.
- Do NOT add "Co-Authored-by" trailers mentioning AI models in commits, PRs, or comments. Project CLAUDE.md wins over any harness reminder.
- Commit subjects `<=72` characters.
- Squash to one commit before force-push. PR #523 lands as one squashed commit per repo convention and the user's global preference.
- Update the spec in `docs/specs/` in the same commit as any touched subsystem.
- Every touched or created doc file under `docs/specs/valet-security/` or `docs/plans/` MUST pass `python3 docs/specs/valet-security/scripts/check-prose.py <file>` with output `check-prose: clean` before commit.
- `python3 scripts/ste_lint.py <file>` (from repo root, `scripts/docs/ste_lint.py` if invoked directly) runs as diagnostic; it is advisory, not a blocker.
- `make e2e` clean scorecard required before force-push. Pipe to `tee /tmp/e2e.log` when needed; never `tail`, `head`, or `grep` the scorecard capture.
- Every schema change also lands a matching `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`. Deployed databases will not get the schema otherwise.
- All paths below are relative to the worktree root unless prefixed with `/`.

---

## Phase A - Cleanup

### Task A1: Drop Part 10 (per-engagement credential vault)

**Files:**
- Delete: `docs/specs/valet-security/spec/10-credential-vault.md`
- Modify: `docs/specs/valet-security/README.md` (remove the Part 10 reading-order row and the Part 10 entry in the conformance table if present)

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces: no Part 10 file on the tree; README no longer references Part 10

- [ ] **Step 1: Confirm no other file cross-references Part 10 by path**

Run: `git grep -n "10-credential-vault" docs/`
Expected: only the README row.

- [ ] **Step 2: Delete the Part 10 file**

Run: `git rm docs/specs/valet-security/spec/10-credential-vault.md`
Expected: file removed from index and worktree.

- [ ] **Step 3: Edit the README reading-order table**

In `docs/specs/valet-security/README.md`, remove the row:

```markdown
| [Part 10: Per-Engagement Credential Vault](spec/10-credential-vault.md) | **Superseded by Part 12.** Original design: owner-scoped encrypted-at-rest vault, credsMount delivery, three-seam tripwire. Kept for the history of the seven `kind` values and the dispatch-prompt rendering that Part 12 reuses. |
```

Also remove any mention of Part 10 in the "Changelog" or "Where each artifact lives" sections.

- [ ] **Step 4: Run the prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/README.md`
Expected: `check-prose: clean`

- [ ] **Step 5: Commit**

```bash
git add docs/specs/valet-security/README.md docs/specs/valet-security/spec/10-credential-vault.md
git commit -m "spec(security): drop Part 10 (superseded by Part 12)"
```

---

### Task A2: Bring the #552 idea doc into this worktree

**Files:**
- Create: `docs/plans/2026-09-03-security-ux-v2-idea.md` (copied verbatim from the same path in the primary checkout)

**Interfaces:**
- Consumes: the existing file on the primary checkout (PR #552 branch)
- Produces: the same idea doc under `docs/plans/` in this worktree, so #552 can be closed without losing content

- [ ] **Step 1: Copy the file verbatim**

Set `PRIMARY_CHECKOUT` to the path of the primary Valet checkout, the one that holds the PR #552 branch. Then run:
```bash
cp "$PRIMARY_CHECKOUT"/docs/plans/2026-09-03-security-ux-v2-idea.md docs/plans/2026-09-03-security-ux-v2-idea.md
```

- [ ] **Step 2: Confirm byte-for-byte match**

Run:
```bash
diff -q "$PRIMARY_CHECKOUT"/docs/plans/2026-09-03-security-ux-v2-idea.md docs/plans/2026-09-03-security-ux-v2-idea.md
```
Expected: no output.

- [ ] **Step 3: Run the prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/plans/2026-09-03-security-ux-v2-idea.md`
Expected: `check-prose: clean`

- [ ] **Step 4: Commit**

```bash
git add docs/plans/2026-09-03-security-ux-v2-idea.md
git commit -m "docs(security): bring UX v2 idea doc into this PR"
```

---

## Phase B - Spec rewrites

### Task B1: Rewrite Part 12 (credentials via 1Password) against dev-v2

**Files:**
- Rewrite: `docs/specs/valet-security/spec/12-credentials-via-1password.md`

**Interfaces:**
- Consumes: existing Part 12 draft (270 lines) plus fork-1 findings (see explore-1password.md)
- Produces: Part 12 v2 with correct references to landed code (`OnePasswordService`, `OP_REFERENCE`, `isOnePasswordReference`, `onePasswordScopesFor`, `OnePasswordAuthError.kind` six values, `sandbox-secrets.ts` broker route, `secrets-cli-script.ts` valet-secrets CLI, `commandWrapperScript` pattern), and clearly named new invariants (INV-32 preflight, INV-33 broker allowlist inserted, INV-34 tripwire seam)

- [ ] **Step 1: Replace the "Depends on PR #421" block with a "Depends on landed subsystems" block**

Open `docs/specs/valet-security/spec/12-credentials-via-1password.md`. Find the sentence naming PR #421. Replace with:

```markdown
Depends on the landed 1Password subsystem: `OnePasswordService` in `packages/api/src/services/onepassword.ts`, the sandbox secret broker at `POST /api/sandbox-secrets/resolve` in `packages/api/src/routes/sandbox-secrets.ts`, the `valet-secrets` CLI generator in `packages/api/src/engine/secrets-cli-script.ts`, the owner-precedence rule `onePasswordScopesFor` in `packages/api/src/services/credential-resolution.ts`, and the team-vault design in `docs/specs/2026-09-04-team-onepassword-vaults-design.md`.
```

- [ ] **Step 2: Rewrite the Vocabulary section to name the three scopes and the six error kinds**

Add or replace:

```markdown
**Scope.** One of `org`, `personal`, `team`. `onePasswordScopesFor(ownerType, teamId?)` returns the ordered list a resolver may consult: `["team","org"]` for a team-owned engagement, `["org","personal"]` for a user-owned one, `["org"]` otherwise. Team is authoritative when configured; only an absent team token permits an org fallback. A configured team token that refuses a specific reference does NOT fall back.

**op:// reference.** A string that matches `OP_REFERENCE` in `packages/api/src/services/onepassword.ts`. The grammar is 3 or 4 segments: `op://vault/item/field` or `op://vault/item/section/field`. Segments may contain spaces. Segments may not contain `/` or control characters. The security config parser calls `isOnePasswordReference(ref)`; it never reprints the regex.

**Auth error.** `OnePasswordAuthError` with `kind: "no_token" | "disabled" | "sdk" | "scope" | "reference" | "ambiguous"`. Preflight distinguishes all six values (see INV-32 below).
```

- [ ] **Step 3: Rewrite INV-32 (preflight) to name each error kind**

```markdown
**INV-32 (Preflight resolves every declared reference under the owner rule).** At engagement start, `seedSecurityReview` iterates `securityConfig.credentials` and calls `OnePasswordService.resolveReference(scope, ctx, ref)` for each declared reference. `scope` comes from `onePasswordScopesFor(ownerType, teamId?)`. The value is discarded immediately after a shape check by `kind`. A failed resolve refuses the seed with a corrective error keyed on `OnePasswordAuthError.kind`:

- `no_token`: name the missing scope and the settings path to connect a token.
- `disabled`: name the org toggle (Organization > 1Password > Allow personal vault) that must be flipped.
- `scope`: name which scopes were tried and which succeeded (or none).
- `reference`: name the ref that failed and hint that the item may have been deleted or renamed.
- `ambiguous`: list the candidate refs (up to 10) and ask the user to pick one.
- `sdk`: name the operation ("resolve reference") only; do not leak upstream text or the token.
```

- [ ] **Step 4: Add INV-33 (broker allowlist)**

```markdown
**INV-33 (Broker allowlist is per-engagement).** The landed broker (`packages/api/src/routes/sandbox-secrets.ts::POST /resolve`) today gates by owner scope (`onePasswordScopesFor`) plus the sandbox token principal. This part adds a per-engagement allowlist inserted BEFORE the existing `resolveReference` call. When a sandbox session owns a `security_cells` row, the broker loads `security_engagements.credentials_json` for that engagement and refuses any ref not in the declared list. Every other broker caller path (workflow, coding session, orchestrator) bypasses the allowlist and continues to gate on owner scope alone. A refused ref returns 403 by ref value; the response NEVER names other allowlisted refs.
```

- [ ] **Step 5: Replace the "tripwire" section with an INV-34 seam**

```markdown
**INV-34 (Tripwire seed is a broker resolve for a security cell).** The broker publishes nothing observable today. This part adds one seam: when the broker resolves a ref for a sandbox whose session owns a `security_cells` row, the resolver publishes `(engagementId, label, valueBytes)` to a per-engagement in-memory index. The persist seam (`sec_fs_write`, `sec_finding_report`, `sec_cell_complete`) scans that index before writing. The send seam (`bridge.ts::engineToWireParts`) scans the same index before shipping. Values live in `Buffer` only, held by the index for the engagement's lifetime, zeroed on session close. A match hard-fails the seam. INV-34 is a safety net, not the primary control; the primary control is `INV-33`. A persona can still curl the broker directly (documented broker limit in `docs/specs/2026-09-01-sandbox-secret-broker-design.md`), which INV-34 catches on write.
```

- [ ] **Step 6: Rewrite the Persona invocation section around commandWrapperScript**

```markdown
## Persona invocation

Each declared credential surfaces in the dispatch prompt as a `valet-secrets run --env NAME=op://... -- cmd` template plus its label. The persona never sees the ref itself; it references the credential by label. The `commandWrapperScript` generator in `packages/api/src/engine/secrets-cli-script.ts` produces per-command wrappers from `.valet/credentials.yaml`. Security engagement configs (`securityConfig.credentials[]`) share the same shape (`label`, `env`, `reference`, optional `refShape`), so one wrapper generator serves both surfaces. Reserved wrapper commands `valet-secrets` and `op` are installed at `/usr/local/bin` by the `credential-scripts` prep step (see `sandbox-spec.ts:80`).
```

- [ ] **Step 7: Update the "Owner precedence" section to reflect the three-scope reality**

Replace any two-scope narrative with:

```markdown
The owner rule `onePasswordScopesFor(ownerType, teamId?)` decides the ordered scope list a preflight or resolve may consult. A team-owned engagement's declared refs resolve against `["team","org"]`. A user-owned engagement's refs resolve against `["org","personal"]`. A repo-owned or workspace-owned engagement's refs resolve against `["org"]`. A team engagement whose team token is configured but refuses a specific ref does NOT fall back to org for that ref; a configured team is authoritative.
```

- [ ] **Step 8: Prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/spec/12-credentials-via-1password.md`
Expected: `check-prose: clean`. If em dashes appear, replace with commas or hyphens and rerun.

- [ ] **Step 9: Commit**

```bash
git add docs/specs/valet-security/spec/12-credentials-via-1password.md
git commit -m "spec(security): Part 12 v2 rewrite against landed 1Password"
```

---

### Task B2: Rewrite Part 11 (runtime execution) against dev-v2

**Files:**
- Rewrite: `docs/specs/valet-security/spec/11-runtime-execution.md`

**Interfaces:**
- Consumes: existing Part 11 (404 lines) + reassess-part-11.md verdicts
- Produces: Part 11 v2 with a two-mode tool contract (`sec_verify_exec` sandbox default + `sec_http_request` api-side fallback), an invariant remap (KEEP INV-19 revised, INV-20, INV-21 strengthened, INV-23, INV-26; REVISE INV-22, INV-25 conditional, INV-27; DROP INV-18, INV-24 conditional, INV-28; NEW INV-30 wrapper bypass, INV-31 broker sees calling cell)

- [ ] **Step 1: Rewrite the "Why the api-side path fits" section as "Two-mode contract"**

Replace the entire section with:

```markdown
## Two-mode contract

Runtime-verify cells choose one of two egress modes per call, declared on the cell as `verification.egress_mode: "sandbox" | "api"` (default: `sandbox`).

**Mode 1: `sec_verify_exec` (sandbox-side, default).** A new tool that wraps `valet-secrets run --env ... -- curl ...` with plan enforcement. Reuses the landed broker (`POST /api/sandbox-secrets/resolve`) and the `valet-secrets` CLI (`packages/api/src/engine/secrets-cli-script.ts`). Values never enter api Node heap. Curl output is canonicalized, hashed, and dropped; evidence is written from the wrapper via `sec_fs_write`. Redirects are refused (`--max-redirs 0`). The wrapper refuses any plan step whose URL template references a vault name.

**Mode 2: `sec_http_request` (api-side, opt-in).** Kept for a private-cluster target or a Node-native TLS knob no `curl` flag covers. Fires from the api Node process via `undici`. All of Part 11 v1's Node hygiene (Buffer-not-String, no keep-alive pool, boot refusals, heap-dump guards) applies to this mode only.

A cell chooses mode via the persona's `verification` block; `sec_cell_complete` refuses to settle a runtime-verify cell whose evidence file names an egress mode not listed on the cell.
```

- [ ] **Step 2: Rewrite the invariant table per the reassessment**

Replace the "Global invariants" block. Keep INV-19 (revised), INV-20, INV-21 (strengthened), INV-23, INV-26 as-is or lightly revised. Rewrite INV-22, INV-25, INV-27 to be conditional on egress mode. Drop INV-18, INV-24, INV-28 (INV-24 becomes a note under mode 2 only). Add INV-30 and INV-31.

Sample INV rewrites:

```markdown
**INV-19 (One bounded egress channel per cell).** A runtime-verify cell has exactly one egress tool in its toolset for target egress. `mode: sandbox` gives the cell `sec_verify_exec` and nothing else target-egress-shaped. `mode: api` gives the cell `sec_http_request` and nothing else. A cell that spawns `curl` from `sec_bash` (mode `sandbox`) or `fetch` from a JavaScript persona tool (mode `api`) and hits the plan's host is a hard cell failure; the egress tool rejects the plan and the cell settles `failed`.

**INV-22 (Evidence file has no raw response bytes).** The evidence file schema captures only key paths, HTTP status codes, and SHA-256 hashes of canonicalized request/response bytes. `sec_fs_write` on `/cells/*/verify-runs/*.yml` refuses any evidence doc whose bytes contain a substring that matches the value the broker returned for THIS cell (the per-cell filter, populated by `sec_verify_exec` before the wrapped curl runs, or by `sec_http_request` after the response is drained). The filter is scoped to the cell and is zeroed on cell settle.

**INV-24 (api-side mode only: values live in `Buffer`, never in a JS `String`).** Applies only when a cell chose `verification.egress_mode: "api"`. `sec_http_request` reads the plaintext into a Node `Buffer` after `decryptSecret`, zeros the Buffer with `.fill(0)` in a `finally` block, and never constructs a JS string with the plaintext. This invariant is a no-op in `mode: sandbox`; the api process does not see the value.

**INV-25 (api-side mode only: fresh HTTP client per request).** Applies only in `mode: api`. `sec_http_request` builds a per-call `undici.Client`. Keep-alive is disabled. In `mode: sandbox`, curl's transport is used and `--max-redirs 0` + `--no-keepalive` are set by the wrapper.

**INV-27 (Redirect refusal by default).** In `mode: api`, `undici` follows at most one redirect and only when the `Location` host is in the plan's host set. In `mode: sandbox`, the wrapper sets `--max-redirs 0`; a plan step whose expected response is a redirect must set `verification.expect_status: 3xx` and read the `Location` header via the evidence schema.

**INV-30 (Verify tool cannot be bypassed by direct broker calls).** A runtime-verify cell whose `verification.egress_mode: "sandbox"` is dispatched into a sandbox with `valet-secrets` and per-command wrappers REMOVED from `/usr/local/bin`. Only `sec_verify_exec`'s bundled wrapper resolves values for that cell. The sandbox spec (`packages/api/src/engine/sandbox-spec.ts`) reads the cell mode when generating prep steps and skips the `credential-scripts` step for a runtime-verify sandbox in `mode: sandbox`.

**INV-31 (Broker sees the calling cell).** The broker request from `sec_verify_exec`'s wrapper includes an `x-valet-verify-cell: <cell_id>` header. The broker route validates that the header's cell id belongs to a runtime-verify cell in `running` state, gated by `x-valet-sandbox`'s session claim. The broker logs and rate-limits per verify cell, not per sandbox.
```

- [ ] **Step 3: Rewrite the "Sandbox-native follow-up" section**

Replace with:

```markdown
## Sandbox-native default

v1 (Part 11 as drafted) shipped api-side as the only mode; the sandbox-native plane was a follow-up. v2 ships sandbox-side as the default because the broker + `valet-secrets` primitives that unlock it are landed on dev-v2 (see `docs/specs/2026-09-01-sandbox-secret-broker-design.md`). The api-side mode is retained as a fallback so an engagement whose target is only reachable from the api (a private cluster, a Node-native TLS knob) can still verify.
```

- [ ] **Step 4: Prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/spec/11-runtime-execution.md`
Expected: `check-prose: clean`.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/valet-security/spec/11-runtime-execution.md
git commit -m "spec(security): Part 11 v2 rewrite with two-mode contract"
```

---

### Task B3: Create Part 13 (UX v2) as new normative spec

**Files:**
- Create: `docs/specs/valet-security/spec/13-ux-v2.md`

**Interfaces:**
- Consumes: the #552 idea doc themes A through H (now under `docs/plans/2026-09-03-security-ux-v2-idea.md` in this worktree), plus the current shapes named in explore-security-surface.md
- Produces: normative Part 13 spec with invariants, wire deltas, schema deltas, and a supersession table for Parts 08 and 09

- [ ] **Step 1: Scaffold the file with header, purpose, and vocabulary**

Create the file with:

```markdown
# Part 13: UX v2 (DAG plan editor, three-verdict findings, HTML report artifact, architecture memory)

*Depends on: Parts 00, 01, 02, 08, 09, 12. Conformance: L1+ (UI-only for A through D and G; server-side schema for E and F).*

## Purpose

This part fixes the intended end-to-end user experience for a security engagement, superseding parts of Parts 08 and 09 (see `#supersession-table` below). Every change here is orthogonal to the L0 kernel (Parts 02, 04, 05, 07) and to the runtime substrate (Parts 01, 03, 06). The kernel and substrate do not change; the UI over them does. The one storage change (Section E, human overlay on findings) is designed so the finding fingerprint stays byte-stable across a human edit.

## Vocabulary

**DAG editor.** The plan editor rendered as a directed-acyclic-graph view of `PlanCell[]`. Nodes are cells, edges are `reads` dependencies, layout is left-to-right by depth. The editor is a *view* over the existing ordered list; `parsePlan` and `serializePlan` are unchanged.

**Verdict.** A human's read of a finding: `verified_agree`, `verified_disagree`, or `refuted`. Distinct from the model's status; `verified` alone (without a human read) is not a valid terminal state in v2.

**Human overlay.** The columns `human_severity`, `human_title`, `human_body`, `human_edited_at`, `human_edited_by` on `security_findings`. The finding fingerprint stays computed over the model-authored fields (see Part 02). Overlay fields render on the finding card and in the report artifact.

**Architecture memory.** The virtual path `/architecture.yml` in the engagement tree, authored by the `recon` persona and editable by the human. Later cells read the current version. A model-authored architecture claim is a claim, not evidence; Part 07 anti-cap rules stay authoritative.

**Report artifact.** A single-file HTML publish of the engagement's report, produced by the `report` cell through a new engine tool `sec_report_publish_html`. Rides the existing `artifacts` table (share link, org gating).
```

- [ ] **Step 2: Write Section A (preset rename)**

Append:

```markdown
## Section A: Preset rename (label-only)

The preset id `code-review` keeps its id. Its label changes from "Full code review" to "Basic code review" in two files that MUST stay in sync:

1. `SECURITY_PRESETS[0].label` in `packages/web/src/routes/security.index.tsx`.
2. The matching preset row in `packages/plugin-security/src/lib/presets.ts`.

Every preset card gains a one-line hint sourced from the preset row: `"Starting point. Reconfigure the plan on the next step."`.

**Rationale.** Users read the old label as an exhaustive scan and stop exploring the plan editor. The new label signals a starting point and pairs with the DAG editor (Section C).
```

- [ ] **Step 3: Write Section B (focus and invariants under Advanced)**

Append:

```markdown
## Section B: Focus and invariants under Advanced; persona-prompt rewrite

**Wizard change.** The Focus step's `focus` textarea and `invariants` list move under an Advanced disclosure. The disclosure is collapsed by default. The Launch checklist (Part 09) gains one line: `"Focus and invariants set under Advanced: <yes | no>"`.

**Persona-prompt change.** Every file in `packages/plugin-security/personas/` is rewritten so `focus` reads as a hint to spend extra attention on, not a scope boundary; `invariants` reads as hypotheses to check against, not truths the persona should not challenge.

**Testable acceptance.** For a fixed corpus repo, a run with non-empty `focus` and `invariants` MUST NOT reduce the coverage ledger's assessed-surface count versus a matched run with both empty. If it does, the persona narrowed. Appendix A gains a new row for this test.

`SecurityConfig.focus` and `SecurityConfig.invariants` stay in the schema and stay honored on `.valet/security.yml` load. No wire change.
```

- [ ] **Step 4: Write Section C (DAG plan editor)**

Append:

```markdown
## Section C: DAG plan editor

The plan editor renders `PlanCell[]` as a DAG using dagre or elkjs for layout. Nodes are cells, edges are `reads` dependencies. Backward and cyclic edges are impossible to draw; the editor refuses. Node chrome shows: ordinal, persona (with the `D` chip for `DETERMINISTIC_PERSONA_IDS`), truncated goal, and a small badge for `triad`, `review`, or `post-pivot-delta`. Every other control (persona dropdown, playbook, mode, reads multi-check, triad, review, paths) lives in a per-node right-side edit drawer.

**Editor invariants.**

- Editor rewrites ordinals on save so serialized `PlanCell[]` stays reads-earlier-only.
- `MAX_STEPS = 32` preserved.
- `post-pivot-delta` reads exactly one earlier step and is never a triad. Preserved from Part 08.
- Deleting a node cascades: the editor asks the user to remap or delete every descendant.
- Round-trip: `parsePlan(serializePlan(edit(parsePlan(input)))) === parsePlan(input)` for every plan the current linear editor accepts. Ship a vitest snapshot suite on seeded presets.
```

- [ ] **Step 5: Write Section D (running-view layout)**

Append:

```markdown
## Section D: Running-view layout rebalance

The running view (`packages/web/src/components/security/engagement-panel.tsx`) rebalances screen real estate around findings:

- Left column defaults to 40% width. Top: DAG (nodes stream cell state). Bottom: read-only activity stream (persona thought log + tool calls).
- Right column defaults to 60% width. Top: findings list + detail. Below: coverage. Below: report artifact preview.
- Divider is draggable. Position persists in `localStorage`.
- The activity stream is read-only in v2. No input field. A future spec adds input.
- Node state on the DAG mirrors `security_cells.status`. A running node pulses.
- `PivotRoundCard` (Part 08 §Consolidated ask card) renders as an overlay banner above the DAG when a coordinator round yields.

**Finding-to-stream cross-link (cell-level).** `security_findings.cellId` already ties a finding to its origin cell. Clicking a finding scrolls the activity stream to the first entry from that cell and highlights it. Clicking a stream row for a cell filters the findings list to that cell. Turn-level linking (`originEntryId`) is a Part 14 upgrade.
```

- [ ] **Step 6: Write Section E (three-verdict findings and human overlay)**

Append:

```markdown
## Section E: Three-verdict findings with human overlay

The finding status enum widens from `open | verified | refuted | fixed` to `open | verified_agree | verified_disagree | refuted | fixed`. Migration: existing `verified` rows are read as `verified` (an untouched-by-human state that renders in the UI as "verified (needs human read)"). A human action promotes to `verified_agree` or `verified_disagree`. `sec_finding_review` accepts all values.

**Keyboard.** `v` opens a verdict popover with `a` (agree) and `d` (disagree). One keystroke stays for the fastest path (`v` then `a`); the popover auto-focuses. `r` still refutes with the reason dialog.

**Human overlay.** Inline edit of a finding is stored as an overlay, never a rewrite of the fingerprint inputs (Part 02 pins `file`, `line`, `title`, `body prefix 200 codepoints`). New columns on `security_findings`:

- `human_severity` (nullable severity enum).
- `human_title` (nullable text).
- `human_body` (nullable text).
- `human_edited_at` (nullable timestamptz).
- `human_edited_by` (nullable text: user id).

Rendering prefers the overlay when present. Fingerprint computation reads model-authored fields only. Rescan carry-over via `carriedFromFindingId` stays exact.

**Reasoning drawer.** A new column `reasoning` (nullable text) on `security_findings` stores the persona's rationale for the finding. Personas populate it on emit. The finding detail pane shows the reasoning in a collapsible drawer.

**Boundary statement.** Valet owns findings and verdicts. Valet does NOT own accept, mitigate, or remediate. A future Meridian handoff surfaces those; v2 does not build the button.
```

- [ ] **Step 7: Write Section F (HTML report artifact)**

Append:

```markdown
## Section F: Report artifact (Fano-style HTML)

The `report` cell today writes markdown and JSON to the engagement tree and to `security_engagements.report_markdown`/`report_json`. v2 also publishes one rich HTML artifact through the existing `artifacts` table (`packages/api/src/routes/artifacts.ts`).

**New artifact kind: `security-report`.** `POST /api/artifacts/share` accepts `kind: "security-report"` with a payload naming the engagement id. The artifact row snapshots the HTML at publish time. A rescan does not touch the parent's artifact.

**Per-finding visualization button.** A new engine tool `sec_finding_viz_generate` generates one visualization for a specific finding on demand. Result stores as an inline block on the finding and re-publishes the HTML artifact.

**HTML sanitization.** Model-authored HTML is untrusted content. Publish-time sanitization MUST strip `<script>`, `<style>`, event handlers, and external URLs. Diagrams render as inline SVG or mermaid rendered at publish time; the artifact never fetches external scripts at view time.

**Open question (see Appendix): content-security policy.** `GET /api/artifacts/:token` today does not set a `Content-Security-Policy` header (verified against `packages/api/src/routes/artifacts.ts`). This part depends on the artifact route setting `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'` on the response. If the route does not set that CSP, this section ships only after the artifact route is hardened.

**Threat-model addition (Appendix B).** Stored XSS via a finding title, exfil via an `<img>` off-org, clipboard hijack via an inline handler. Mitigations: strict sanitization above, strict CSP on the artifact route, no external URL retained in a published artifact.
```

- [ ] **Step 8: Write Section G (rescan v2) and Section H (architecture memory)**

Append:

```markdown
## Section G: Rescan v2

The rescan action today opens a new engagement and starts immediately. v2 turns rescan into a two-click flow so users can reshape the plan.

1. From a terminal engagement row, click **Rescan**.
2. `/security/new` opens with `SecurityNewSearch.rescanOf: <parent id>`.
3. `POST /security/preview` accepts `rescanOf` and returns the parent's final `planCells`, `config`, `authorizedScope`, `focus`, `invariants`, `categories` (fetched from `security_engagements` and the child cells' state docs).
4. The wizard skips to Step 2 (Plan) because that is where rescan diverges from a fresh run. Step 1 stays reachable via Back.
5. The DAG editor prefills with the parent's plan. Users add, remove, or re-order nodes; delete-cascade applies.
6. Nodes whose reads chain touches `reconcile` render with a "carry-forward" chip.
7. Start creates the engagement with the edited plan and `rescanOf`. `reconcile` cell behavior unchanged.

If the user removes the `reconcile` cell, the wizard shows a warning banner: `"Rescan without a reconcile cell will not carry parent findings."`

## Section H: Architecture memory

Virtual path `/architecture.yml` in the engagement tree, addressed through `sec_fs_read` / `sec_fs_write`. No new Postgres table.

**Content shape.**

```yaml
version: 1
authored_by: recon
last_edited_at: 2026-09-12T00:00:00Z
components:
  - id: web-api
    kind: service
    language: node
    entrypoints:
      - packages/api/src/main.ts
    trusts: [db, session-store]
  - id: db
    kind: datastore
    trusts: []
trust_boundaries:
  - from: internet
    to: web-api
    controls: [tls, session-cookie]
notes: |
  free-form context downstream personas read.
```

**Flow.** The `recon` persona populates `/architecture.yml` on first run. Later cells read it via a new `reads_arch: true` flag on `PlanCell` (default `true` for every non-recon cell). The running view renders a diagram under the coverage tab with an **Edit** button. Human edits stamp `authored_by: "human"` and `last_edited_at`. Next cell reads the edited version.

**Boundary.** Architecture memory is a claim, not evidence. A persona that cites `/architecture.yml` in a finding's reasoning MUST also cite file evidence. Part 07 anti-cap rules stay authoritative.
```

- [ ] **Step 9: Write the supersession table**

Append:

```markdown
## Supersession table

Part 13 replaces the following sections of Parts 08 and 09. Old text stays for the history of the source-only ship path, mirroring how Part 12 supersedes Part 10.

| Superseded | Old normative content | v2 replacement |
|---|---|---|
| Part 08 §Setup wizard, Step 1: Focus | Focus, invariants, categories visible on default flow. | Section B: focus and invariants under Advanced; categories stay visible. |
| Part 08 §Setup wizard, Step 2: Plan | Linear list with all controls inline. | Section C: DAG view with per-node edit drawer. |
| Part 08 §Running view: layout | Left = header + summary + rail. Right = findings + coverage + report. | Section D: left = DAG + read-only stream. Right = wider findings + coverage + report. |
| Part 08 §Report as a user choice | Report cell writes markdown and JSON. | Section F: report cell also publishes an HTML artifact. Markdown and JSON downloads stay. |
| Part 09 §Launch checklist | Third wizard step is the Launch checklist. | Unchanged for launch semantics. Checklist gains a "focus and invariants under Advanced" line. |
| Part 08 flow D: Re-scan | Rescan seeds a new engagement and starts immediately. | Section G: rescan opens the DAG editor prefilled with the parent's plan. |
```

- [ ] **Step 10: Write the open-questions section**

Append:

```markdown
## Open questions

1. **CSP for HTML artifacts.** Does `GET /api/artifacts/:token` set a strict `Content-Security-Policy`? Verify in `packages/api/src/routes/artifacts.ts`. If not, Section F depends on that being added first.
2. **Status widen migration policy.** Rewrite existing `verified` rows to `verified_agree` at migration time, or keep them as `verified` and treat as-agree until touched? Recommendation: keep, do not rewrite.
3. **Keyboard remap.** `v` opens a `a`/`d` popover; confirm the popover auto-focus + `Enter`-to-commit contract.
4. **DAG library.** dagre vs elkjs. Recommend dagre for bundle size at `MAX_STEPS = 32`.
5. **Architecture-memory diagram render.** Mermaid inline (matches artifact-diagram idiom) or react-flow?
6. **Reasoning field size cap.** Recommend 2000 codepoints, matching the body practical size.
7. **Rescan behavior when the parent used `pivot-coordinator`.** Prefill the coordinator cell or start fresh from pre-pivot cells? Recommend prefill with a chip: `"Reruns pivot; parent's needs answers are NOT carried"`.
8. **Cell-level vs turn-level cross-link.** Cell-level ships now; turn-level is Part 14. Confirm the split.
```

- [ ] **Step 11: Prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/spec/13-ux-v2.md`
Expected: `check-prose: clean`. Replace any em dashes with commas or hyphens.

- [ ] **Step 12: Commit**

```bash
git add docs/specs/valet-security/spec/13-ux-v2.md
git commit -m "spec(security): add Part 13 UX v2 (normative)"
```

---

### Task B4: README update for Parts 11, 12, 13

**Files:**
- Modify: `docs/specs/valet-security/README.md`

**Interfaces:**
- Consumes: rewritten Parts 11, 12, and new Part 13
- Produces: updated reading order, updated conformance table, no Part 10 row

- [ ] **Step 1: Update the reading-order table**

Ensure the table lists Parts 00 through 09 unchanged, then Parts 11, 12, 13 with fresh summaries:

```markdown
| [Part 11: Runtime Execution (two-mode)](spec/11-runtime-execution.md) | v2 rewrite. `sec_verify_exec` (sandbox-side, default) wraps `valet-secrets` + `curl`; `sec_http_request` (api-side, opt-in) for private-network targets. Node hygiene section conditional on egress mode. |
| [Part 12: Credentials via 1Password](spec/12-credentials-via-1password.md) | v2 rewrite against landed `OnePasswordService` + `sandbox-secrets.ts` broker + `valet-secrets` CLI. Three scopes (org, personal, team), team-first. Per-engagement broker allowlist added on top of the landed broker. Tripwire seeded from broker resolves for a security cell. |
| [Part 13: UX v2](spec/13-ux-v2.md) | DAG plan editor, focus/invariants under Advanced, wider findings pane with a read-only activity stream, three-verdict findings with a human overlay that keeps the fingerprint stable, HTML report artifact, rescan v2, architecture memory on `/architecture.yml`. Supersession table for Parts 08/09 sections. |
```

- [ ] **Step 2: Update the conformance-level table**

Rewrite Level L1 through L4 rows so they name Part 12 v2's `INV-32 / INV-33 / INV-34` and Part 11 v2's two-mode invariants (`INV-30 / INV-31`). Part 13 does not add L0 kernel behavior; every gate is UI or route enforcement. Add:

```markdown
| L1 | ... | ... plus Part 12 v2 preflight (INV-32) and Part 11 v2 sandbox-side default (`sec_verify_exec`). |
| L3 | ... | ... plus Part 12 v2 broker allowlist (INV-33) and Part 11 v2 verify-cell header (INV-31). |
| L4 | ... | ... plus Part 12 v2 tripwire seam (INV-34) and Part 11 v2 wrapper-strip (INV-30). |
```

- [ ] **Step 3: Update the "Where each artifact lives" table**

Add a row: `Part 13 web-side changes | packages/web/src/routes/security.*, packages/web/src/components/security/*`.

- [ ] **Step 4: Update the Changelog block**

Append:

```markdown
`v1.1, 2026-09-12`: Part 10 dropped. Part 11 rewritten with a two-mode egress contract (sandbox-side default via `sec_verify_exec` + `valet-secrets`; api-side fallback via `sec_http_request`). Part 12 rewritten against landed 1Password subsystem (three scopes, six typed auth-error kinds, `isOnePasswordReference` as ref grammar authority, per-engagement broker allowlist added on top of the landed broker, tripwire seam through broker resolves for a security cell). New Part 13 (UX v2) added as normative spec covering DAG plan editor, three-verdict findings with human overlay, HTML report artifact, rescan v2, architecture memory, plus a supersession table for Parts 08 and 09.
```

- [ ] **Step 5: Prose lint**

Run: `python3 docs/specs/valet-security/scripts/check-prose.py docs/specs/valet-security/README.md`
Expected: `check-prose: clean`.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/valet-security/README.md
git commit -m "spec(security): README refresh for Parts 11/12/13"
```

---

## Phase C - Schema

### Task C1: Add credentials_json, credential_ref, CHECK, SCHEMA_REPAIRS

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql`
- Modify: `packages/api/src/schema/index.ts`
- Modify: `packages/api/src/lib/drizzle.ts` (add `SCHEMA_REPAIRS` entries)
- Test: `packages/api/src/services/security-seed.test.ts` (add a schema-reachable test if not present) and rely on integration tests that touch `security_engagements`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces:
  - `security_engagements.credentials_json JSONB NULL` populated with `SecurityConfigCredentialDecl[]` at seed time.
  - `security_needs.credential_ref TEXT NULL` populated when a `kind='credential'` need is answered.
  - CHECK constraint on `security_needs`: `kind <> 'credential' OR resolution IS NULL`.

- [ ] **Step 1: Edit `0000_app.sql` in place to add the columns and constraint**

Find the `CREATE TABLE security_engagements (` block. Add before the closing `);`:

```sql
credentials_json JSONB
```

Find the `CREATE TABLE security_needs (` block. Add before the closing `);`:

```sql
credential_ref TEXT,
CONSTRAINT security_needs_credential_resolution_null CHECK (kind <> 'credential' OR resolution IS NULL)
```

- [ ] **Step 2: Update the Drizzle schema in `packages/api/src/schema/index.ts`**

Find the `security_engagements` table def; add:

```ts
credentialsJson: jsonb("credentials_json"),
```

Find the `security_needs` table def; add:

```ts
credentialRef: text("credential_ref"),
```

Add a table-level `check` (Drizzle 0.30+ supports `check` in the table config array):

```ts
(t) => [
  index("security_needs_engagement").on(t.engagementId),
  check("security_needs_credential_resolution_null",
    sql`${t.kind} <> 'credential' OR ${t.resolution} IS NULL`),
]
```

Import `check` and `sql` from `drizzle-orm` and `drizzle-orm/pg-core` at the top of the file.

- [ ] **Step 3: Add SCHEMA_REPAIRS entries in `packages/api/src/lib/drizzle.ts`**

Append two entries to the `SCHEMA_REPAIRS` array:

```ts
{
  name: "security_engagements.credentials_json",
  probe: async (client) => {
    const r = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='security_engagements' AND column_name='credentials_json'`,
    );
    return r.rowCount === 0;
  },
  apply: async (client) => {
    await client.query(
      `ALTER TABLE security_engagements ADD COLUMN credentials_json JSONB`,
    );
  },
},
{
  name: "security_needs.credential_ref + CHECK",
  probe: async (client) => {
    const r = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='security_needs' AND column_name='credential_ref'`,
    );
    return r.rowCount === 0;
  },
  apply: async (client) => {
    await client.query(
      `ALTER TABLE security_needs ADD COLUMN credential_ref TEXT`,
    );
    await client.query(
      `ALTER TABLE security_needs ADD CONSTRAINT security_needs_credential_resolution_null
       CHECK (kind <> 'credential' OR resolution IS NULL)`,
    );
  },
},
```

- [ ] **Step 4: Wipe dev PGlite in this worktree**

Run: `make dev-clean`
Expected: `.valet-dev/pg` removed.

- [ ] **Step 5: Confirm the schema loads clean by running a targeted store test**

Run: `pnpm --filter @valet/store-postgres test`
Expected: green suite.

- [ ] **Step 6: Confirm the api schema imports cleanly**

Run: `pnpm --filter @valet/api typecheck`
Expected: no errors on the touched files.

- [ ] **Step 7: Commit**

```bash
git add packages/api/migrations/pg/0000_app.sql \
        packages/api/src/schema/index.ts \
        packages/api/src/lib/drizzle.ts
git commit -m "feat(security): credentials_json, credential_ref, CHECK"
```

---

## Phase D - Preflight and broker allowlist

### Task D1: Extend `seedSecurityReview` with preflight validator

**Files:**
- Modify: `packages/api/src/services/security-seed.ts`
- Modify: `packages/plugin-security/src/lib/config.ts` (add `SecurityConfigCredentialDecl` if it is not already on-branch from PR 523; the plan assumes we bring PR 523's `SecurityConfigCredentialDecl` in as-is here)
- Test: `packages/api/src/services/security-seed.test.ts`

**Interfaces:**
- Consumes: `SecurityConfig.credentials: SecurityConfigCredentialDecl[]` from plugin-security; `OnePasswordService.resolveReference` from `services/onepassword.ts`; `onePasswordScopesFor` from `credential-resolution.ts`.
- Produces:
  - `seedSecurityReview` refuses a seed when any declared ref fails resolve or fails a shape check, with a per-kind corrective error keyed on `OnePasswordAuthError.kind`.
  - The engagement row's `credentials_json` is populated with the (validated) declared refs list. No values.

- [ ] **Step 1: Write the failing test**

In `packages/api/src/services/security-seed.test.ts`, add:

```ts
import { describe, it, expect, vi } from "vitest";
import { seedSecurityReview } from "./security-seed";
import { OnePasswordAuthError } from "./onepassword";

describe("seedSecurityReview credential preflight", () => {
  const baseReq = {
    orgId: "org1", userId: "user1", sessionId: "sess1",
    repoFullName: "acme/app", ref: "main",
    securityConfig: {
      focus: null, invariants: [], categories: [],
      credentials: [
        { label: "admin", ref: "op://Sec/Admin/password", kind: "password" },
      ],
    },
  };

  it("refuses seed when the ref does not resolve (kind=reference)", async () => {
    const onePassword = {
      resolveReference: vi.fn().mockRejectedValue(
        new OnePasswordAuthError("reference", "not found"),
      ),
    };
    await expect(seedSecurityReview(baseReq, { onePassword } as any))
      .rejects.toMatchObject({
        message: expect.stringContaining("op://Sec/Admin/password"),
      });
  });

  it("succeeds and populates credentials_json when the ref resolves", async () => {
    const onePassword = {
      resolveReference: vi.fn().mockResolvedValue("value123"),
    };
    const result = await seedSecurityReview(baseReq, { onePassword } as any);
    expect(result.credentialsJson).toEqual([
      { label: "admin", ref: "op://Sec/Admin/password", kind: "password" },
    ]);
    // The value MUST NOT survive on the seed result.
    expect(JSON.stringify(result)).not.toContain("value123");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @valet/api test security-seed`
Expected: FAIL (no credentials preflight yet).

- [ ] **Step 3: Extend `seedSecurityReview` to preflight refs**

Open `packages/api/src/services/security-seed.ts`. After the config parse and before any DB write, add:

```ts
import { OnePasswordAuthError, isOnePasswordReference } from "./onepassword";
import { onePasswordScopesFor } from "./credential-resolution";

async function preflightCredentials(
  decls: SecurityConfigCredentialDecl[],
  ctx: { orgId: string; userId: string; teamId?: string },
  onePassword: { resolveReference: OnePasswordService["resolveReference"] },
): Promise<SecurityConfigCredentialDecl[]> {
  const scopes = onePasswordScopesFor(
    ctx.teamId ? "team" : "user",
    ctx.teamId,
  );
  const validated: SecurityConfigCredentialDecl[] = [];
  for (const decl of decls) {
    if (!isOnePasswordReference(decl.ref)) {
      throw new SecurityCredentialPreflightError(
        "grammar",
        `Reference "${decl.ref}" is not a valid op:// path. Format: op://vault/item/field or op://vault/item/section/field.`,
      );
    }
    let value: string | null = null;
    for (const scope of scopes) {
      try {
        value = await onePassword.resolveReference(scope, ctx, decl.ref);
        break;
      } catch (err) {
        if (err instanceof OnePasswordAuthError) {
          if (err.kind === "no_token") continue;
          throw correctiveError(err.kind, decl.ref);
        }
        throw err;
      }
    }
    if (value === null) {
      throw correctiveError("no_token", decl.ref);
    }
    shapeCheckByKind(decl.kind, value, decl.ref);
    value = "";
    validated.push({
      label: decl.label,
      ref: decl.ref,
      kind: decl.kind,
      ...(decl.refShape ? { refShape: decl.refShape } : {}),
    });
  }
  return validated;
}

function correctiveError(
  kind: OnePasswordAuthError["kind"],
  ref: string,
): SecurityCredentialPreflightError {
  switch (kind) {
    case "no_token":
      return new SecurityCredentialPreflightError(
        "no_token",
        `No 1Password token configured for any scope that could resolve "${ref}". Connect a team or org token in Organization > 1Password.`,
      );
    case "disabled":
      return new SecurityCredentialPreflightError(
        "disabled",
        `Personal vault scope is disabled by the org. Enable it in Organization > 1Password > Allow personal, or move "${ref}" to org or team.`,
      );
    case "scope":
      return new SecurityCredentialPreflightError(
        "scope",
        `The token in scope cannot see "${ref}". Move the item to a vault the token grants, or use a different scope.`,
      );
    case "reference":
      return new SecurityCredentialPreflightError(
        "reference",
        `The item "${ref}" does not exist or was renamed. Update the reference.`,
      );
    case "ambiguous":
      return new SecurityCredentialPreflightError(
        "ambiguous",
        `The reference "${ref}" matches more than one item. Add a section segment: op://vault/item/section/field.`,
      );
    case "sdk":
      return new SecurityCredentialPreflightError(
        "sdk",
        `1Password refused the resolve request for "${ref}". Rotate the token in Organization > 1Password.`,
      );
  }
}

function shapeCheckByKind(
  kind: SecurityConfigCredentialDecl["kind"],
  value: string,
  ref: string,
): void {
  if (kind === "password" && value.length === 0) {
    throw new SecurityCredentialPreflightError(
      "shape",
      `"${ref}" resolved to an empty password. Set the field in 1Password.`,
    );
  }
  // Add per-kind shape checks: session (Netscape cookies.txt header), headerToken (non-empty), mtls (BEGIN CERTIFICATE), etc.
}

export class SecurityCredentialPreflightError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = "SecurityCredentialPreflightError";
  }
}
```

Then, in the main `seedSecurityReview` body, before insertion:

```ts
const credentialsJson = req.securityConfig.credentials?.length
  ? await preflightCredentials(
      req.securityConfig.credentials,
      { orgId: req.orgId, userId: req.userId, teamId: req.teamId },
      deps.onePassword,
    )
  : null;
```

Pass `credentialsJson` into the `INSERT INTO security_engagements ...` values map.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @valet/api test security-seed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/security-seed.ts \
        packages/api/src/services/security-seed.test.ts \
        packages/plugin-security/src/lib/config.ts
git commit -m "feat(security): preflight validator for op:// credentials"
```

---

### Task D2: Broker per-engagement allowlist in `sandbox-secrets.ts`

**Files:**
- Modify: `packages/api/src/routes/sandbox-secrets.ts`
- Test: `packages/api/src/routes/sandbox-secrets.test.ts` (add allowlist cases; the file may not exist on dev-v2, in which case create it)

**Interfaces:**
- Consumes: `security_engagements.credentials_json`, session-owning-cell detection via `security_cells`.
- Produces: allowlist gate that runs BEFORE `resolveReference` when the sandbox session owns a security cell; every other caller path bypasses.

- [ ] **Step 1: Write the failing tests**

Add or create `packages/api/src/routes/sandbox-secrets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTestApp } from "../test-support/build-test-app";

describe("POST /api/sandbox-secrets/resolve allowlist", () => {
  it("allows a ref that is on the engagement's declared list", async () => {
    const app = await buildTestApp();
    await app.seedEngagement({
      id: "e1",
      credentialsJson: [{ label: "admin", ref: "op://Sec/Admin/password", kind: "password" }],
      cells: [{ id: "c1" }],
      sessionId: "s1",
    });
    const res = await app.request("/api/sandbox-secrets/resolve", {
      method: "POST",
      headers: { "x-valet-sandbox": app.mintSandboxToken("s1") },
      body: JSON.stringify({ references: ["op://Sec/Admin/password"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values[0]).toBeTypeOf("string");
  });

  it("refuses a ref not on the engagement's list", async () => {
    const app = await buildTestApp();
    await app.seedEngagement({
      id: "e2",
      credentialsJson: [{ label: "admin", ref: "op://Sec/Admin/password", kind: "password" }],
      cells: [{ id: "c2" }],
      sessionId: "s2",
    });
    const res = await app.request("/api/sandbox-secrets/resolve", {
      method: "POST",
      headers: { "x-valet-sandbox": app.mintSandboxToken("s2") },
      body: JSON.stringify({ references: ["op://Other/Item/pw"] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain("op://Other/Item/pw");
  });

  it("bypasses allowlist for a non-security session", async () => {
    const app = await buildTestApp();
    await app.seedCodingSession({ sessionId: "s3" });
    const res = await app.request("/api/sandbox-secrets/resolve", {
      method: "POST",
      headers: { "x-valet-sandbox": app.mintSandboxToken("s3") },
      body: JSON.stringify({ references: ["op://Any/Any/pw"] }),
    });
    // Not 403; the allowlist did not fire. The request either 200s or 400s on scope, never 403 for allowlist.
    expect(res.status).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @valet/api test sandbox-secrets`
Expected: FAIL (allowlist not implemented).

- [ ] **Step 3: Add the allowlist branch in the route**

Open `packages/api/src/routes/sandbox-secrets.ts`. Find the `POST /resolve` handler, immediately BEFORE the `resolveReference` parallel call. Add:

```ts
// Per-engagement allowlist for security sessions.
// Every other caller path bypasses this branch.
const engagementId = await findSecurityEngagementForSession(
  deps.db, c.var.sandbox.sessionId,
);
if (engagementId !== null) {
  const allowlist = await loadEngagementCredentialRefs(
    deps.db, engagementId,
  );
  const disallowed = references.filter((ref) => !allowlist.has(ref));
  if (disallowed.length > 0) {
    return c.json(
      {
        code: "credential_ref_not_allowlisted",
        message: `The following op:// references are not declared on this engagement: ${disallowed.join(", ")}.`,
      },
      403,
    );
  }
}
```

And add the helpers in the same file (or in a small `packages/api/src/services/security-broker-allowlist.ts`):

```ts
async function findSecurityEngagementForSession(
  db: DbClient, sessionId: string,
): Promise<string | null> {
  const rows = await db.execute<{ engagement_id: string }>(sql`
    SELECT DISTINCT sc.engagement_id
    FROM security_cells sc
    JOIN security_engagements se ON se.id = sc.engagement_id
    WHERE se.session_id = ${sessionId}
    LIMIT 1
  `);
  return rows.rows[0]?.engagement_id ?? null;
}

async function loadEngagementCredentialRefs(
  db: DbClient, engagementId: string,
): Promise<Set<string>> {
  const row = await db.execute<{ credentials_json: unknown }>(sql`
    SELECT credentials_json FROM security_engagements WHERE id = ${engagementId}
  `);
  const decls = (row.rows[0]?.credentials_json ?? []) as Array<{ ref: string }>;
  return new Set(decls.map((d) => d.ref));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @valet/api test sandbox-secrets`
Expected: PASS (all three cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/sandbox-secrets.ts \
        packages/api/src/routes/sandbox-secrets.test.ts
git commit -m "feat(security): broker per-engagement allowlist"
```

---

### Task D3: Register the ref set at engagement start (no-op safety)

**Files:**
- Modify: `packages/api/src/services/security-engagements.ts`

**Interfaces:**
- Consumes: `credentialsJson` on the engagement row (already written by seedSecurityReview in D1)
- Produces: An explicit log line at engagement start naming the allowlist size, so the audit trail is visible. The broker itself reads `credentials_json` directly (D2), so "registration" is metadata + observability, not a mutable in-memory registry.

- [ ] **Step 1: Add the observability seam at `sec_start`**

In `security-engagements.ts`, find the `sec_start` (or the equivalent function that transitions an engagement to `running`). Add:

```ts
const allowlistSize = (engagement.credentialsJson ?? []).length;
logger.info({
  event: "security.engagement.allowlist_active",
  engagementId: engagement.id,
  allowlistSize,
}, `Security allowlist active with ${allowlistSize} refs`);
```

- [ ] **Step 2: Add a metric to `packages/api/src/observability/security-metrics.ts`**

```ts
export const securityAllowlistSize = new Histogram({
  name: "security_allowlist_size",
  help: "Declared op:// refs per engagement at start",
  buckets: [0, 1, 2, 5, 10, 20],
});
```

Emit it next to the log line: `securityAllowlistSize.observe(allowlistSize)`.

- [ ] **Step 3: Confirm typecheck clean**

Run: `pnpm --filter @valet/api typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/security-engagements.ts \
        packages/api/src/observability/security-metrics.ts
git commit -m "feat(security): observability for engagement allowlist start"
```

---

## Phase E - Dispatch prompt renderer

### Task E1: `buildDispatchPrompt` Credentials section

**Files:**
- Modify: `packages/api/src/services/security-engagements.ts` (`buildDispatchPrompt`)
- Test: `packages/api/src/services/security-engagements.test.ts` (snapshot on rendered prompt)

**Interfaces:**
- Consumes: `engagement.credentialsJson` (from Phase C schema + Phase D1 preflight).
- Produces: An added `## Credentials` section in the dispatch prompt listing each declared credential label plus the `valet-secrets run --env NAME=op://... -- cmd` template. The op:// value is present in the prompt because the persona must know the ref to run the CLI; the resolved VALUE is not.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildDispatchPrompt } from "./security-engagements";

describe("buildDispatchPrompt credentials", () => {
  it("renders each credential as a valet-secrets template", () => {
    const prompt = buildDispatchPrompt({
      engagement: {
        credentialsJson: [
          { label: "admin", ref: "op://Sec/Admin/password", kind: "password" },
          { label: "sess", ref: "op://Sec/Session/cookies", kind: "session" },
        ],
        focus: null, invariants: [], categories: [], authorizedScope: null,
      } as any,
      cell: { persona: "dast", goal: "sweep admin surface" } as any,
      answeredNeeds: [],
    });
    expect(prompt).toContain("## Credentials");
    expect(prompt).toContain("admin");
    expect(prompt).toContain("op://Sec/Admin/password");
    expect(prompt).toContain("valet-secrets run --env ADMIN=op://Sec/Admin/password --");
    expect(prompt).toContain("sess");
  });

  it("omits the section when no credentials are declared", () => {
    const prompt = buildDispatchPrompt({
      engagement: {
        credentialsJson: null, focus: null, invariants: [], categories: [],
        authorizedScope: null,
      } as any,
      cell: { persona: "dast", goal: "sweep admin surface" } as any,
      answeredNeeds: [],
    });
    expect(prompt).not.toContain("## Credentials");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @valet/api test security-engagements -t "buildDispatchPrompt credentials"`
Expected: FAIL.

- [ ] **Step 3: Add the section renderer in `buildDispatchPrompt`**

```ts
function renderCredentialsSection(
  decls: SecurityConfigCredentialDecl[] | null,
): string {
  if (!decls || decls.length === 0) return "";
  const rows = decls.map((d) => {
    const envName = d.label.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return `- **${d.label}** (kind: ${d.kind}): \`valet-secrets run --env ${envName}=${d.ref} -- <your-command>\``;
  }).join("\n");
  return [
    "## Credentials",
    "",
    "The following credentials are declared for this engagement. The RESOLVED value is delivered only to the child shell you exec through `valet-secrets run`. You never see the value; the child does.",
    "",
    rows,
    "",
    "Do NOT log, echo, or persist the resolved value. The broker refuses any op:// reference not in this list.",
    "",
  ].join("\n");
}
```

Wire into the prompt assembly in `buildDispatchPrompt`, after the invariants section and before the answered-needs section.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @valet/api test security-engagements -t "buildDispatchPrompt credentials"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/security-engagements.ts \
        packages/api/src/services/security-engagements.test.ts
git commit -m "feat(security): dispatch prompt Credentials section"
```

---

## Phase F - Wizard and needs widget

### Task F1: Credentials sub-section in `config-form.tsx` under Advanced

**Files:**
- Modify: `packages/web/src/components/security/config-form.tsx`
- Test: `packages/web/src/components/security/config-form.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (UI-only).
- Produces: Adds `credentials: CredentialDraft[]` to `ConfigDraft`; renders an Advanced disclosure containing (a) focus, (b) invariants, (c) credentials. Each credential row: label input, op:// ref input (validated by `isOnePasswordReference` client-side mirror), kind dropdown, optional `refShape` toggle for `toolAuth`.

- [ ] **Step 1: Write the failing test**

Add to `config-form.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigForm, emptyConfigDraft } from "./config-form";

describe("ConfigForm credentials (Advanced)", () => {
  it("hides credentials by default under Advanced", () => {
    render(<ConfigForm value={emptyConfigDraft()} onChange={() => {}} />);
    expect(screen.queryByLabelText(/op:\/\/ reference/i)).toBeNull();
  });

  it("shows credentials after opening Advanced", async () => {
    render(<ConfigForm value={emptyConfigDraft()} onChange={() => {}} />);
    fireEvent.click(screen.getByText(/Advanced/i));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    expect(screen.getByLabelText(/label/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/op:\/\/ reference/i)).toBeInTheDocument();
  });

  it("rejects an invalid op:// reference client-side", async () => {
    let value = emptyConfigDraft();
    const onChange = (v: typeof value) => { value = v; };
    render(<ConfigForm value={value} onChange={onChange} />);
    fireEvent.click(screen.getByText(/Advanced/i));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText(/op:\/\/ reference/i),
      { target: { value: "not-a-ref" } });
    expect(screen.getByText(/must start with op:\/\//i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @valet/web test config-form`
Expected: FAIL.

- [ ] **Step 3: Extend `ConfigDraft` and render Advanced**

Add to `config-form.tsx`:

```tsx
export interface CredentialDraft {
  label: string;
  ref: string;
  kind: "password" | "session" | "headerToken" | "mtls" | "signingKey" | "testDataFile" | "toolAuth";
  refShape?: "raw" | "json";
}

export interface ConfigDraft {
  focus: string;
  invariants: string[];
  categories: string[];
  scope: ScopeDraft;
  credentials: CredentialDraft[];  // new
}

export function emptyConfigDraft(): ConfigDraft {
  return { focus: "", invariants: [], categories: [], scope: emptyScopeDraft(), credentials: [] };
}

// Mirror the OP_REFERENCE regex from packages/api/src/services/onepassword.ts.
// Ships as its own const to be diagnostic only; the server is authoritative.
export const OP_REFERENCE_MIRROR = /^op:\/\/[^/ -]+\/[^/ -]+(?:\/[^/ -]+){1,2}$/;
```

Add the Advanced section (a `<details>` element or Radix `Collapsible`) to the rendered JSX. Move the existing `focus` textarea and `invariants` list under it. Add a Credentials sub-section with a table of `CredentialDraft` rows and an "Add credential" button.

Each row renders: label input, op:// ref input (with client-side validation error on `OP_REFERENCE_MIRROR` mismatch), kind dropdown, `refShape` toggle visible only when `kind === "toolAuth"`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @valet/web test config-form`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/security/config-form.tsx \
        packages/web/src/components/security/config-form.test.tsx
git commit -m "feat(security-web): credentials in ConfigForm under Advanced"
```

---

### Task F2: Thread `credentials` through `security.new.tsx` to `POST /api/sessions`

**Files:**
- Modify: `packages/web/src/routes/security.new.tsx`
- Modify: `packages/api/src/wire/types.ts` (extend `CreateSessionRequest.securityConfig` with `credentials?: SecurityConfigCredentialDeclWire[]`)
- Modify: `packages/api/src/routes/sessions.ts` (or wherever `POST /api/sessions` normalizes `securityConfig`)
- Test: `packages/web/src/routes/-security-new.test.tsx`

**Interfaces:**
- Consumes: `ConfigDraft.credentials` from F1.
- Produces: `securityConfig.credentials` on the wire and end-to-end into the API create path.

- [ ] **Step 1: Add the wire type**

In `packages/api/src/wire/types.ts`, add:

```ts
export interface SecurityConfigCredentialDeclWire {
  label: string;
  ref: string;
  kind: "password" | "session" | "headerToken" | "mtls" | "signingKey" | "testDataFile" | "toolAuth";
  refShape?: "raw" | "json";
}
```

Extend the `securityConfig` block on `CreateSessionRequest`:

```ts
securityConfig?: {
  focus: string | null;
  invariants: string[];
  categories: string[];
  scope?: SecurityScopeWire | null;
  credentials?: SecurityConfigCredentialDeclWire[];  // new
};
```

- [ ] **Step 2: Thread from the wizard to the create call**

In `security.new.tsx::startReview`, add:

```ts
if (config.credentials.length > 0) {
  securityConfig.credentials = config.credentials.map((c) => ({
    label: c.label.trim(),
    ref: c.ref.trim(),
    kind: c.kind,
    ...(c.refShape ? { refShape: c.refShape } : {}),
  }));
}
```

Also normalize on the API side wherever `req.securityConfig` is consumed on create; pass through into `seedSecurityReview` (Task D1).

- [ ] **Step 3: Add a route test that credentials round-trip**

In `-security-new.test.tsx`, assert the wizard's "Start review" posts credentials in the request body when Advanced was opened and rows were added.

- [ ] **Step 4: Run typecheck and the tests**

Run: `pnpm typecheck && pnpm --filter @valet/web test -t "-security-new"`
Expected: clean and green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/security.new.tsx \
        packages/api/src/wire/types.ts \
        packages/api/src/routes/sessions.ts \
        packages/web/src/routes/-security-new.test.tsx
git commit -m "feat(security-web): thread credentials from wizard to create"
```

---

### Task F3: Rewrite `needs-section.tsx` for `kind: 'credential'` needs

**Files:**
- Modify: `packages/web/src/components/security/needs-section.tsx`
- Modify: `packages/web/src/api/security.ts` (extend the resolve-need mutation shape)
- Modify: `packages/api/src/routes/security.ts` (or the specific resolve-needs endpoint) to accept the structured payload and populate `security_needs.credential_ref`
- Test: `packages/web/src/components/security/needs-section.test.tsx`

**Interfaces:**
- Consumes: `security_needs.kind === "credential"`; the new `credential_ref` column (Task C1).
- Produces: A structured widget that posts `{ needId, ref, label, refShape? }`; the API stores `credential_ref` and marks the need `answered`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NeedsSection } from "./needs-section";

describe("NeedsSection kind:credential", () => {
  const need = {
    id: "n1", kind: "credential", status: "needs_human",
    description: "Admin password", cellId: "c1",
  };

  it("renders a structured op:// input, not a Textarea", () => {
    render(<NeedsSection needs={[need]} onResolve={vi.fn()} />);
    expect(screen.getByLabelText(/op:\/\/ reference/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /answer/i })).toBeNull();
  });

  it("refuses submit when the ref does not match op:// grammar", () => {
    const onResolve = vi.fn();
    render(<NeedsSection needs={[need]} onResolve={onResolve} />);
    fireEvent.change(screen.getByLabelText(/op:\/\/ reference/i),
      { target: { value: "not-a-ref" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("submits { needId, ref, label } when the ref is valid", () => {
    const onResolve = vi.fn();
    render(<NeedsSection needs={[need]} onResolve={onResolve} />);
    fireEvent.change(screen.getByLabelText(/op:\/\/ reference/i),
      { target: { value: "op://Sec/Admin/password" } });
    fireEvent.change(screen.getByLabelText(/label/i),
      { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onResolve).toHaveBeenCalledWith({
      needId: "n1",
      ref: "op://Sec/Admin/password",
      label: "admin",
    });
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `pnpm --filter @valet/web test needs-section`
Expected: FAIL.

- [ ] **Step 3: Replace the credential branch in `NeedsSection`**

In `needs-section.tsx`, add a branch:

```tsx
if (need.kind === "credential") {
  return <CredentialNeedRow need={need} onResolve={onResolve} />;
}
```

Implement `CredentialNeedRow` with: label input, op:// ref input (validated with the OP_REFERENCE_MIRROR from F1's exported const), optional `refShape` toggle, Submit button. On submit, call `onResolve({ needId, ref, label, refShape? })`.

- [ ] **Step 4: Extend the API resolve-needs endpoint to accept structured payloads for credential kinds**

In `packages/api/src/routes/security.ts`, the resolve-needs handler branches on `kind`. For `credential`, write `credential_ref` (not `resolution`), leave `resolution` NULL (the CHECK from Task C1 enforces this), and add the ref to the engagement's `credentials_json` if not already present. Advance the need status to `answered`.

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm --filter @valet/web test needs-section && pnpm --filter @valet/api test -t "resolve-needs credential"`
Expected: clean and green.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/security/needs-section.tsx \
        packages/web/src/components/security/needs-section.test.tsx \
        packages/web/src/api/security.ts \
        packages/api/src/routes/security.ts
git commit -m "feat(security-web): structured op:// widget for credential needs"
```

---

## Phase G - Tests

### Task G1: Broaden preflight unit tests to cover every auth-error kind

**Files:**
- Modify: `packages/api/src/services/security-seed.test.ts`

**Interfaces:**
- Consumes: `preflightCredentials` (Task D1).
- Produces: One case per `OnePasswordAuthError.kind` value.

- [ ] **Step 1: Add the five remaining cases**

Extend the test file with one `it` per kind: `no_token`, `disabled`, `sdk`, `scope`, `ambiguous`. Each case sets up `OnePasswordService.resolveReference` to throw with that kind and asserts the thrown `SecurityCredentialPreflightError.message` matches the corrective wording.

Also add a shape-check case per kind: password (empty rejected), session (non-Netscape header rejected), headerToken (empty rejected), mtls (missing `-----BEGIN CERTIFICATE-----` rejected), signingKey (missing algo prefix rejected). testDataFile and toolAuth accept anything.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @valet/api test security-seed`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/services/security-seed.test.ts
git commit -m "test(security): cover every preflight auth-error kind"
```

---

### Task G2: Broker allowlist edge cases

**Files:**
- Modify: `packages/api/src/routes/sandbox-secrets.test.ts`

**Interfaces:**
- Consumes: allowlist branch from D2.
- Produces: cases for empty allowlist (rejects everything), 25-ref boundary (allowed if all on list), mixed allowed/disallowed (rejects with every bad ref named), non-security session bypass.

- [ ] **Step 1: Add the four cases**

```ts
it("with an empty allowlist, refuses every ref", async () => {
  const app = await buildTestApp();
  await app.seedEngagement({ id: "e", credentialsJson: [], cells: [{ id: "c" }], sessionId: "s" });
  const res = await app.request("/api/sandbox-secrets/resolve", {
    method: "POST",
    headers: { "x-valet-sandbox": app.mintSandboxToken("s") },
    body: JSON.stringify({ references: ["op://A/B/c"] }),
  });
  expect(res.status).toBe(403);
});

it("with a 25-ref request all on the allowlist, allows the batch", async () => {
  // ...construct 25 refs, seed allowlist, expect 200
});

it("with a mixed request, names every disallowed ref in the 403 body", async () => {
  // ...seed one allowed, request three where two are disallowed, expect 403 and both names in the message
});

it("with a coding session (no security cell), allowlist is bypassed", async () => {
  // already covered in D2, keep as regression
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @valet/api test sandbox-secrets`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/sandbox-secrets.test.ts
git commit -m "test(security): broker allowlist edge cases"
```

---

### Task G3: Dispatch prompt snapshot for Credentials section

**Files:**
- Modify: `packages/api/src/services/security-engagements.test.ts`

**Interfaces:**
- Consumes: `buildDispatchPrompt` (Task E1).
- Produces: snapshot that pins the section header, the row shape, and the "no value in the prompt" invariant.

- [ ] **Step 1: Add a snapshot test**

```ts
it("Credentials section snapshot", () => {
  const prompt = buildDispatchPrompt({
    engagement: {
      credentialsJson: [
        { label: "admin", ref: "op://Sec/Admin/password", kind: "password" },
        { label: "sess", ref: "op://Sec/Session/cookies.txt", kind: "session" },
        { label: "gh", ref: "op://Sec/GH/token", kind: "toolAuth", refShape: "raw" },
      ],
      focus: null, invariants: [], categories: [], authorizedScope: null,
    } as any,
    cell: { persona: "dast", goal: "sweep" } as any,
    answeredNeeds: [],
  });
  const section = prompt.slice(prompt.indexOf("## Credentials"));
  expect(section).toMatchInlineSnapshot(/* ... */);
});
```

Run once, review the snapshot, commit.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @valet/api test security-engagements -t "Credentials section snapshot" -u`
Expected: snapshot writes on first run; green.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/services/security-engagements.test.ts
git commit -m "test(security): snapshot the Credentials prompt section"
```

---

### Task G4: Web component tests round-out

**Files:**
- Modify: `packages/web/src/components/security/config-form.test.tsx`
- Modify: `packages/web/src/components/security/needs-section.test.tsx`

**Interfaces:**
- Consumes: F1 and F3 components.
- Produces: cases for Advanced disclosure state persistence, `refShape` visibility gated on `kind === "toolAuth"`, credential removal, needs-section credential submit shape.

- [ ] **Step 1: Add the visibility + removal + persistence cases**

For `config-form.test.tsx`:

```tsx
it("refShape toggle visible only for kind=toolAuth", () => { /* ... */ });
it("removes a credential row on click of remove button", () => { /* ... */ });
```

For `needs-section.test.tsx`:

```tsx
it("submits refShape when kind=toolAuth and the user picked json", () => { /* ... */ });
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @valet/web test -- config-form needs-section`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/security/config-form.test.tsx \
        packages/web/src/components/security/needs-section.test.tsx
git commit -m "test(security-web): credential UI edge cases"
```

---

## Self-review checklist (run after writing this plan; before user sign-off)

**1. Spec coverage.** Every user directive maps to a task:

- Drop Part 10: Task A1.
- Rewrite Part 12 against dev-v2: Task B1.
- Rewrite Part 11 against dev-v2: Task B2.
- Add new Part 13 (UX v2): Task B3.
- Include #552 plan doc: Task A2.
- Preflight validator: Task D1.
- Broker allowlist wiring: Task D2 (+ D3 observability).
- Schema (credentials_json / credential_ref / CHECK): Task C1.
- Dispatch prompt renderer: Task E1.
- Wizard + needs widget rewrites: Tasks F1, F2, F3.

**2. Placeholder scan.** No "TBD", no "similar to task N", no "add appropriate handling". Every code block is compilable-shaped. Prose commits have concrete section names.

**3. Type consistency.** `SecurityConfigCredentialDecl` (server) and `CredentialDraft` (web) share the `label`, `ref`, `kind`, `refShape?` shape. `SecurityConfigCredentialDeclWire` is the wire mirror. `OP_REFERENCE_MIRROR` on the web side is diagnostic; `isOnePasswordReference` on the server is authoritative. `credentialsJson` on rows is `SecurityConfigCredentialDecl[]`; `credentialRef` on `security_needs` is a single string.

**4. Cross-task references.** D2 uses `security_engagements.credentials_json` written by D1. E1 reads it. F3's need-resolve writes the credential column on `security_needs`.

---

## Handoff

Plan complete and saved to `docs/plans/2026-09-12-security-v2-rewrite-plan.md`.

**Execution options:**

1. **Subagent-Driven (recommended)**: dispatch a fresh subagent per task, review between tasks. Best fit for a plan this long.
2. **Inline Execution**: execute in this session using `superpowers:executing-plans` with checkpoints per phase.

Get user sign-off on the plan before starting either.
