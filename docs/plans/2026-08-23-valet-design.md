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
- `agent_sessions.purpose` (default `'code'`) and `agent_sessions.template` (nullable).
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
- `templates/` directory structure: `document/`, `slides/`, `wireframe/`, `mobile-app/`, `résumé/`, `html-email/`, `color-type/`, `ui-mockup/`, `3d-object/`, `research/`, `animation/`, `blank/`.
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

### M4: Tools: design.create, design.edit, design.render.token, design.comment.resolve

Implement the four core design tools. These are `PluginAction`s registered in the plugin manifest.

**Deliverables:**
- `packages/plugin-design/src/tools/create.ts`: `design.create(template, prompt?)` action. Reads template starter, optionally refines via LLM, writes initial artifact.
- `packages/plugin-design/src/tools/edit.ts`: `design.edit(kind, content, summary?)` action. Parses artifact, applies patch or rewrite, recomputes `data-vdid`s, writes revision.
- `packages/plugin-design/src/tools/render-token.ts`: `design.render.token(token_name)` action. Loads design system, looks up token.
- `packages/plugin-design/src/tools/comment-resolve.ts`: `design.comment.resolve(vdid, comment_id)` action. Marks design comment as resolved.
- All four registered in plugin manifest as `ActionPlugin[]` with TypeBox schemas.
- HTML sanitizer library chosen (likely `DOMPurify` or a whitelist parser) and integrated in edit path.
- Artifact validation: `.dc.html` format check (meta block parseable, version recognized).

**Acceptance:**
- `design.create` with any template mints a new artifact and session within 3 seconds.
- `design.edit` mutates artifact and writes revision.
- `design.render.token` returns token value from design system.
- `design.comment.resolve` marks comment resolved in database.
- `pnpm test --filter @valet/plugin-design` green for all tool tests.
- `make smoke-orchestrator` includes a design create/edit round trip.

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
- Revert link calls `design.revert` (tool to be implemented), canvas updates.
- Zoom slider changes render scale.
- `make e2e --only design-client` passes.

### M6: Project Hub Route `/design` + Template Grid + Starter Files

Implement the landing page and template picker.

**Deliverables:**
- `packages/web/src/routes/design.tsx`: `/design` route with template grid, recent projects list, "What should we create?" prompt input.
- Template cards visual grid (12 cards: blank, document, slides, wireframe, mobile-app, résumé, html-email, color-type, ui-mockup, 3d-object, research, animation).
- Clicking a template card calls `design.create(template)`, redirects to the new session's canvas route.
- Recent projects list loads from `GET /api/sessions?purpose=design`, paginates, filters by template.
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

### M8: Import Tools: design.import.marp, design.import.gslides, design.import.image

Implement the three import paths.

**Deliverables:**
- `packages/plugin-design/src/tools/import-marp.ts`: reads `.md` file from workspace, passes to `DeckSerializer.deserialize(bytes, 'marp')`, writes artifact revision, emits `design.artifact.imported`.
- `packages/plugin-design/src/tools/import-gslides.ts`: calls `google.slides.get` action, transpiles element tree to `.dc.html`, writes `objectId ↔ data-vdid` mapping, writes artifact revision.
- `packages/plugin-design/src/tools/import-image.ts`: reads image from workspace or URL, embeds as data URL or inlines SVG, writes artifact revision.
- All three registered in plugin manifest.
- `import-report.md` generated for Marp and Slides imports, describing unmapped features.
- First-use decision gates for Marp and Slides (user confirms source file/presentation).

**Acceptance:**
- `design.import.marp` with a test `.md` file converts to artifact within 5 seconds.
- `design.import.gslides` with a test Slides presentation converts and writes mapping.
- `design.import.image` embeds image in artifact.
- Import reports generated and present in metadata.
- `pnpm test --filter @valet/plugin-design` green for import tests.

### M9: Google Slides Action Group on plugin-google-workspace

Add the `google.slides.*` action group to `plugin-google-workspace`.

**Deliverables:**
- `packages/plugin-google-workspace/src/tools/slides-get.ts`: `google.slides.get(presentation_id)` action. Calls Slides API, returns element tree and metadata.
- `packages/plugin-google-workspace/src/tools/slides-create.ts`: `google.slides.create(title)` action. Creates new presentation, returns id and URL.
- `packages/plugin-google-workspace/src/tools/slides-batch-update.ts`: `google.slides.batch-update(presentation_id, mutations)` action. Chunks mutations per slide, applies with revision fencing.
- OAuth scope: `drive.file` only.
- Error handling: partial writes surface resumable `export_state`.
- Registered in plugin manifest under `service: 'google'`.

**Acceptance:**
- `list_tools` includes `google.slides.*` actions.
- `google.slides.get` fetches a test presentation.
- `google.slides.create` creates a new presentation.
- `google.slides.batch-update` applies mutations with revision fencing.
- `make smoke-orchestrator` includes a google.slides action call.

