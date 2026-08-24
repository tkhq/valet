# Valet Design — Implementation Plan

> Detailed implementation plan for Valet Design subsystem. Companion spec: `docs/specs/2026-08-23-valet-design-design.md`.

## Summary

Valet Design is Claude Design running inside Valet: a chat-driven authoring surface for polished visual work (pages, slides, one-pagers, résumés, wireframes). The artifact is a file in the codebase, the design system is code the team already ships, and the handoff to coding is a child session against the same artifact. This plan sequences the implementation in 14 dependency-ordered milestones, from schema to integration tests.

## Milestones

### M0: Schema Migration + Drizzle Schema

Add three new tables to `packages/api/migrations/pg/0000_app.sql` and two new columns to `agent_sessions`. Update the Drizzle schema in `packages/api/src/schema/index.ts`.

**Deliverables:**
- `design_artifacts` table with `session_id` UNIQUE foreign key.
- `design_artifact_revisions` table with composite unique key `(artifact_id, revision)`.
- `design_comments` table with `vdid`, `thread_message_id` anchor.
- `agent_sessions.kind` (default `'code'`) and `agent_sessions.template` (nullable). (`purpose` in the draft; renamed — the engine schema already owns `purpose`.)
- Repair statements in `addColumnsMissingFromAppliedMigrations` for every new table and column (in-place `0000` edits never reach an already-migrated database without them).
- Drizzle row interfaces and `rawTo*Row` mappers.
- **Action required:** `rm -rf ~/.valet/pg` to pick up the schema.

**Acceptance:**
- `pnpm typecheck` passes.
- `make dev-local` boots with clean schema.
- Schema inspection confirms all tables and columns present.

### M1: Plugin Scaffolding

Create `packages/plugin-design/` with standard plugin structure.

**Deliverables:**
- `plugin.yaml` with `v2: true`, `enabled: false` (parking it until M4).
- `package.json` with `"valet": { "plugin": "./dist/plugin.js" }`, `@valet/engine` dep, workspace reference scripts (`build`, `test`, etc.).
- `tsconfig.json` referencing `@valet/shared`, `@valet/engine`, `@valet/sdk`.
- `src/plugin.ts` exporting a `ValetPlugin` manifest with empty actions array (to be filled in M4+).
- `templates/` directory structure: `blank/`, `document/`, `slides/`, `wireframe/`, `resume/`, `html-email/` (six for v1 per spec Decision 7).
- Each template has placeholder `starter.dc.html` (minimal valid `.dc.html`) and `prompt.md`.

**Acceptance:**
- `pnpm install` resolves all deps.
- `pnpm typecheck --filter @valet/plugin-design` passes.
- Plugin is discoverable in bundled registry (add to root `tsconfig.json` references and `packages/api/package.json` deps; run `make generate-registries`).

### M2: DesignSystemProvider Port + Codebase Impl

Define the `DesignSystemProvider` port interface and implement the `codebase` variant.

**Deliverables:**
- `packages/plugin-design/src/design-system/provider.ts`: `DesignSystemProvider` interface (load → `DesignSystem` with tokens map and component index).
- `packages/plugin-design/src/design-system/codebase-provider.ts`: `CodebaseDesignSystemProvider` reads `design-tokens.json` and `components.index.json` from repo root (via `github.read_repo_file` action).
- Error handling: missing files return empty tokens map (graceful degradation).
- Tests: unit tests mocking repo reads, asserting token extraction.

**Acceptance:**
- Provider loads from a fixture repository with `design-tokens.json`.
- Token names and values extracted correctly.
- Missing file does not throw; returns empty system.
- `pnpm test` green for design-system tests.

### M3: Artifact Revision Write Path + WebSocket Event

Implement the core mutation path: write new revisions, emit WebSocket events.

**Deliverables:**
- `packages/api/src/services/design-artifacts.ts`: service layer with `createArtifact`, `updateArtifact`, `getArtifact`, `getRevision`, `listRevisions`, `revertToRevision`.
- Each mutation writes a new `design_artifact_revisions` row with auto-incremented revision id (format `r-NNN`).
- `EventStream` integration: emit `design.artifact.updated` event with new revision id and change summary.
- WebSocket frame type `design.artifact.updated` defined in `packages/api/src/types/wire.ts`.
- Engine integration: `ToolContext.requestDecision` support for design-specific gates (export manifest, import confirmations).

**Acceptance:**
- Create an artifact, update it, verify revision rows in database.
- WebSocket client receives `design.artifact.updated` frame with correct payload.
- Revision history queryable and revert succeeds.
- `make smoke-session` includes a design artifact mutation.

