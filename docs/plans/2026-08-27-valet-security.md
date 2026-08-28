# Valet Security — Implementation Plan

> Implementation plan for the Valet Security subsystem. Companion spec: `docs/specs/2026-08-27-valet-security-design.md`. Executors read both — the plan sequences work, the spec rules shape.

**Goal:** ship the engagement runner, the engagement tree, one persona, the triage/export/issue-filing surface, and the acceptance suites — spec v1, nothing more.

**Architecture:** app tables behind session-scoped `sec_*` engine ToolDefs (the `mem_*`/`design_*` HTTP-seam pattern); a `kind='security'` runner session drives serial cell dispatch through server-validated transitions; personas are child sessions; the web panel reads REST and polls (the `host_event` seam belongs to #396).

**Tech stack:** existing v2 stack only — Hono routes, Drizzle app schema, engine ToolDefs + ChildSpawner, TypeBox, plugin registry, React 19 + TanStack Router/Query + Radix. New third-party deps: none in packages; the sandbox image adds pinned scanners.

## Global Constraints

- Migrations edit `0000_app.sql` in place; every table/column also gets a `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`; after schema edits run `make dev-clean`.
- This branch does not have #396's `kind`/`template` columns: M0 adds `kind` here with the identical shape (`text DEFAULT 'code' NOT NULL`); whichever PR lands second rebases (spec §Dependencies).
- Type safety rules from CLAUDE.md: no `any`, no double-casts, no ts-ignore.
- Every user-facing error message names the corrective action.
- One name for one thing: engagement, cell, persona, runner, engagement tree, state doc, finding — as defined in spec §Vocabulary.
- Tool names use underscores (`sec_fs_write`); the Anthropic tool-name charset forbids dots.
- Findings egress (export, issue filing) is REST-only, never a tool (spec Decision 10).

## Milestones

### M0: Schema + Drizzle

Add five tables and the `kind` column to `packages/api/migrations/pg/0000_app.sql`, exactly as written in spec §Data Model: `security_engagements`, `security_cells` (with `dir`, `reads`, `review`, `attempts`), `security_files`, `security_findings` (with `status_reason`, `status_actor`), `security_finding_links`. Update `packages/api/src/schema/index.ts` with Drizzle tables (`securityEngagements`, `securityCells`, `securityFiles`, `securityFindings`, `securityFindingLinks`) and `agentSessions.kind`; row types via `$inferSelect`.

**Deliverables:**
- SQL tables + unique indexes per spec (`security_files (engagement_id, path, revision)` unique; `security_finding_links (finding_id, provider)` unique).
- `SCHEMA_REPAIRS` entries for every table, index, and the `kind` column.
- Schema test additions in `packages/api/src/schema/pg-schema.test.ts` following the existing table-shape assertions.

**Acceptance:** `pnpm typecheck` green; `pnpm --filter @valet/api test pg-schema` green; `make dev-local` boots on a wiped `.valet-dev`.

### M1: plugin-security + pure library

Create `packages/plugin-security/` (standard v2 shape, `enabled: false` until M9). The pure library is the load-bearing deliverable — the API imports it (the `plugin-design` lib precedent).

**Deliverables:**
- `plugin.yaml` (`v2: true`, `enabled: false`), `package.json` (`"valet": { "plugin": "./dist/plugin.js" }`, `./plugin` export, `@valet/engine` dep, sibling-matching scripts), `tsconfig.json`; root `tsconfig.json` reference + `packages/api/package.json` dep.
- `src/plugin.ts` — `ValetPlugin` manifest: skill + role via `loadSkillFromMarkdown`/`loadRoleFromMarkdown`, no actions.
- `skills/security-engagement-runner/SKILL.md` — the runner loop (spec §The Loop), "trust `sec_status`, never your memory", plan-authoring guidance, manifest presentation.
- `roles/code-review.md` — persona role per spec §plugin-security: checklist loop, checkpoint cadence, yield, evidence standard, severity rubric, tools-first-class, prohibitions.
- `protocol/state-doc.md` — state doc contract, exit/yield conditions, rehydration rule, two-filesystems rule.
- `src/lib/` pure functions with unit tests:
  - `plan.ts` — `parsePlan(yaml: string): EngagementPlan` (cells: `{ ordinal, persona, mode, goal, reads: number[], paths?: string[], review?: boolean }`); validates dense ordinals, known personas, `reads` reference earlier ordinals only, ≤ 32 cells; `cellDirSlug(ordinal, goal): string` (`01-recon`).
  - `state-doc.ts` — `parseStateDoc(content: string): StateDoc` (`protocol_version`, `status: 'working'|'yielding'|'done'`, `checklist/queue {pending, done}`, `findings: string[]`); `checkExitCondition(doc): { ok: true } | { ok: false; violation: string }` (done + both zeros); `checkYield(doc): boolean`.
  - `fingerprint.ts` — `findingFingerprint({ file, line, title }): string` — sha256 over file, `Math.floor(line/10)`, normalized title; first 16 hex.
  - `presets.ts` — the `code-review` preset plan (five cells per spec, `reads` edges, `review: true` on 05-verify).

**Acceptance:** `pnpm --filter @valet/plugin-security test` green (plan validation incl. rejection cases, exit/yield checks, fingerprint stability, preset parses through `parsePlan`); `pnpm typecheck` green.

### M2: Engagement service + session minting + read routes

**Deliverables:**
- `packages/api/src/services/security-engagements.ts` — service owning every transition: `createEngagement` (called from session create), `setPlan` (planning only), `startEngagement` (pin SHA, materialize cells with `dir`/`reads`/`review`), `dispatchCell` (transaction: spawn via host ChildSpawner + stamp `child_session_id` + increment `attempts` + status `running`; refuse on live child), `completeCell` (settled check + state doc parse + exit/yield ruling → `completed`/`yielded`/violation), `failCell`, `closeEngagement` (manifest: per-cell stats, distinct-fingerprint severity counts, verified/refuted/open, triage tallies), `writeFile`/`readFile`/`listFiles` (append-only revisions; path-prefix write claim from `child_session_id`; `/protocol.md` and `/plan.yml` virtual mounts; 256 KB / 512-revision caps), `reportFinding` (evidence floor 200 chars, 100/cell cap, fingerprint + sibling return), `reviewFinding` (forward-only; `review: true` cells or `user:` actors).
- `POST /api/sessions` accepts `kind: 'security'`; seeds the engagement row (preset plan, status `planning`) in the create transaction. Repo binding required for security sessions; the error names the fix ("A security review needs a repository. Pick one in the hub.").
- `packages/api/src/routes/security.ts` — `GET /api/sessions/:id/security` (engagement + cells + running-cell progress parsed from its latest state doc), `GET .../security/findings` (filters severity/status/cell/path, cursor), dual-auth ladder from the memory/design routes precedent (user session or `x-valet-internal`).
- Metrics: cells created/settled counter pair, over-age running gauge, compaction-staleness counter (wired in M5).

**Acceptance:** `packages/api/src/services/security-engagements.test.ts` green — covers plan immutability after start, dispatch refusal on live child, exit/yield/violation rulings, path-prefix write rejection, append-only revisions, finding caps and floors, forward-only review; `pnpm --filter @valet/api test security` green.

### M3: Runner tools

**Deliverables:**
- `packages/api/src/engine/security-tools.ts` — runner ToolDefs calling the internal routes over `ctx.config.apiBaseUrl` + internal token: `sec_plan_set`, `sec_start` (approval gate via `ctx.requestDecision` naming repo/SHA/cells/personas/cost estimate), `sec_status`, `sec_dispatch`, `sec_cell_complete`, `sec_cell_fail`, `sec_close`, `sec_handoff` (ChildSpawner with finding brief), plus read-only `sec_fs_read`/`sec_fs_list`/`sec_findings_list`.
- Host wiring (`packages/api/src/engine/host.ts`): attach runner tools + skill when the session row has `kind='security'`.
- Internal mutation routes on `routes/security.ts` backing each tool (`POST .../security/plan`, `/start`, `/dispatch`, `/cells/:cellId/complete`, `/cells/:cellId/fail`, `/close`).
- **Settlement seam checkpoint (spec §Dependencies):** an integration test proving a `child.settled` signal is admitted to an `interactive`-purpose parent and starts a runner turn. If the edge ACL denies it, fix belongs in `admitSignal`'s authorization (the `child_watches` edge exists) — do not work around it with polling.

**Acceptance:** `packages/api/src/engine/security-tools.test.ts` green (gate payload, transition errors surface as corrective tool errors); settlement seam test green; `make smoke-orchestrator` still green.

### M4: Persona tools + cell claims

**Deliverables:**
- Persona ToolDefs in `security-tools.ts`: `sec_fs_write`, `sec_fs_read`, `sec_fs_list`, `sec_finding_report`, `sec_finding_review` (attached only when the claiming cell has `review: true`).
- Cell-claim resolution: child session id → `security_cells.child_session_id` lookup; host wiring attaches persona tools + the persona role to claimed children.
- Dispatch prompt assembly in `dispatchCell`: persona role, protocol verbatim, goal/mode/`paths`, own cell dir, `reads` cells' state doc paths only (spec §Selective context).
- `state.yml` writes validated (YAML parse + `protocol_version`); other paths free-form.

**Acceptance:** tool tests green — own-cell write passes, peer-cell write refused with corrective error, `state.yml` validation, review-tool absence on non-review cells; a virtual-sandbox integration test runs one dispatch → persona writes state + finding → settle → `sec_cell_complete` completes.

### M5: Context discipline wiring

**Deliverables:**
- `sec_fs_read` results for `/protocol.md` marked `protectedFromPruning`.
- Host registers a `compactionHook` for cell-claimed sessions: stamp the compaction on the cell (surfaced to the rail), emit the staleness metric when the latest state doc is older than the checkpoint stride. No auto-repair.
- Yield path end-to-end: persona settles `yielding` → cell `yielded` → `sec_dispatch { mode: 'resume' }` → fresh child reads own state doc.

**Acceptance:** compaction hook unit test (fires, stamps, no mutation of cell status); yield integration test (Scenario D steps 1–3 shape).

### M6: Triage routes — review, export, issue filing

**Deliverables:**
- `POST .../security/findings/:findingId/status` — `canAdministerSession`, forward-only, `status_actor: user:<id>`, reason required.
- `GET .../security/export?format=md|sarif|json` + filters — view-gated, generated from rows, audit event (actor, format, row count). SARIF mapping per spec §Export (fingerprint ruleId, severity→level map, `versionControlProvenance` SHA, refuted → `suppressions`). Markdown = manifest + per-finding sections with collision-safe fences.
- `POST .../security/findings/:findingId/issues { provider, repo?, teamId? }` — via `action-invoker.ts` with the acting user's credentials: `github.create_issue` or the Linear MCP action; writes `security_finding_links`; unique-index idempotency returns the existing link; disconnected provider error names the corrective action.
- `POST .../security/issues/digest { provider, findingIds }` — one digest issue.
- Named authz checks on every mutating route (`canAdministerSession` for status; `canViewSession` named explicitly for filing/export).

**Acceptance:** route tests green — 403 with named right, SARIF snapshot assertions, idempotent filing, digest body shape, audit rows written.

### M7: Web — `/security` hub

**Deliverables:**
- `packages/web/src/routes/security.tsx` + `security.index.tsx` — repo picker (reuse new-session-dialog binding UX), preset picker (Code review), optional prompt, engagement list (status, finding counts) from `GET /api/sessions?kind=security`; create → redirect to the session page.
- Nav entry beside the workflows hub.

**Acceptance:** hub route test (`-security-hub.test.tsx`) green; create flow reaches `POST /api/sessions` with `kind`, repo, preset.

### M8: Web — engagement panel + triage surface + renderers

**Deliverables:**
- `packages/web/src/components/security/` — `engagement-panel.tsx` (layout + mobile Chat | Panel toggle), `cell-rail.tsx` (status, attempts, elapsed, state-doc progress counts, compaction badge, over-age warning, child links), `findings-review.tsx` (master-detail per spec §Findings review: filters, fingerprint grouping, evidence rendered escaped, blob link at pinned SHA, provenance, status history, verify/refute, keyboard `j/k/v/r/i/enter`), `export-dialog.tsx`, `file-issue-dialog.tsx` (provider availability + corrective copy, Linear team picker remembered per engagement, digest option), `manifest-card.tsx`.
- `packages/web/src/api/security.ts` client + TanStack Query polling (no `host_event` on this branch).
- Session page integration for `kind='security'` (`sessions.$sessionId.tsx`).
- Tool renderers: `security.tsx` in `tool-renderers/` (cell card for `sec_dispatch`, severity-badged card for `sec_finding_report`, status summaries for `sec_cell_complete`/`sec_close`), listed before the fallback in `index.ts`.
- Component state follows the mount-time-props rule (prop-synced effects, stable ids as keys).

**Acceptance:** component tests green (filters, keyboard triage, admin gating of verify/refute, escaped rendering of a hostile evidence body, export dialog request shape, idempotent-filing UI); `pnpm --filter @valet/web test security` green.

### M9: Sandbox scanners + registry enable

**Deliverables:**
- `docker/Dockerfile.sandbox-k8s`: pinned gitleaks + semgrep (offline rules baked), per spec §plugin-security — stock image, no variant.
- `plugin.yaml` → `enabled: true`; `make generate-registries`; commit `registry.gen.ts` (before any e2e run — the drift suite clobbers it otherwise).

**Acceptance:** image builds; `gitleaks version` and `semgrep --version` succeed in-container; registry regen clean.

### M10: Acceptance suites A–E

**Deliverables:** `packages/api/src/integration/security-acceptance.test.ts` (virtual sandbox provider) implementing spec Scenarios A (end-to-end incl. verify cell + selective dispatch prompt), B (restart is a non-event — assert `attempts` stays 1), C (violation → child_send → pass), D (yield/resume + child-death re-dispatch), E's API half (status 403, SARIF suppressions, idempotent filing, digest, corrective Linear error). E's web half lives in the M8 component tests.

**Acceptance:** all five suites green; tool-persistence round-trip suites still green (`engine test happy-path`, `in-memory-store`, `store-postgres`, api integration).

### M11: Sweep

`pnpm typecheck`, full `make e2e` scorecard (captured in full, never piped through tail), PR description Validation section updated with the scorecard, spec §Deviations updated with anything the codebase forced.

## Implementation status (2026-08-27)

All milestones landed on this branch. Deltas from the plan as written:

| Milestone | Status | Notes |
|---|---|---|
| M0 schema | done | plus `security_cells.compacted_at` (the compaction hook's stamp) |
| M1 plugin | done | plan cells gained a short `name` for stable tree dirs (`01-recon`); `yaml` lib reused, not js-yaml |
| M2 service | done | engagement insert rides the session-create transaction; OTel counters; spawn failure releases its own claim |
| M3 runner tools | done | settlement seam proven: `admitSignal` already admits child→interactive-parent, no ACL change needed |
| M4 persona tools | done | claim is stamped before spawn (the child's engine build resolves it); roles attach per turn via `PromptOptions.role` |
| M5 context discipline | done | dedicated `sec_protocol_read` (pruning protection is per tool, not per args); staleness measured from dispatch when no state doc exists |
| M6 triage routes | done | audit rides `action_invocations`; Linear tools resolve at runtime over MCP |
| M7 hub | done | repo picker extracted from the new-session dialog; no preset wire field (server seeds the plan) |
| M8 panel | done | manifest card derives from rows (no manifest GET); Fix seeds the composer, does not auto-send |
| M9 scanners | done | gitleaks only (no Python in the image; plan risk 6); registry enablement needed a skill-scoping fix — plugin skills would have attached to every session |
| M10 acceptance | done | Scenario B restart emulated in-process (evict + rearm); cross-process half held by orchestrator-restart.test.ts |
| M11 sweep | done | scorecard in the PR; e2e runner lists gained plugin-security + the security integration files |

## Cross-cutting risks

1. **#396 collision:** both PRs add `agent_sessions.kind`. Identical shape by design; second-lander rebases to a no-op. Watch `template` — security does not add it.
2. **Settlement seam (M3)** is the highest-uncertainty item; it gates the loop's autonomy. Prove it before building M4+ on top.
3. **Registry drift clobber:** commit `registry.gen.ts` in the same commit as `plugin.yaml` changes, before running `make e2e`.
4. **PGlite wipe:** M0 requires `make dev-clean` in every worktree with dev data.
5. **Env-sensitive api tests:** run model-resolution-adjacent suites through `make e2e` (scrubbed env), not bare vitest with `ANTHROPIC_API_KEY` exported.
6. **Semgrep in the image:** semgrep pulls Python; if image size or build time balloons, ship gitleaks-only in M9 and record the deviation — the persona role already treats scanners as optional accelerants.

## Not in plan

Everything in spec §Non-Goals, plus: `host_event` wire events (polling until #396 lands), Linear/GitHub OAuth connect flows (integrations own them), org-wide findings dashboard, GitHub code-scanning upload.
