# Part 08: User Experience and Web Flow

*Depends on: Part 00, Part 01, Part 03, Part 04, Part 05. Conformance: L1+ (server-side surfaces stay usable at every level from L1 up).*

## Purpose

This part fixes the end-to-end flow a human follows to launch, monitor, resolve, and read a security engagement in the Valet web client. The base design (`docs/specs/2026-08-27-valet-security-design.md`) fixed the runtime substrate (`security_engagements`, `security_cells`, `security_files`, `sec_*` tools) and the persona catalog grew persona by persona: `code-review`, then the architect/verifier triad (M-P2b), then `threat-model`/`sast`/`attack-tree` (M-P2c), then coverage honesty (M-P2d), then `report` (M-P3), then the live personas `dast`/`fuzz`/`exploit` (M-P4b), then `reconcile` (re-scan v2), then the flat needs loop (M-P4c). The web UI followed the source-only path faithfully but never caught up to the live-persona milestones. The v1 spec added `pivot-coordinator` and the delta-re-run contract on top of that.

The consequence: today a user cannot launch dast/fuzz/exploit from the web UI. Every LIVE persona sits behind a manually authored `.valet/security.yml` in the target repo. The `pivot-coordinator` persona ships as role markdown but is not bundled. The plan editor's persona dropdown mirrors six of the eleven bundled personas. The report cell does not distinguish pass-1 findings from delta findings.

This part pins the intended flow so future increments land in one shape. It also names the concrete UI slices that ship in this PR versus follow-up PRs.

## Vocabulary

**Hub.** The `/security` index (`packages/web/src/routes/security.index.tsx`). The user's landing page: pick repo, pick method, click **Configure review →**.

**Method.** A preset id (see Part 01 §Presets). Every method describes a shape of engagement: how many phases, which personas per phase, source-only vs live, has a report cell or not.

**Setup.** The `/security/new` route. A three-step wizard: **Focus → Plan → Review**. Owns the `ConfigDraft` (focus, invariants, categories, live-scope) and the `StepDraft[]` (plan cells). Posts one `POST /api/sessions` on submit.

**Running.** The `/sessions/$sessionId` route when the session `kind === 'security'`. Renders `SecuritySessionLayout` from `packages/web/src/components/security/engagement-panel.tsx`.

**Live persona.** A persona in `LIVE_PERSONAS = {dast, fuzz, exploit}`. Every live persona MUST have a non-empty `authorized_scope.hosts` in the engagement config; the runtime egress gate refuses otherwise.

**Live-required plan.** A plan whose `cells[]` names any persona in `LIVE_PERSONAS`. The setup wizard MUST show the scope form and MUST refuse a submit whose scope has zero hosts.

**Pivot round.** One `pivot-coordinator` cell plus zero or more delta re-run cells that follow it (Part 05). A running engagement may go through 0..K pivot rounds; v1 pins K = 1 (Appendix C §C.1).

**Consolidated ask.** The single human-facing card the pivot-coordinator writes to `human_setup_ask.md`. The web renders it as ONE card grouping every open need in the current round, replacing the row-per-need flat surface that ships today.

## Report as a user choice, not preset-baked

v0 baked a `report` cell into three presets (`code-review`, `code-audit`, `live-pentest`) and omitted it from two (`secrets-config`, `access-injection`). v1 lifts the choice out of the preset: every preset can end in a report iff the user asked.

**Hub.** The "Start a review" card renders one checkbox: **Include a written report at the end** (default ON). The state rides on `SecurityNewSearch.includeReport`.

**Preset defaults.** `presetReportDefault(id)` returns `true` for `code-review`, `code-audit`, `live-pentest`, and `code-audit-plus-live`; `false` for `secrets-config` and `access-injection`. The default fires only when the caller passes no explicit `includeReport`; when the hub sends one (the common case), the server honors it.

**Preview.** `POST /security/preview` accepts `includeReport`. When set AND the repo has no `.valet/security.yml` steps, the seeded preset plan appends or skips the `report` cell to match. When the repo config declares its own steps, that plan wins and `includeReport` is informative.

**Create.** `POST /api/sessions` accepts `includeReport`. When `planCells` is present (the setup page always sends it), the edited plan is authoritative and `includeReport` is audit-only. When `planCells` is absent (a legacy caller), the create-time preset plan honors `includeReport`.