### M4: Tools: design_edit, design_render_token, design_comment_resolve + design session minting

Implement the core design tools. Per spec §Tools these are engine `ToolDef`s built API-side (the `mem_*` pattern), attached only to `kind='design'` sessions, calling internal design routes over `ctx.config.apiBaseUrl` + internal token. Session creation is REST, not a tool.

**Deliverables:**
- `packages/api/src/engine/design-tools.ts`: `design_edit(kind, content, summary?)`, `design_render_token(token_name)`, `design_comment_resolve(comment_id)` ToolDefs with TypeBox schemas.
- `POST /api/sessions` accepts `kind` + `template`; when `kind='design'` it seeds revision `r-001` from the template starter in the same transaction.
- Host wiring: `buildSession` attaches design tools and `toolConfig.apiBaseUrl`/`internalToken` when the session row has `kind='design'`.
- `.dc.html` validation and `data-vdid` recompute live in `@valet/plugin-design` library code imported by the internal route handlers.

**Acceptance:**
- `POST /api/sessions` with `kind='design'` mints session + `r-001` artifact.
- `design_edit` mutates artifact and writes revision.
- `design_render_token` returns token value from design system.
- `design_comment_resolve` marks comment resolved in database.
- `pnpm --filter @valet/api test design` and `pnpm --filter @valet/plugin-design test` green.

### M5: Client Renderer + `/sessions/$id/design` Route

Implement the client-side artifact rendering and the canvas route.

**Deliverables:**
- `packages/web/src/lib/design/renderer.ts`: `DesignRenderer` component reads `.dc.html` bytes, sanitizes HTML, parses with whitelist, mounts in shadow root under strict CSP.
- `packages/web/src/routes/sessions/$id/design.tsx`: layout with thread (left), canvas (center), slide-strip (left sidebar if template=slides), speaker-notes pane (bottom if slides).
- Real-time updates via WebSocket subscription to `design.artifact.updated` events.
- Revert UI: hovering over thread message shows "Edited Deck.dc.html" badge with revert link.
- Zoom slider, comment toggle, edit toggle, Present (full-screen) button in top bar.
- TanStack Router + Query integration (thread state, artifact state keyed by session id).

**Acceptance:**
- Navigate to `/sessions/:id/design` for a design session, canvas renders artifact within 1 second.
- WebSocket `design.artifact.updated` triggers canvas re-render.
- Revert link calls `design_revert` (tool to be implemented), canvas updates.
- Zoom slider changes render scale.
- `make e2e --only design-client` passes.

### M6: Project Hub Route `/design` + Template Grid + Starter Files

Implement the landing page and template picker.

**Deliverables:**
- `packages/web/src/routes/design.tsx`: `/design` route with template grid, recent projects list, "What should we create?" prompt input.
- Template cards visual grid (6 cards: blank, document, slides, wireframe, resume, html-email).
- Clicking a template card sends `POST /api/sessions` with `kind='design'` + template, redirects to the new session's canvas route.
- Recent projects list loads from `GET /api/sessions?kind=design`, filters by template.
- Design system picker: dropdown to select team's design system (loads from `DesignSystemProvider`; v1 is codebase-only).
- Model picker: dropdown to select text/vision model.
- Integration with existing nav and session switcher.
- Template starter files finalized in `packages/plugin-design/templates/*/starter.dc.html` (minimal but visually distinct per template).

**Acceptance:**
- `/design` loads and displays template grid.
- Clicking a template creates a session, redirects to `/sessions/:id/design`.
- Recent projects list appears below template grid.
- Design system and model pickers functional (test with fixtures).
- `make e2e --only design-hub` passes.

### M7: Sandbox Image Variant `Dockerfile.sandbox-design`

Extend the base sandbox image to include design-export dependencies.

**Deliverables:**
- `docker/Dockerfile.sandbox-design`: extends `Dockerfile.sandbox-k8s`.
- Adds `@marp-team/marp-cli` via npm.
- Adds Chromium (via apt package).
- Adds `google-api-nodejs-client` for Slides integration.
- Egress policy applied during export: denies link-local and cluster-internal IP ranges.
- `VALET_SANDBOX_IMAGE` env var can point to this image for local testing.

**Acceptance:**
- Image builds without error.
- Image contains `marp-cli`, Chromium, and Google client lib.
- `make smoke-session` with this image boots cleanly.

### M8: Import Tools: design_import_marp, design_import_gslides, design_import_image

Implement the three import paths.

