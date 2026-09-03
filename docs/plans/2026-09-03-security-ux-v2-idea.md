# Security UX v2 idea doc

**Status:** idea, 2026-09-03. Feeds a future Part 13 in `docs/specs/valet-security/spec/`.
**Owner:** Applied AI.
**Stacks on:** PR #523 (Part 12 credentials via 1Password).
**Depends on landed:** Parts 00-12, `packages/plugin-security` bundled personas, `packages/web/src/routes/security.*`, and the existing `security_engagements` / `security_findings` schema.
**Location note:** this doc lives under `docs/plans/` per CLAUDE.md's plan convention. There is no `docs/specs/valet-security/ideas/` directory. Move it there if that convention lands.

This doc turns a batch of user feedback (from Mehdi's onboarding walkthrough plus the owner's own directives) into one pre-spec artifact the Part 13 author can lift straight into normative text. It fixes the shape of the changes and their supersession relationship to Parts 08 and 09, and it enumerates the data-model, wire, persona-prompt, and UI ripples for each theme so the spec author does not have to re-discover them.

## Goal

Land seven security-UX changes as a coherent stack:

1. Rename the "Full code review" preset so users read presets as starting points, not final choices.
2. Move Focus and Invariants out of the default wizard and change persona prompts to treat them as guidance, never scope filters.
3. Rebuild the plan editor as a DAG view with a per-node edit drawer.
4. Widen the running-view findings pane and demote the activity stream to a read-only rail under the DAG.
5. Add richer finding verdicts (agree / disagree / refute) with an inline-edit overlay that does not mutate the fingerprint.
6. Ship the report as a rich HTML artifact (Fano-style), with a per-finding "generate visualization" button.
7. Let rescan prefill the parent run's edited plan, then re-open the DAG editor before start.

Two supporting concepts land alongside: an editable architecture-memory doc the coordinator writes and the human corrects, and a finding-to-activity-stream cross-link.

## Non-goals for v2

- Meridian handoff. Valet owns findings and verdicts. It does not own accept, mitigate, or remediate. That boundary keeps but the export button waits.
- Batch per-finding visualization generation. The button generates one visualization on demand.
- New personas. The bundled twelve stay as-is.
- Cross-engagement architecture-memory reuse. Architecture memory is per-engagement.
- User chat input into a running engagement. The stream is read-only in this cycle.
- HTML content-security policy resolution. Called out as an open question, not decided here.
- L4 conformance additions.

## Supersession table

Part 13 replaces the following normative sections. Old text stays for the history of the source-only ship path, mirroring how Part 12 supersedes Part 10.

| Superseded | Old normative content | v2 replacement |
|---|---|---|
| Part 08 §Setup wizard: three steps and their gate rules → Step 1: Focus | Focus, invariants, categories fields visible on the default flow. | Focus and invariants move under an Advanced disclosure. Categories stay visible. Model picker stays. |
| Part 08 §Setup wizard → Step 2: Plan | Plan step renders as a linear list; every step exposes persona, playbook, mode, reads, triad, review, paths inline. | Plan step renders as a DAG view. Nodes show minimal chrome. A per-node edit drawer holds every existing control. Validation rules and `MAX_STEPS = 32` are unchanged. |
| Part 08 §Running view: layout | Left column stacks header, review summary, cell rail. Right column stacks findings, coverage, report. | Left column: DAG at top, read-only activity-stream rail under it. Right column widens and holds findings, coverage, report. Ratio 40/60 by default. |
| Part 08 §Report as a user choice | Report cell writes markdown and JSON. Terminal view renders the markdown. | Report cell also publishes one rich HTML artifact (new artifact `kind: "security-report"`). Existing markdown and JSON downloads stay. |
| Part 09 §Launch checklist | Third wizard step is the Launch checklist. | Unchanged for launch semantics. The checklist gains one line naming which fields the user chose to leave under Advanced. |
| Part 08 flow D: Re-scan | Rescan seeds a new engagement from the parent and starts immediately. | Rescan opens the DAG editor prefilled with the parent's final `planCells` + `config`. Start is a second click. |