**Live flows.** `code-audit-plus-live` and `live-pentest` default the checkbox on; the user MAY uncheck to skip.

## The four flows

Every user journey is one of four flows. The web area supports all four; the difference lands in what the setup wizard, the running view, and the report show.

### Flow A: Source-only review

The default. Every persona in the plan reads source only: `threat-model`, `code-review`, `sast`, `attack-tree`, `architect`, `verifier`, `report`. No `authorized_scope` required. No pivot round. No delta cells.

1. Hub. Pick repo, pick preset (`code-review`, `secrets-config`, `access-injection`, `code-audit`). Click **Configure review →**.
2. Setup. **Focus** step: pick model, optional focus paragraph, invariants, threat categories. **Plan** step: the preview seeds the cells; the user edits (persona, name, goal, playbook, paths, reads, triad). **Review** step: read-only summary. Click **Start review**.
3. Running. Cell rail streams live. Findings appear grouped by fingerprint. Coverage ledger shows assessed vs NOT_ASSESSED. The user reviews findings (verify / refute / comment), files issues to GitHub or Linear.
4. Terminal. `ManifestCard` shows distinct-finding counts by severity and status. `ReportSection` shows the markdown report and offers `.md`/`.json` downloads. `ExportDialog` offers Markdown / SARIF / JSON.
5. Re-scan. From the hub row's **Re-scan** button, or from the manifest. A new engagement seeds `rescanOf: <parent id>`, materializes recon → reconcile → the base preset's sweeps → verify → report.

### Flow B: Live pentest (no pivot)

The user runs live personas against a declared authorized scope. No dispatch of `pivot-coordinator`; no delta cells. Every finding rides on the first pass.

1. Hub. Pick repo, pick the `live-pentest` preset. Click **Configure review →**.
2. Setup. **Focus** step now surfaces an **Authorized scope** section, REQUIRED:
    - `hosts` (multi-input, at least one).
    - `cidrs` (optional multi-input).
    - `login_url` (optional).
    - `signup_url` (optional; only used at L4 for `create-test-account`).
    - `rate_limit_rps` (optional; personas fall to a low default when absent).
    Submit is disabled while the plan carries any `LIVE_PERSONAS` and `hosts` is empty.
3. **Plan** step: the `live-pentest` preset seeds cells: recon → threat-model → dast (triad) → fuzz (triad) → exploit → verify → report. The persona dropdown lists every bundled persona plus `pivot-coordinator`, grouped by kind (see §Persona kinds).
4. **Review** step: read-only summary now includes the scope. Click **Start review**.
5. Running. Same rail as flow A. `LiveTestingPanel` renders under `ReviewSummary` and shows the declared scope.
6. Terminal. Same as flow A.

### Flow C: Live pentest with one pivot round

The user runs live personas AND wants the coordinator to auto-resolve blockers (scope expansion, session propagation) and consolidate the rest into one human ask. This is the v1 flagship flow.

1. Hub. Pick repo, pick the `live-pentest-plus-pivot` preset (v1 land-item; adds a `pivot-coordinator` cell after the live phase).
2. Setup. Same as flow B but the plan includes a `pivot-coordinator` cell after the live phase, and any live persona is marked as a triad's worker so its architect/verifier still run.
3. Running. Same as flow B until any live cell writes to `/needs/<NN>-<slug>.yml`. Then the runner dispatches the `pivot-coordinator` cell (its `reads` array names every live cell that surfaced needs). The coordinator classifies, executes L3 auto-catalog patterns (`scope-auto-include`, `propagate-session`, `rerun-with-existing-loot`), then either settles `done` (every need auto-resolved) or yields with a consolidated human ask.
4. **Consolidated ask card**. When the coordinator yields, the panel shows a new PivotRoundCard above `StepsPanel`. It groups every open need in the current round:
    - `auto_resolved` needs: green pill + resolution note (from `auto-setups.log`).
    - `human` needs: yellow section per need with a structured form. For `credential`/`session`: username + password (or a "paste session cookie" mode). For `test-data`: kind-specific fields (`payment-card`: number/cvv/expiry; `ssn`; `test-file`: base64 upload). For `scope-expansion`: an approve/reject toggle. For `tool-auth`: tool name + auth blob.
    - A single **Resolve pivot round** submit posts the whole card in one call to `POST /api/sessions/:id/security/pivot-response`. Empty responses are rejected client-side.