### M10: DeckSerializer Port + Marp and Gslides Impls

Implement the serializer port and converters.

**Deliverables:**
- `packages/plugin-design/src/serializers/serializer.ts`: `DeckSerializer` interface with `deserialize(bytes, format)` and `serialize(bytes, format)`.
- `packages/plugin-design/src/serializers/marp.ts`: uses `@marp-team/marp-core` to parse Markdown into HTML, wraps as `.dc.html`. Reverse: extracts text and structure, emits Markdown.
- `packages/plugin-design/src/serializers/gslides.ts`: calls `google.slides.get`, transpiles Slides element tree to `.dc.html` (mapping table from Appendix A of spec). Preserves `objectId` as `data-vdid`. Reverse: transpiles `.dc.html` to `batchUpdate` commands.
- `objectId ↔ data-vdid` mapping stored in artifact metadata for later reference.
- Round-trip testing: import → export → import, verify content survives.

**Acceptance:**
- Marp serializer converts test `.md` file to `.dc.html`, then back to Markdown, preserving structure.
- Gslides serializer fetches a test presentation, converts to `.dc.html`, converts back, verifies round-trip.
- `data-vdid`s survive round-trip.
- `pnpm test --filter @valet/plugin-design` green for serializer tests.

### M11: Export Tools: design.export (all 4 formats)

Implement the unified export tool with sandbox delegation for PDF/PPTX/Slides.

**Deliverables:**
- `packages/plugin-design/src/tools/export.ts`: `design.export(format, filename?)` action. Routes per format:
  - `html`: return artifact bytes directly.
  - `pdf`: delegate to sandbox, run `marp-cli` against `file://` input, return download URL.
  - `pptx`: delegate to sandbox, run `marp-cli` with PPTX output, return download URL.
  - `gslides`: delegate to sandbox, transpile `.dc.html` to `batchUpdate` commands, call `google.slides.batch-update`, return presentation URL.
- `ExportManifest` decision gate before any export: user approves every referenced file.
- First-use gate for Gslides export: user confirms target file creation and OAuth scope.
- Chunking per slide for Gslides exports with `writeControl.requiredRevisionId` fencing.
- Signed download URLs for HTML/PDF/PPTX, valid for 1 hour.
- Sandbox egress policy restricts to `file://` for export operations.

**Acceptance:**
- `design.export(html)` returns artifact bytes.
- `design.export(pdf)` and `design.export(pptx)` return signed download URLs within 10 seconds.
- `design.export(gslides)` creates presentation and returns URL.
- `ExportManifest` gate surfaces before export.
- First-use gate for Gslides.
- `make e2e --only design-export` passes.

### M12: Handoff Tool: design.handoff

Implement the child-session spawn for code implementation.

**Deliverables:**
- `packages/plugin-design/src/tools/handoff.ts`: `design.handoff(implementation_task?)` action. Gets artifact's current revision, commits to session's git repo (if set), captures commit hash as `startRef`, spawns child session with `purpose='code'`, passes design thread as read-only tool, returns child session id.
- Child session inherits parent's principal (owner_type, owner_id).
- Child session title auto-filled: `<parent title> → code`.
- Thread transcript from parent rendered as a `design.brief` read-only tool in child.
- No sandbox state copied; child starts fresh.

**Acceptance:**
- `design.handoff` from design session spawns child.
- Child session has correct `startRef` pointing to artifact's git commit.
- Child session title reflects handoff.
- Design brief available in child's thread.
- `make smoke-orchestrator` includes a design handoff scenario.

### M13: Integration Tests: Scenarios A, B, C

Implement three acceptance-test suites covering the three scenarios from the spec.

**Deliverables:**
- `tests/design/acceptance/document-page.test.ts`: Scenario A — create document, edit, revert, share, export PDF, handoff.
- `tests/design/acceptance/slide-deck.test.ts`: Scenario B — create slides, edit individual slide, insert slide, export PDF and PPTX.
- `tests/design/acceptance/gslides-roundtrip.test.ts`: Scenario C — create slides, export to Gslides, external edit, import back, handoff. Skipped if `plugin-google-workspace` not connected.
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

7. **Chromium sandbox egress:** the sandbox image includes Chromium for PDF export. Egress policy must be enforced at tool invocation time (rule applied only during `design.export` with `format=pdf|pptx`), not globally on all design sandboxes.

## Not in Plan

- OAuth connect flow for Google Slides (platform/login spec owns this).
- Real-time collaboration on shared design sessions (future phase).
- Design-system authoring UI (v1 reads from codebase only).
- Figma/Sketch import (requires separate SDKs or reverse-engineering).
- Bundled resources in skills (skill sync spec incomplete on this).
- Org-wide design templates (admin provisioning system not yet built).
- Workflow integration (workflow spec complete; design as a workflow step lands in a separate enhancement).