The `SECURITY_PRESETS` label rename is not a supersession; it is a label change in two files (see §Preset rename).

## Themes

### A · Preset rename (label-only)

Change **Full code review** to **Basic code review** to signal it is a starting point, not the exhaustive scan the label implies. Label-only: no preset id change, no `security_engagements` row rewrite, no `isKnownPreset` change.

Two touch points share the label and MUST stay in sync:

- `SECURITY_PRESETS[0].label` in `packages/web/src/routes/security.index.tsx`.
- The preset row in `packages/plugin-security/src/lib/presets.ts`.

Every preset card gains a one-line hint: "Starting point. Reconfigure the plan on the next step." This defuses the "one perfect preset" mental model that Mehdi's walkthrough surfaced. The hint copy sits with the preset row in `SECURITY_PRESETS` so both files stay authoritative.

### B · Focus and invariants: hide, and rewrite the personas

The visible fix is small: focus and invariants move under an Advanced disclosure on Step 1 of the wizard. The real fix is in the persona role markdown.

The twelve files in `packages/plugin-security/personas/` MUST read focus and invariants as guidance, never as scope filters. Rewrite each to say (a) the focus paragraph is a hint to spend extra attention on, not a boundary; (b) invariants are hypotheses to check against, not a list of asserted truths the persona should not challenge.

**Testable acceptance criterion.** For a fixed corpus repo, a run with a non-empty `focus` and `invariants` MUST NOT reduce the coverage ledger's assessed-surface count versus a matched run with both empty. If it does, the persona narrowed. This lives in Appendix A as a new acceptance row.

`SecurityConfig.focus` and `SecurityConfig.invariants` stay in the schema and stay honored on `.valet/security.yml` load. The change is UI visibility plus persona-prompt wording. No wire change.

The Launch checklist gains one line: **"Focus and invariants set under Advanced: <yes | no>"**, so the user reading the checklist sees they chose to steer the run.

### C · DAG plan editor

The plan editor renders `PlanCell[]` as a DAG using dagre or elkjs for layout. This is a **view** over the existing ordered list; the underlying `parsePlan` / `serializePlan` contract does not change.

**Rendering rules.**

- Nodes are cells. Node chrome shows: ordinal, persona (with the D chip for deterministic personas), short goal (truncated), and a small badge for `triad` / `review` / `post-pivot-delta`.
- Edges are `reads`. An edge always goes from an earlier ordinal to a later ordinal.
- The layout is left-to-right, one column per depth level.
- Parallel siblings render in the same column.
- Deleted nodes cascade: deleting node N asks the user to remap or delete every descendant.

**Editor rules.**

- Add node hangs off any existing node; the new node's default `reads` is that node.
- Backward or cyclic edges are impossible to draw; the UI refuses.
- Reordering: the editor rewrites ordinals on save so serialized `PlanCell[]` stays reads-earlier-only.
- Per-node edit drawer: click opens a right-side drawer with every existing control (persona dropdown, playbook, mode, reads multi-check, triad, review, paths).
- Validation preserved: `MAX_STEPS = 32`; `post-pivot-delta` reads exactly one earlier step and is never a triad; every step needs a goal; every live persona in the plan requires at least one host in the scope.

**Round-trip requirement.** The DAG editor MUST round-trip through `parsePlan(serializePlan(edit(parsePlan(input)))) === parsePlan(input)` for every plan the current linear editor accepts. Ship this as a vitest snapshot suite on the seeded presets.

### D · Running-view layout

The running view rebalances screen real estate around the findings pane, which is where users spend time.

**Layout.**

```
┌──────────────────────────────────────────────────────────────┐
│  Header (repo@ref · status · cost · Cancel / Rescan)         │
├────────────────────────────┬─────────────────────────────────┤
│  DAG (nodes stream state)  │                                 │
│  ─────────────────────     │  Findings (wider, 60%)          │
│  Activity stream (read)    │  filters + list + detail        │
│  · persona thought log     │                                 │
│  · tool calls              │                                 │
│  · click a finding to jump │                                 │
├────────────────────────────┤  Coverage                        │
│  (Rescan diff banner if    │                                 │
│   applicable)              │  Report (HTML artifact preview) │
└────────────────────────────┴─────────────────────────────────┘
```