5. On resolve, the coordinator applies the answers via `sec_loot_write`, computes `delta_targets`, writes `/pivot.yml`, and settles. The runner materializes delta cells (`mode: post-pivot-delta`, `reads: [<original ordinal>]`) and dispatches them.
6. Delta cells stream in the rail with a `delta` chip and their `reads` reference to the original run. Findings emitted by delta cells cite `traces_to.pivot_need` and render with a "delta" pill on the finding card.
7. Terminal. `ManifestCard` distinguishes pass-1 vs delta findings by severity. `ReportSection` renders a "Pivot round: N auto, M human" one-liner and lists delta findings under their citing need.

### Flow D: Re-scan (with or without live)

A re-scan seeds a new engagement from a parent. Recon runs, then `reconcile` re-checks every carried finding, then the base preset's sweeps run on the diff surface only, then verify, then report.

1. Hub. From a terminal row, click **Re-scan**.
2. A new session materializes with `rescanOf: <parent id>`. Scope + config carry over.
3. Running. `RescanDiffBanner` shows "N new · N recurring · N fixed" once reconcile settles.
4. Terminal. Same as parent.

## Persona kinds

The plan editor's persona dropdown groups the twelve bundled personas by kind so a user reading top-to-bottom sees the shape of a pentest at a glance.

| Group | Personas | Rules |
|---|---|---|
| Source-only | `code-review`, `sast`, `threat-model`, `attack-tree` | Reads the clone. No scope required. |
| Live | `dast`, `fuzz`, `exploit` | Runs against `authorized_scope.hosts`. Setup wizard blocks submit if scope is empty. |
| Coordination | `architect`, `verifier`, `pivot-coordinator` | Attached by other cells' plans; not authored end-user-first in most flows. |
| Deliverable | `report`, `reconcile` | Terminal / carry-over cells. |

The dropdown renders each group under an `<optgroup label="...">`.

## Deterministic persona chip

A persona whose primary output is a scanner sweep or a pure L0 decision produces byte-identical results on identical inputs. The plugin's `BUNDLED_PERSONAS[i].deterministic` flag marks four such personas:

- `sast` (scanner-driven: semgrep, gitleaks, bandit, gosec, ...).
- `dast` (scanner-driven: nmap, nuclei, ffuf, ...).
- `fuzz` (scanner-driven within a seed: ffuf, sqlmap, restler, ...).
- `pivot-coordinator` (pure L0 kernel per Part 05).

The web renders a small "D" chip next to the step in three places:
- The step editor's persona dropdown option (`D · SAST`).
- The step row header in the plan editor.
- The Review step's plan summary list.

A repo-declared persona has no bundled entry so the chip does NOT render for it; the safe default is "model-driven" (informative, not normative).

## Setup wizard: three steps and their gate rules

### Step 1: Focus

Rendered by `ConfigForm` (`packages/web/src/components/security/config-form.tsx`).

Sections in order:
1. **Model.** `<select>` from `SECURITY_MODELS`. Frozen after start.
2. **Focus.** Free-text `<textarea>`. Optional.
3. **Known invariants.** List of one-line strings, add / remove. Optional.
4. **Threat categories.** Checkbox grid of `KNOWN_CATEGORIES`. Optional.
5. **Authorized scope.** REQUIRED when the plan carries any LIVE persona; INFO-only otherwise (an empty scope on a source-only plan is fine). Sub-fields:
    - `hosts` (list of strings): at least one required for a live plan.
    - `cidrs` (list of strings): optional; empty defaults auto-approve nothing.
    - `login_url` (string): optional.
    - `signup_url` (string): optional.
    - `rate_limit_rps` (number, 1..1000): optional.

The scope UI hides on a source-only plan (empty `LIVE_PERSONAS ∩ cells[].persona`); it renders when the plan carries at least one live persona. If the user removes every live persona in step 2, step 1's scope form retains its values but drops the required-star.

### Step 2: Plan

Rendered by `PlanStepsEditor` (`packages/web/src/components/security/plan-steps-editor.tsx`).

- Persona dropdown offers all 12 bundled personas grouped by kind (§Persona kinds).
- Playbook dropdown offers every `KNOWN_PLAYBOOKS` id (14 entries) plus a blank ("None").
- `mode` picker: `fresh` / `resume` / `post-pivot-delta`. The `post-pivot-delta` option is advanced; a small "?" tooltip explains "usually materialized by the pivot-coordinator; hand-authoring is for tests and demos."
- `reads` multi-check of earlier steps.
- `triad` checkbox.
- `review` checkbox.
- `paths` free text.