**Deliverables:**
- `packages/plugin-design/src/tools/import-marp.ts`: reads `.md` file from workspace, passes to `DeckSerializer.deserialize(bytes, 'marp')`, writes artifact revision, emits `design.artifact.imported`.
- `packages/plugin-design/src/tools/import-gslides.ts`: calls `slides.get_presentation` action, transpiles element tree to `.dc.html`, writes `objectId ↔ data-vdid` mapping, writes artifact revision.
- `packages/plugin-design/src/tools/import-image.ts`: reads image from workspace or URL, embeds as data URL or inlines SVG, writes artifact revision.
- All three registered in plugin manifest.
- `import-report.md` generated for Marp and Slides imports, describing unmapped features.
- First-use decision gates for Marp and Slides (user confirms source file/presentation).

**Acceptance:**
- `design_import_marp` with a test `.md` file converts to artifact within 5 seconds.
- `design_import_gslides` with a test Slides presentation converts and writes mapping.
- `design_import_image` embeds image in artifact.
- Import reports generated and present in metadata.
- `pnpm test --filter @valet/plugin-design` green for import tests.

### M9: Google Slides Action Group on plugin-google-workspace

Add the `slides.*` action group to `plugin-google-workspace`.

**Deliverables:**
- `packages/plugin-google-workspace/src/tools/slides-get.ts`: `slides.get_presentation(presentation_id)` action. Calls Slides API, returns element tree and metadata.
- `packages/plugin-google-workspace/src/tools/slides-create.ts`: `slides.create_presentation(title)` action. Creates new presentation, returns id and URL.
- `packages/plugin-google-workspace/src/tools/slides-batch-update.ts`: `slides.batch_update(presentation_id, mutations)` action. Chunks mutations per slide, applies with revision fencing.
- OAuth scope: `drive.file` only.
- Error handling: partial writes surface resumable `export_state`.
- Registered in plugin manifest under `service: 'google'`.

**Acceptance:**
- `list_tools` includes `slides.*` actions.
- `slides.get_presentation` fetches a test presentation.
- `slides.create_presentation` creates a new presentation.
- `slides.batch_update` applies mutations with revision fencing.
- `make smoke-orchestrator` includes a google.slides action call.

### M10: DeckSerializer Port + Marp and Gslides Impls

Implement the serializer port and converters.

**Deliverables:**
- `packages/plugin-design/src/serializers/serializer.ts`: `DeckSerializer` interface with `deserialize(bytes, format)` and `serialize(bytes, format)`.
- `packages/plugin-design/src/serializers/marp.ts`: uses `@marp-team/marp-core` to parse Markdown into HTML, wraps as `.dc.html`. Reverse: extracts text and structure, emits Markdown.
- `packages/plugin-design/src/serializers/gslides.ts`: calls `slides.get_presentation`, transpiles Slides element tree to `.dc.html` (mapping table from Appendix A of spec). Preserves `objectId` as `data-vdid`. Reverse: transpiles `.dc.html` to `batchUpdate` commands.
- `objectId ↔ data-vdid` mapping stored in artifact metadata for later reference.
- Round-trip testing: import → export → import, verify content survives.

**Acceptance:**
- Marp serializer converts test `.md` file to `.dc.html`, then back to Markdown, preserving structure.
- Gslides serializer fetches a test presentation, converts to `.dc.html`, converts back, verifies round-trip.
- `data-vdid`s survive round-trip.
- `pnpm test --filter @valet/plugin-design` green for serializer tests.

### M11: Export Tools: design_export (all 4 formats)

Implement the unified export tool with sandbox delegation for PDF/PPTX/Slides.

**Deliverables:**
- `packages/plugin-design/src/tools/export.ts`: `design_export(format, filename?)` action. Routes per format:
  - `html`: return artifact bytes directly.
  - `pdf`: delegate to sandbox, run `marp-cli` against `file://` input, return download URL.
  - `pptx`: delegate to sandbox, run `marp-cli` with PPTX output, return download URL.
  - `gslides`: delegate to sandbox, transpile `.dc.html` to `batchUpdate` commands, call `slides.batch_update`, return presentation URL.
- `ExportManifest` decision gate before any export: user approves every referenced file.
- First-use gate for Gslides export: user confirms target file creation and OAuth scope.
- Chunking per slide for Gslides exports with `writeControl.requiredRevisionId` fencing.
- Signed download URLs for HTML/PDF/PPTX, valid for 1 hour.
- Sandbox egress policy restricts to `file://` for export operations.

**Acceptance:**
- `design_export(html)` returns artifact bytes.
- `design_export(pdf)` and `design_export(pptx)` return signed download URLs within 10 seconds.
- `design_export(gslides)` creates presentation and returns URL.
- `ExportManifest` gate surfaces before export.
- First-use gate for Gslides.
- `make e2e --only design-export` passes.