- Left column defaults to 40% width; right column to 60%. Draggable divider persists in `localStorage`.
- The activity stream is read-only. No input field. A future spec adds input.
- Node state on the DAG mirrors cell status: pending / running / completed / yielded / failed. A running node pulses.
- `PivotRoundCard` (Part 08 §Consolidated ask card) renders as an overlay banner above the DAG when a coordinator round yields.

**Finding ↔ stream cross-link (cell-level).**

`security_findings.cellId` already ties a finding to its origin cell. That is the granularity for v2. Clicking a finding in the right pane scrolls the activity stream to the first entry from that cell and highlights it. Clicking a stream row for a cell filters the findings list to that cell.

Turn-level linking is a Part 14 upgrade and requires a new column (`security_findings.originEntryId` or similar). Named as a follow-up, not built here.

REST stays authoritative for stream history per the locked rule in CLAUDE.md. The websocket `init` event stays metadata-only.

### E · Findings model v2: three verdicts and inline-edit overlay

Today's finding status set is `verified | refuted | fixed | untriaged` with `statusActor` + `statusReason` and a `security_finding_comments` thread. v2 splits verify into two verdicts and layers a human overlay.

**New status set.** `verified_agree | verified_disagree | refuted | fixed | untriaged`.

- `verified_agree`: the persona verified the finding and the human concurs.
- `verified_disagree`: the persona verified the finding but the human reads it differently. The verdict itself is real; the interpretation is disputed. This becomes the escape hatch users currently overload `refuted` for.
- `refuted`: the finding is not real.
- `fixed`: real and resolved (rescan carry-over).
- `untriaged`: no human action yet.

**Ripple list for the status widen.**

- Schema CHECK constraint on `security_findings.status` in `packages/api/migrations/pg/0000_app.sql`.
- `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts` (CLAUDE.md pre-1.0 rule).
- `STATUS_OPTIONS` in `findings-review.tsx` and any filter shipped to the wire.
- `FindingStatusChip` component and its color palette.
- The `sec_finding_review` gate: keep the rule that only review cells can flip a status; extend accepted values to the new set.
- Keyboard contract: `v` today is one keystroke for verify. That contract MUST NOT regress. Proposed mapping: `v` opens a verdict-picker popover with `a` (agree), `d` (disagree). One keystroke stays for the fastest path (`v` then `a`); the popover auto-focuses. `r` still refutes with the reason dialog.
- Wire type widen in `packages/api/src/wire/types.ts` on the finding status enum.

**Inline-edit as an overlay, not a rewrite.** This is the change with the deepest gotcha.

The finding fingerprint (`docs/specs/valet-security/spec/02-finding-fingerprints.md` §2.1) canonicalizes over `(file, line, title, body prefix 200 codepoints)`. Editing title or description mutates fingerprint inputs. That breaks `reconcile`'s carry-over across rescans (`carriedFromFindingId`) because the rescan cannot match the human-edited title to the parent's fingerprint.

Ship inline edit as an **overlay** stored beside the model-authored fields, never a rewrite:

- New columns on `security_findings`:
  - `humanSeverity` (nullable): human-set severity override.
  - `humanTitle` (nullable): human-set title override.
  - `humanBody` (nullable): human-set body override.
  - `humanEditedAt`, `humanEditedBy`: audit.
- The finding card renders the human overlay when present, otherwise the model authoring.
- Fingerprint computation stays on the model-authored `title` and `body`. Never on the overlay.
- Rescan carry-over stays exact.
- Export (Markdown / SARIF / JSON) prefers the human overlay and cites the model authoring in a footnote so the report reflects human judgment.

Editing severity does not touch the fingerprint. It is safe to edit inline without an overlay column, but a separate `humanSeverity` is cheaper than distinguishing an inline severity edit from a persona-driven severity change and keeps the pattern uniform.

**View reasoning drawer.** The `reasoning?: boolean` at `packages/api/src/wire/types.ts:2982` is a model capability flag on `ModelInfo`, unrelated to per-finding rationale. Nothing persists per-finding reasoning today. Two options for storage:

- Option 1: New column `security_findings.reasoning` (text, nullable). Persona writes when it emits the finding.
- Option 2: Store per-finding reasoning in the cell's state doc under `findings/<fingerprint>/reasoning.md` and fetch on drawer open.

Recommend Option 1 for read-path simplicity. Add one new column, one `SCHEMA_REPAIRS` entry, one persona-prompt line asking every persona to fill it, and one section in the finding-detail pane.

### F · Report as a rich HTML artifact

The report cell today writes markdown and a JSON snapshot to the engagement tree and to `security_engagements.reportMarkdown` / `reportJson`. v2 also publishes one rich HTML artifact through the existing `artifacts` table.

**New artifact kind: `security-report`.** The report cell composes one self-contained HTML document with:

- The executive summary at the top.
- Findings grouped by severity, then by cellId. Each finding block shows the model authoring, the human overlay (if any), the persona reasoning (if stored), the evidence excerpt, and file:line links back to the source.
- One optional attack-flow diagram per multi-cell finding, embedded as SVG or a mermaid block rendered at publish time.
- Coverage summary: assessed vs NOT_ASSESSED.
- Pivot round summary if the engagement went through one.

**Per-finding "generate visualization" button.**

The button lives in the finding detail pane. On click, it enqueues a work item that asks the model to generate one embedded viz for that finding: a small mermaid diagram (attack chain), an ASCII-art data-flow, or an annotated snippet. The result stores as an inline block on the finding and re-publishes the HTML artifact. Not batch; one at a time. This matches Mehdi's "visualizations most useful for cross-boundary findings, not every finding" observation.

**Artifact wire.** Extend `POST /api/artifacts/share` to accept `kind: "security-report"` with a payload that carries the engagement id. The artifact row snapshots the HTML at publish time so a later engagement change does not silently rewrite an already-shared link. Existing `orgs.allow_public_artifacts` gate stays. A rescan does not touch parent-report artifacts.

**Threat-model row (Appendix B addition).** Model-authored HTML is untrusted content. The report can carry attacker-controlled strings (finding titles, evidence excerpts, viz payloads). Threats to name in Appendix B: stored XSS via a finding title, exfil via an `<img>` tag pointing off-org, clipboard hijack via a malicious inline handler. Mitigations: strip every `<script>`, `<style>`, event handler, and external URL at publish time; render viz as inline SVG only; publish under a strict content-security-policy header on `GET /api/artifacts/:token`. **Open question:** does the artifact host set that CSP today? If not, this is a hard prerequisite before shipping HTML artifacts. Named in §Open questions.

### G · Architecture memory

An editable "what the agent thinks the system is" doc that the coordinator writes and the user corrects. Cited in Mehdi's walkthrough as Grafana's "infrastructure memory". Enables the "this diagram is wrong" correction path.

**Storage.** Virtual path `/architecture.yml` in the engagement tree, addressed through `sec_fs_read` / `sec_fs_write`. No new Postgres table. Follows the `needs.yml` / `loot.catalog.yml` pattern in Parts 04 and 06.

**Content shape.**

```yaml
version: 1
authored_by: recon       # a persona id or "human"
last_edited_at: 2026-09-03T18:12:00Z
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
  free-form context the coordinator or human wants downstream personas to read
```

**Flow.** The `recon` persona populates `/architecture.yml` on first run. Later cells read it (via a new `reads_arch: true` flag on `PlanCell`, defaulting to true for every non-recon cell). The UI renders a diagram in the running view under the coverage tab, with an **Edit** button that opens a form. Human edits stamp `authored_by: "human"` and `last_edited_at`. The next cell reads the edited version.

**Important boundary.** Architecture memory is a **claim**, not evidence. Part 07's anti-cap checks stay authoritative for finding validity. A persona that cites `/architecture.yml` in a finding's reasoning MUST also cite file evidence.

### H · Rescan v2

Rescan today opens a new engagement and starts immediately with `rescanOf: <parent id>`. v2 turns rescan into a two-click flow so users can reshape the plan.

**Flow.**