Client-side validation (`draftError`):
- Every step needs a goal.
- `reads` names an earlier step only.
- At most `MAX_STEPS = 32`.
- Every live persona in the plan requires at least one host in the scope (returns to step 1 with a link to fix).
- Every `post-pivot-delta` step MUST have `reads: [<one earlier step>]` and MUST NOT be a triad.

### Step 3: Review

Read-only summary. `<dl>` with: repo, ref, model, preset, focus, invariants, categories, scope (when non-empty), N steps. Confirm **Start review** → `useCreateSession` → navigate to `/sessions/$sessionId`.

## Running view: layout

Rendered by `EngagementPanel` (`packages/web/src/components/security/engagement-panel.tsx`).

Top to bottom:
1. `RescanDiffBanner` when a re-scan.
2. `Header`: `<repo>@<ref> · <status> · <cost>` + `Cancel` when admin + planning/running + `Rescan` when terminal.
3. `PivotRoundCard` when the current round has an open ask (§Consolidated ask card). Replaces the flat `NeedsSection` when the pivot-coordinator persona ships wired; the flat `NeedsSection` stays for source-only cells that write ad-hoc needs.
4. `ReviewSummary`: focus, invariants, categories, plan, `LiveTestingPanel`.
5. `StepsPanel`: collapsible `CellRail`. `post-pivot-delta` cells render with a `delta` chip and a "reads: cell N" link.
6. `FindingsReview`: grouped by fingerprint, filterable, keyboard-first. Delta findings render with a `delta` pill + a link "unblocked by need `n-...`".
7. `CoverageSection`: assessed vs gaps tabs.
8. `ReportSection`: markdown + downloads.

## Consolidated ask card, wire shape

The runner exposes the coordinator round through one endpoint pair.

**`GET /api/sessions/:id/security/pivot-round`** returns the current round's state:
```ts
{
  round: number;                          // 1..K
  status: "in_progress" | "yielding" | "resolved" | "none";
  autoResolved: Array<{
    needId: string;
    pattern: string;                      // scope-auto-include | propagate-session | ...
    outcome: "ok";
    detail: string;                       // one-line context (e.g. matchedCidr)
  }>;
  autoFailed: Array<{
    needId: string;
    pattern: string;
    outcome: "failed";
    reason: string;
  }>;
  human: Array<{
    needId: string;
    kind: "credential" | "session" | "scope-expansion" | "test-data" | "tool-auth" | "other";
    urgency: "high" | "medium" | "low";
    ask: string;
    example: string;
    surfaceAdded: string[];               // would_unblock.surface_added
  }>;
}
```

**`POST /api/sessions/:id/security/pivot-response`** accepts the consolidated form submit:
```ts
{
  round: number;
  answers: Array<{
    needId: string;
    provided?: Record<string, string>;    // kind-specific payload
    denied?: boolean;                     // user rejected the ask
    denyReason?: string;
  }>;
}
```

The route materializes a `human_response.yml` in the engagement tree at `/human_response.yml`, resumes the coordinator cell in resolve mode, and returns `{roundResolved: boolean, rerunPlan?: RerunPlanSummary}`.

## What this PR ships