### M12: Handoff Tool: design_handoff

Implement the child-session spawn for code implementation.

**Deliverables:**
- `packages/plugin-design/src/tools/handoff.ts`: `design_handoff(implementation_task?)` ToolDef. Gets artifact's current revision, commits to session's git repo (if set), captures commit hash as `startRef`, spawns child session with `kind='code'`, passes design thread as read-only tool, returns child session id.
- Child session inherits parent's principal (owner_type, owner_id).
- Child session title auto-filled: `<parent title> → code`.
- Thread transcript from parent rendered as a `design.brief` read-only tool in child.
- No sandbox state copied; child starts fresh.

**Acceptance:**
- `design_handoff` from design session spawns child.
- Child session has correct `startRef` pointing to artifact's git commit.
- Child session title reflects handoff.
- Design brief available in child's thread.
- `make smoke-orchestrator` includes a design handoff scenario.

### M13: Integration Tests: Scenarios A, B, C

Implement three acceptance-test suites covering the three scenarios from the spec.

**Deliverables:**
- `packages/api/src/integration/design-acceptance.test.ts`: Scenarios A and B at the API level — create/seed, internal edit seam, events, revert, comments, fences. (Repo convention puts integration tests in the package's vitest tree, not a root `tests/` dir.)
- Scenario C's serializer round trip: `packages/plugin-design/src/lib/gslides.test.ts` + fenced-transport tests in `packages/api/src/engine/design-tools.test.ts`. The live Google round trip needs a connected credential and stays out of CI.
- Each test: API-level assertions (rows created, WebSocket events emitted, revisions written).
- No UI automation; test the JSON flow end-to-end.
- Kill-mid-turn scenario: test one export in progress, kill sandbox, restart, verify export-state is resumable or gracefully fails.

**Acceptance:**
- All three test suites green.
- `make e2e --only design` passes all three.
- Kill-mid-turn test verifies recovery.

### M14: Registry Regen, Typecheck Sweep, E2E Scorecard

Final integration and validation.

**Deliverables:**
- `make generate-registries`: plugin added to bundled registry.
- Plugin enabled in `plugin.yaml` (`enabled: true`).
- `pnpm typecheck`: all packages green.
- `make e2e`: full scorecard including design suites.
- `/design` route live in web app.
- `/sessions/$id/design` route live.
- Share link works (returns read-only view with token subset).
- All tools callable and logged in audit trail.

**Acceptance:**
- `pnpm typecheck` passes.
- `make e2e --only design` all green.
- `make e2e --only design,typecheck` confirms no regressions.
- Web app boots, `/design` accessible, template grid visible.
- One end-to-end user flow (create → edit → export → handoff) succeeds.

## Cross-Cutting Risks and Call-Outs

1. **Node 20 vs. 22 trap:** `@marp-team/marp-cli` and `ws` modules may trigger Node version issues. Verify under Node 22.

2. **Migration edit-in-place + `rm -rf ~/.valet/pg`:** Schema changes are applied in M0. Any developer using the stack must delete their local PGlite before running `make dev-local` again.

3. **Sandbox image reference format:** For Kubernetes backend, sandbox images must be registry-hosted (pushed to the bundled registry / NodePort pull host). The `docker/Dockerfile.sandbox-design` is built the same way as other base images; `VALET_SANDBOX_IMAGE` env var selects it in dev.

4. **Design system provider token set:** Deriving the token subset for shared links (threat mitigation #2) requires scanning the artifact bytes for CSS `var(--*)` references and component names. False negatives (missing tokens) degrade styling; false positives (over-export) are acceptable.

5. **Revision id collision:** Revision ids are auto-incremented integers formatted as `r-NNN`. Collision is impossible within one artifact; safe to use as version keys.

6. **WebSocket frame size:** artifact bytes in `design.artifact.updated` event may exceed typical WebSocket frame limits. Send only the revision id and metadata; client fetches full bytes via REST if needed.

7. **Chromium sandbox egress:** the sandbox image includes Chromium for PDF export. Egress policy must be enforced at tool invocation time (rule applied only during `design_export` with `format=pdf|pptx`), not globally on all design sandboxes.

## Not in Plan

- OAuth connect flow for Google Slides (platform/login spec owns this).
- Real-time collaboration on shared design sessions (future phase).
- Design-system authoring UI (v1 reads from codebase only).
- Figma/Sketch import (requires separate SDKs or reverse-engineering).
- Bundled resources in skills (skill sync spec incomplete on this).
- Org-wide design templates (admin provisioning system not yet built).
- Workflow integration (workflow spec complete; design as a workflow step lands in a separate enhancement).