1. From a terminal engagement row, click **Rescan**.
2. The `/security/new` route opens with `SecurityNewSearch.rescanOf: <parent id>`. The preview endpoint (`POST /security/preview`) accepts `rescanOf` and returns the parent's final `planCells` + `config` + `authorizedScope` + `focus` + `invariants` + `categories` (fetched from `security_engagements` and the child cells' state docs).
3. The wizard skips to Step 2 (Plan) because the plan is where rescan diverges from a fresh run. Step 1 stays reachable via the back button.
4. The DAG editor prefills with the parent's plan. Users add, remove, or re-order nodes; delete cascades apply.
5. The DAG editor renders an extra "carry-forward" chip on any node whose reads chain touches `reconcile`, so users see which nodes will inherit parent findings.
6. Start creates the engagement with the edited plan and `rescanOf`.

**Wire.**

- Extend `POST /security/preview` request with `rescanOf?: string`. Response gains the seeded `config` and `planCells` from the parent.
- `POST /api/sessions` already accepts `rescanOf`. No change.

**Behavior of `reconcile`.** Unchanged: the reconcile cell reads parent findings and marks each as new / recurring / fixed. If the user removed the `reconcile` cell from the DAG, the rescan behaves as a fresh scan seeded from parent config, and the wizard shows a warning banner ("Rescan without a reconcile cell will not carry parent findings").

## Cross-cutting data-model deltas

| Change | Table | Column | Nullable | Migration |
|---|---|---|---|---|
| Human overlay: severity | `security_findings` | `human_severity` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: title | `security_findings` | `human_title` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: body | `security_findings` | `human_body` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: audit | `security_findings` | `human_edited_at`, `human_edited_by` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Per-finding reasoning | `security_findings` | `reasoning` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Status enum widen | `security_findings` | `status` (CHECK) | no | 0000_app.sql edit + SCHEMA_REPAIRS (probe for new values) |
| Report artifact link | `security_engagements` | `report_artifact_id` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |

Every change follows CLAUDE.md's pre-1.0 rule: edit `0000_app.sql` in place and add a matching `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`. `make dev-clean` in every dev worktree after schema edits.

No new tables. Architecture memory rides on a virtual path.

## Cross-cutting wire deltas

- `SecurityFindingWire.status`: widen enum.
- `SecurityFindingWire`: add `humanSeverity?`, `humanTitle?`, `humanBody?`, `humanEditedAt?`, `humanEditedBy?`, `reasoning?`.
- `SecurityEngagementWire.reportArtifactId?`: filled once the report artifact publishes.
- `SecurityPreviewRequest.rescanOf?`.
- `SecurityPreviewResponse` gains parent-plan fields when `rescanOf` is set.
- `POST /api/artifacts/share` accepts `kind: "security-report"` and a payload that resolves the engagement.

Every widen preserves backward compatibility with in-flight clients (v0 verdicts still parse; missing overlay fields render as no-op).

## Persona and prompt deltas

- Every persona role markdown in `packages/plugin-security/personas/` is rewritten to treat focus and invariants as attention hints, not filters.
- Every persona also gains one line: "When you emit a finding, populate the `reasoning` field with the smallest set of citations and inferences a human reviewer needs to follow your logic."
- `recon.md` gains: "Populate `/architecture.yml` on first run. Follow the schema at `docs/specs/valet-security/spec/13-*.md` §Architecture memory."
- `report.md` gains: "Publish the HTML artifact via the `sec_report_publish_html` engine tool. Cite the artifact id in the report markdown."

## New engine tools (indicative)

- `sec_report_publish_html`: input the HTML string and metadata; output the artifact id. Sanitizes strictly (see §E open question).
- `sec_arch_read` / `sec_arch_write`: convenience wrappers around `sec_fs_read` / `sec_fs_write` for `/architecture.yml` with a schema check on write.
- `sec_finding_edit_overlay`: writes the human overlay fields. Distinguishes from `sec_finding_review` (which flips status).
- `sec_finding_viz_generate`: generates one visualization for a finding on demand and re-publishes the HTML artifact.