1. **`pivot-coordinator` in `BUNDLED_PERSONAS`** (`packages/plugin-security/src/lib/personas.ts`). Adds `PIVOT_COORDINATOR_PERSONA = "pivot-coordinator"` and its bundled entry.
2. **`"pivot-coordinator"` in `KNOWN_PLAYBOOKS`** (`packages/plugin-security/src/lib/playbooks.ts`) and its literal `readFileSync` branch.
3. **`deterministic: boolean` on every bundled persona.** `BUNDLED_PERSONAS[i].deterministic` is true for `sast`, `dast`, `fuzz`, `pivot-coordinator`. The plugin exports `DETERMINISTIC_PERSONA_IDS` and `isDeterministicPersona`.
4. **Plan-editor persona dropdown refreshed** (`packages/web/src/components/security/plan-steps-editor.tsx`) to list all 12 bundled personas grouped by kind and all 14 playbooks, with a `D · ` prefix on deterministic options and a `D` chip in the step row header.
5. **D chip in the Review step's plan summary** (`packages/web/src/routes/security.new.tsx`). Same source of truth (`isPersonaDeterministic`).
6. **Preset rename: `full-pentest` → `code-audit`.** The old id was misleading; that preset is source-only, no active testing.
7. **`live-pentest` preset** (`packages/plugin-security/src/lib/presets.ts` and the hub's `SECURITY_PRESETS`). Seeds recon → threat-model → dast (triad) → fuzz (triad) → exploit → verify cells.
8. **`code-audit-plus-live` preset (fifth preset).** Every persona in one plan: recon → threat-model → code-review, sast, authz, injection (triads) → dast, fuzz (triads) → exploit → pivot-coordinator → attack-tree → verify. Expands to 23 cells (24 with report), within `MAX_PLAN_CELLS`. Requires an authorized scope.
9. **Report cell decoupled from presets.** `PRESET_HAS_REPORT` is removed; `presetPlan(id, {paths?, includeReport?})` and `rescanPlan(id, {includeReport?})` accept an explicit choice. `presetReportDefault(id)` names the preset-level default when the caller omits `includeReport`. `CreateSessionRequest.includeReport` and `SecurityPreviewRequest.includeReport` thread the user's checkbox choice.
10. **Hub "Include a written report at the end" checkbox** (`packages/web/src/routes/security.index.tsx`). Defaults on. Rides through `SecurityNewSearch.includeReport` into the preview + create flow.
11. **Authorized-scope authoring on `ConfigForm`.** Adds a scope section when the plan carries any live persona. Wires through `securityConfig.scope`; posts on create via `useCreateSession` and on running-time edits via `useSetEngagementConfig`.
12. **Test coverage.** Editor tests confirm the new dropdown groups and the D chip; presets tests confirm every preset round-trips through `parsePlan`, including `code-audit-plus-live`; config-form tests confirm the scope form appears iff a live persona is in the plan; a hub test confirms the report checkbox rides through the search params.

## What follow-up PRs ship

**Follow-up PR A: Pivot round runtime.**
- `mode: post-pivot-delta` in `plan.ts::PlanCell.mode`, in `parsePlan`, in `serializePlan`.
- `sec_loot_write` engine tool + `security_loot` virtual paths (`/loot/catalog.yml`, `/loot/cookies-*.txt`).
- `security_findings.traces_to` JSONB column + migration + wire.
- `sec_finding_report` stamps `traces_to.pivot_need` from dispatch context.
- `sec_cell_complete` gates on Part 07 anti-cap checks at L4.
- `GET /security/pivot-round` and `POST /security/pivot-response` routes.

**Follow-up PR B: Consolidated ask card.**
- `PivotRoundCard` component.
- Structured forms per need kind.
- Delta chip on cell rail and finding card.
- Report renderer groups delta findings under their citing need.

**Follow-up PR C: Live scope authoring at running time.**
- Editable `LiveTestingPanel` on the running view (admin, planning-only) so the user can update scope before hitting `sec_start`.

## Conformance

Server-side conformance levels are unchanged (Parts 00-07). This part adds no L0 kernel behavior; every gate is a UI or route enforcement.

**L1+:** the plan editor's persona dropdown MUST list every bundled persona. The playbook dropdown MUST list every `KNOWN_PLAYBOOKS` id.

**L2+:** the `NeedsSection` continues to render ad-hoc needs. The `PivotRoundCard` renders when a `pivot-coordinator` cell yields.

**L3+:** `PivotRoundCard` renders the consolidated ask with structured forms. `POST /security/pivot-response` accepts every kind-specific payload.

**L4:** finding cards show a `delta` pill for `traces_to.pivot_need`-carrying findings. The report groups delta findings under their citing need.

## Spec deviations recorded

The `NeedsSection` and its `POST /needs/resolve` flat-row surface (M-P4c) predate the v1 spec's pivot-round model. Both stay wired for source-only cells that surface ad-hoc needs. When the `pivot-coordinator` persona ships bundled (this PR) and its runtime lands (follow-up PR A), the `PivotRoundCard` replaces the flat surface for the coordinator's rounds. The flat surface stays as a fallback and is INFORMATIVE; the pivot round is normative.

The report cell today does NOT distinguish delta findings from pass-1 findings. This part pins the intended rendering (§Running view §Report); the implementation lands in follow-up PR B.