Every tool follows Part 03's provisioning shape: engine `ToolDef` in `packages/api/src/engine/security-tools.ts`, attached in `packages/api/src/engine/host.ts::buildSecurityRunnerTools` / `buildSecurityPersonaTools`.

## Test surface (indicative)

- **Editor round-trip.** `parsePlan(serializePlan(edit(parsePlan(seed)))) === parsePlan(seed)` for every preset.
- **Fingerprint stability under human overlay.** For a finding with a set human overlay, `fingerprint(finding)` MUST equal `fingerprint(finding_before_overlay)`.
- **Focus/invariants coverage regression.** For a fixed corpus repo, focus-set vs focus-unset runs produce coverage ledgers where assessed_surface(focus_set) >= assessed_surface(focus_unset).
- **Status widen migration.** A row with status=`verified` before the migration reads as `verified_agree` after (Recommended default) OR stays as `verified` and the UI treats it as agree until a human touches it (safer, Recommended for the spec author to pick).
- **HTML artifact publish is idempotent.** Re-publishing without a diff hits the same artifact id and does not create a new row.
- **Rescan prefill.** A rescan preview endpoint returns the parent's final planCells and config verbatim.

## Open questions the spec author closes

1. **Content-security-policy for HTML artifacts.** Does `GET /api/artifacts/:token` set a strict CSP today? If not, this is a prerequisite: the HTML artifact ships only after the artifact route enforces `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'` (or tighter). Verify in `packages/api/src/routes/artifacts.ts` and its middleware.
2. **Status widen migration policy.** Rewrite existing `verified` rows to `verified_agree`, or keep them as `verified` and treat as-agree until touched? See test surface above.
3. **Keyboard remap for verify agree/disagree.** Confirmed proposal above (`v` opens a popover with `a`/`d`), or a different binding? The base `v` = one keystroke rule MUST hold.
4. **DAG library.** dagre vs elkjs. Recommend dagre for smaller bundle; elkjs is nicer for large graphs. Both work at `MAX_STEPS = 32`.
5. **Architecture-memory diagram render.** Mermaid inline (matches artifact-diagram idiom) or a small custom react-flow render? Recommend mermaid for consistency with the HTML artifact.
6. **Reasoning field size cap.** Cap at N codepoints per finding to keep the report render bounded? Recommend 2000, matching the finding body practical size.
7. **Rescan behavior when the parent used `pivot-coordinator`.** Prefill the coordinator cell too, or start fresh from just the pre-pivot cells? Recommend prefill with a chip saying "reruns pivot; parent's needs answers are NOT carried".
8. **Cell-level vs turn-level cross-link.** Cell-level ships now (no schema change). Named as a v2 shipping decision above. Confirm.

## Deferred to later specs

- User input into the activity stream (chat-back). Requires input-plane wire, permission gates, and audit.
- Turn-level finding ↔ stream cross-link.
- Batch visualization generation.
- Meridian handoff (accept / mitigate / remediate) and the `Send to Meridian` button.
- Cross-engagement architecture-memory reuse (an org-scoped `/architecture.yml` seeded from prior engagements).
- Report artifact export to PDF.
- Multi-round pivots (Appendix C already defers).

## Ship order

Suggested slicing to keep each PR under CLAUDE.md's "one discrete task per commit" ceiling:

1. Preset rename + persona prompt rewrite. Small, no schema.
2. Focus/invariants under Advanced. UI only.
3. Findings status widen + overlay columns + drawer for reasoning storage. Schema + wire + UI.
4. DAG editor. UI-heavy; validation preserved.
5. Running-view layout rebalance + cross-link. UI + one small state change.
6. Architecture memory read/write + recon prompt + running-view diagram.
7. Rescan v2 preview endpoint + wizard rescan flow.
8. Report HTML artifact + per-finding viz. Gated on CSP question resolving.

Every PR carries its own tests (round-trip, fingerprint-stable, coverage-regression) and updates its part of Part 13.

## Changelog

`2026-09-03`: first pass, based on Mehdi's onboarding walkthrough plus owner directives. Advisor pass flagged fingerprint collision under naive inline edit; overlay pattern adopted. Advisor pass added supersession table, status-widen ripple list, and CSP open question.
