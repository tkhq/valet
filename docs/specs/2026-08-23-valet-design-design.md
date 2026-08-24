# Valet Design — Design Spec

**Date:** 2026-08-23
**Status:** accepted — open questions resolved 2026-08-23
**Owner:** Applied AI

## Summary

Valet Design is Claude Design running inside Valet: a chat-driven authoring surface for polished visual work (pages, slides, one-pagers, résumés, wireframes), where the artifact is a real file the user's org owns, the design system is the code they already ship, and the handoff to Claude Code is just spawning a Valet coding child against the same file. The artifact renders on the client without a preview server, sits in the database as the source of truth, and exports to HTML, PDF, PPTX, and Google Slides with full fidelity control.

## Motivation

Claude Design (Anthropic Labs, 2026-04-17) demonstrates a new shape for visual work: chat drives iterative refinement, the artifact is a durable file, the interface merges transcript and canvas in one view, and changes are versionable. Valet Design rips off this experience for Turnkey users. The key difference: in Valet Design, the artifact is code from the first prompt — a file in the codebase, a design system borrowed from what the team already imports, and a seamless handoff to coding work in the same session. This dissolves the classic handoff gap between design and implementation: a designer's artifact is immediately a programmer's starting point.

The thesis: **design and code share one workspace, one policy engine, and one audit trail**. This is a property Claude Design as a standalone product cannot claim. In Valet Design, a design is code.

## The Move: Render in the Client

Claude Design proxies a preview URL served from the sandbox. Valet Design does not. The web client fetches the artifact bytes — a self-contained `.dc.html` document — sanitizes it with DOMPurify, renders it to a DOM under a shadow root, and shows it directly to the user. No iframe, no sandbox involvement. The artifact is authoritative; the client is a viewer.

This move changes two key properties:

1. **Instant rendering.** The UI does not wait for the sandbox to build or boot. Artifact revisions render in milliseconds.
2. **No side channels.** The artifact cannot exfiltrate the design system or any other credential — it is only bytes the user's browser already has. A shared link delivers only a rendered view, never the full design system.

Mapping to Valet v2 primitives:

| Claude Design | Valet Design |
|---|---|
| Standalone application | App session with `kind='design'` |
| Artifact + version history | `DesignArtifact` row holding current bytes + `design_artifact_revisions` history |
| Canvas | React component in web rendering artifact bytes to DOM |
| Every turn wraps a tool-call block | Session's thread. Tools are design-specific. |
| Edit → new checkpoint | Durable submission with `parentRevision` fence. New revision written on every mutating turn. |
| Inline element comments | Anchored thread messages carrying `data-vdid` (element addressing) |
| Template gallery | Hardcoded set of starter files shipped in the plugin |
| Design system → app library | `DesignSystemProvider` port with `codebase` impl only |
| Export to PDF/PPTX | `marp-cli` run against `file://` inputs in sandbox |
| Export to Google Slides | Transpiler + chunked `batchUpdate` via Slides API |
| Handoff to implementation | `design_handoff` spawns a child session whose `startRef` is the artifact's git commit |

## Architecture Overview

### Mental Model: Session with an Artifact

What Valet already knows about sessions ports over. New things:

1. **Artifact as a first-class column.** A `DesignArtifact` row is attached to the session, holding the current bytes plus a per-revision history. Every mutating turn writes a new revision and emits a `design.artifact.updated` event on the session's WebSocket.

2. **Client-side renderer contract.** `DesignRenderer` is a browser-side port. Takes artifact bytes plus a `RenderContext` (design system tokens, active slide, comment overlays) and renders to DOM. v1: `html-doc`.

3. **Element addressing.** `data-vdid`: content-hashed from stable node attributes (tag, role, first 32 bytes of text). Survives imports and round-trips.

4. **Design system port.** `DesignSystemProvider`, v1 `codebase` only. Extracts design tokens from source files the customer's app imports.

5. **Deck serialization port.** `DeckSerializer`, v1: `marp` and `gslides`. The `.dc.html` is canonical; serializers are lossy views.

6. **Project hub route.** `/design` landing page: template picker, recent projects, "What should we create?"

## Data Model

All app-side. Edit `packages/api/migrations/pg/0000_app.sql` in place. Every column and table added to the already-applied `0000` migration must also get a repair statement in `addColumnsMissingFromAppliedMigrations` (`packages/api/src/lib/drizzle.ts`), or a deployed database never picks up the change. When the schema changes locally, delete `~/.valet/pg` and restart the dev stack (`make dev-local`).

Storage follows the `artifacts` table precedent: bytes live inline in a `text` column, timestamps are `bigint` epoch milliseconds. There is no `storage_ref` indirection and no blob store in v1. `design_edit` rejects artifacts over 2 MB; large embedded images are the only way to get near that.

### New Tables

```sql
CREATE TABLE "design_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "current_revision" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "design_artifacts_session_unique" ON "design_artifacts" ("session_id");

CREATE TABLE "design_artifact_revisions" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL,
  "revision" text NOT NULL,
  "turn_id" text,
  "summary" text DEFAULT '' NOT NULL,
  "content" text NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "design_artifact_revisions_unique" ON "design_artifact_revisions" ("artifact_id", "revision");

CREATE TABLE "design_comments" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL,
  "revision" text NOT NULL,
  "vdid" text NOT NULL,
  "body" text NOT NULL,
  "author_user_id" text NOT NULL,
  "resolved_at" bigint,
  "created_at" bigint NOT NULL
);
CREATE INDEX "design_comments_artifact" ON "design_comments" ("artifact_id");
```

Foreign keys are by id-string convention, not SQL constraints — `agent_sessions` itself declares no FK edges, and `turn_id` points into the engine schema, which the app schema never references with constraints.

### Column Changes to `agent_sessions`

Add two columns:

```sql
ALTER TABLE "agent_sessions" ADD COLUMN "kind" text DEFAULT 'code' NOT NULL;
ALTER TABLE "agent_sessions" ADD COLUMN "template" text;
```

Valid values for `kind`: `'code'` (default, existing sessions), `'design'`.
`template`: nullable string, e.g., `'slides'`, `'document'`, `'wireframe'`.

The draft named this column `purpose`. The engine schema already has `engine_sessions.purpose` (`interactive` / `orchestrator` / `workflow` / `child`) — a second `purpose` column with a different value set in the same database is a trap, so the app column is `kind`. One name for one thing: "purpose" is the engine lifecycle role; "kind" is which authoring surface the session drives.

### Drizzle Schema

Update `packages/api/src/schema/index.ts` with tables `designArtifacts`, `designArtifactRevisions`, `designComments` and the `kind` and `template` columns on `agentSessions`. Row types come from `$inferSelect`, same as every other app table.

## The Artifact Format: `.dc.html`

Every artifact is a single self-contained HTML document with a well-defined header, element addressing, and slide structure.

### Schema Versioning

The `<head>` carries a meta tag that names the format version and the template:

```html
<meta name="valet-design" content="v=1; template=slides">
```

The renderer refuses documents with unknown `v=` values. This allows breaking format changes to land cleanly; a v2 format will have a v2 handler. **Decision, open to review challenge:** version in the meta tag rather than a URL scheme or JSON block.

### Element Addressing: `data-vdid`

Every addressable element carries a `data-vdid` attribute. The id is a sha256 hash (first 16 hex chars, truncated) of:

- Element tag name
- Element role (aria-role if present)
- First 32 bytes of element text (or empty string if text-less)

Example:

```html
<h2 data-vdid="a3c7f2e8b1d4a6c9">Agenda</h2>
<section data-vdid="f7e2d1c4a9b3e8f6"><!-- slide 2 --></section>
```

Collision handling: if a hash collides with an existing element, append `_1`, `_2`, etc. Every revision emits a `vdid_stability_report` (JSON at the artifact's end, in a comment) that lists hash collisions and regenerations so collisions are auditable.

### Slides as Sections

A deck artifact wraps each slide in a `<section>` element. Speaker notes live in an `<aside>` child of that section.

```html
<section data-vdid="...">
  <h1>Slide Title</h1>
  <p>Slide content</p>
  <aside>Speaker notes for this slide.</aside>
</section>
```

Non-slide templates (document, wireframe) do not use sections; they are simply HTML.

### Meta Block

A JSON object at the end of the document (in an HTML comment) carries metadata:

```html
<!-- valet-design:meta
{
  "v": 1,
  "template": "slides",
  "created_at": "2026-08-23T12:34:56Z",
  "created_by": "user:alice",
  "revision": "r-001",
  "design_system_provider": "codebase",
  "import_reports": [
    { "type": "marp", "report": "import-report-r-000.md" }
  ]
}
-->
```

## Ports

Ports are TypeScript-shaped interface contracts that implementations satisfy. Implementations ship as code in the plugin.

### DesignRenderer

Browser-side, mounted in the web app. Reads artifact bytes and a context, produces a DOM.

```typescript
interface DesignRenderer {
  /**
   * Render artifact bytes into a React DOM.
   * @param bytes - the .dc.html file bytes
   * @param context - render options
   * @returns React component
   */
  render(bytes: Uint8Array, context: RenderContext): ReactNode;
}

interface RenderContext {
  /** Design system tokens, keyed by token name. */
  designSystemTokens?: Record<string, string>;
  /** Active slide index (0-based). Only relevant for `template=slides`. */
  activeSlideIndex?: number;
  /** Comment overlay annotations. */
  commentOverlays?: CommentOverlay[];
  /** Whether to show edit borders. */
  showEditBorders?: boolean;
}

interface CommentOverlay {
  vdid: string;
  threadId: string;
  resolvedAt?: Date;
  count: number; // unresolved comment count
}
```

v1 implementation: `html-doc` renderer. Parses the HTML with a whitelist (strip `<script>`, strip `on*` attributes at parse time). Mounts in a shadow root. Applies strict CSP: `default-src 'none'; img-src data:; style-src 'unsafe-inline'`. No event handling except navigation.

### DesignSystemProvider

Extracts design tokens and component references from a team's codebase.

```typescript
interface DesignSystemProvider {
  /**
   * Load the design system from the codebase.
   * @param repo - repository reference
   * @param credentials - to access the repository
   * @returns tokens map and component index
   */
  load(
    repo: RepositoryReference,
    credentials: Record<string, string>
  ): Promise<DesignSystem>;
}

interface DesignSystem {
  /** CSS custom-property map (e.g., { "--color-primary": "#0066cc" }). */
  tokens: Record<string, string>;
  /** Component name → TypeScript export path map. */
  components: Record<string, string>;
}

interface RepositoryReference {
  owner: string;
  repo: string;
  branch: string;
}
```

v1 implementation: `codebase` provider. Reads the customer's published `design-tokens.json` and `components.index.json` from the repository root, or auto-discovers `.css` files with `:root { --* }` rules.

### DeckSerializer

Converts between `.dc.html` and external formats (Marp, Google Slides).

```typescript
interface DeckSerializer {
  /**
   * Deserialize an external format into .dc.html bytes.
   * @param bytes - source format bytes
   * @param format - 'marp' | 'gslides'
   * @returns .dc.html bytes
   */
  deserialize(bytes: Uint8Array, format: string): Promise<Uint8Array>;

  /**
   * Serialize .dc.html into an external format.
   * @param bytes - .dc.html bytes
   * @param format - 'marp' | 'gslides'
   * @returns formatted bytes
   */
  serialize(bytes: Uint8Array, format: string): Promise<Uint8Array>;
}
```

v1 implementations:
- `marp`: uses `@marp-team/marp-core` to parse Markdown, converts to `.dc.html`. Reverse: extracts text and structure, emits Markdown.
- `gslides`: calls Google Slides API to fetch presentation, transpiles element tree to `.dc.html`. Reverse: transpiles `.dc.html` to Slides `batchUpdate` commands.

## Tools

Design tools are engine `ToolDef`s named `design_*` (the Anthropic tool-name charset forbids dots), built in `packages/api/src/engine/design-tools.ts` and attached only to sessions with `kind='design'`. This follows the `mem_*` precedent (`packages/api/src/orchestrator/memory-tools.ts`): the tool's `execute` calls internal design routes over `ctx.config.apiBaseUrl` with the `x-valet-internal` token, never a service module directly. The HTTP seam is the portability contract. Plugin actions were the draft's shape, but a `PluginActionContext` has no database handle and plugin actions surface in every session — design tools are session-kind-scoped and database-backed, which is exactly what per-session `ToolDef`s are for.

`packages/plugin-design` still exists as a plugin: it ships the design skill, the template starter files, and the pure library code (vdid computation, `.dc.html` parse/validate, serializers) that the API imports.

A tool carries approval routing through the session's decision-gate machinery (`ctx.requestDecision`).

### Session creation (REST, not a tool)

The draft defined a `design.create` tool. Creation is not a tool: the hub UI mints sessions, and session minting is a REST concern. `POST /api/sessions` accepts `kind: 'design'` and `template: <name>`; when `kind='design'`, the route seeds the initial artifact:

1. Read the template starter file from `packages/plugin-design/templates/<template>/starter.dc.html`.
2. Write the `DesignArtifact` row with revision `r-001` in the same transaction as the session row.
3. The hub's prompt (if any) becomes the session's first message; the agent refines the starter through `design_edit` like any other turn.

An agent-driven creation path (orchestrator minting design sessions) can reuse the same route later; it is not in v1.

### design_edit

Edit the current artifact: patch or full rewrite. Every edit writes a new revision.

**Signature:**
```typescript
{
  kind: 'patch' | 'rewrite';
  content: string;  // patch: CSS/HTML fragment or description; rewrite: full .dc.html
  summary?: string; // human-readable change description
}
```

**Semantics:**
1. Load the current artifact bytes.
2. Apply the edit:
   - `patch`: parse the current artifact, apply CSS or DOM changes, recompute `data-vdid`s for affected elements.
   - `rewrite`: replace the entire document. Recompute all `data-vdid`s.
3. Validate the result is valid `.dc.html` (meta block parseable, version recognized).
4. Write a new revision. Set `turn_id` to the current entry id.
5. Emit `design.artifact.updated` with the new revision id and a change summary.

**Decision gates:**
- Implicit approval gate for edits with `riskLevel='critical'` or if the artifact size would exceed 10 MB.

**Revisions written:**
- `r-NNN`: new revision with incremented counter.

**WebSocket events:**
- `design.artifact.updated`: revision id, size bytes, change summary, revert payload (previous revision).

### design_render_token

Fetch a design-system token by name.

**Signature:**
```typescript
{
  token_name: string;  // e.g., 'color-primary', '--color-primary'
}
```

**Semantics:**
1. Load the current design system from the session's `DesignSystemProvider`.
2. Normalize the token name (strip leading `--` if present).
3. Look up the token in the design system's token map.
4. Return the token value (CSS value, hex color, font name, etc.).

**Decision gates:**
- None.

**WebSocket events:**
- None; the result is returned inline.

### design_comment_resolve

Mark a comment thread on an artifact element as resolved.

**Signature:**
```typescript
{
  vdid: string;       // element id
  comment_id: string; // thread message id
}
```

**Semantics:**
1. Look up the comment in `design_comments`.
2. Set `resolved_at` to now.
3. Emit `design_comment_resolved` with the vdid and comment id.

**Decision gates:**
- None.

**WebSocket events:**
- `design_comment_resolved`: vdid, comment id.

### design_import_marp

Import a Markdown file (Marp format) as a new design artifact.

**Signature:**
```typescript
{
  file_path: string;  // workspace path, e.g., '/workspace/deck.md'
}
```

**Semantics:**
1. Read the file from the workspace (via `read` tool).
2. Pass the Markdown to `DeckSerializer.deserialize(bytes, 'marp')`.
3. The result is `.dc.html` bytes.
4. Write a new `DesignArtifact` with revision `r-001`.
5. Write an `import-report.md` into the artifact metadata (lists unmapped features, conversion notes).
6. Emit `design.artifact.imported` with format `marp`.

**Decision gates:**
- `artifact_import`: first-use gate on `design_import_marp`, naming the file path and any content categories detected.

**Revisions written:**
- `r-001`: imported artifact.

**WebSocket events:**
- `design.artifact.imported`: format, report.

### design_import_gslides

Import a Google Slides presentation as a new design artifact.

**Signature:**
```typescript
{
  presentation_id: string;  // Google Slides presentation ID
}
```

**Semantics:**
1. Call `slides.get_presentation` (via `plugin-google-workspace` action group) to fetch the presentation.
2. Pass the element tree to `DeckSerializer.deserialize(bytes, 'gslides')`.
3. Map Slides `objectId`s to artifact `data-vdid`s (stored in a mapping table for later export).
4. Write a new `DesignArtifact` with revision `r-001`.
5. Write an `import-report.md` into the metadata.
6. Emit `design.artifact.imported` with format `gslides` and the presentation URL.

**Decision gates:**
- `artifact_import`: first-use gate, naming the Slides file name and OAuth scope required.

**Revisions written:**
- `r-001`: imported artifact.

**WebSocket events:**
- `design.artifact.imported`: format, report, presentation_url.

### design_import_image

Import an image file (PNG, JPG, SVG) into the artifact as a new element.

**Signature:**
```typescript
{
  file_path: string;  // workspace path or URL
  placement?: string; // 'append' | 'replace-selection'
}
```

**Semantics:**
1. Read the image from the workspace or fetch from URL.
2. For SVG: inline the content. For PNG/JPG: base64-encode and embed as `data:` URL.
3. Create an `<img>` element with the source.
4. Append to the artifact (or replace the selected element if `placement='replace-selection'`).
5. Recompute `data-vdid`s.
6. Write a new revision.

**Decision gates:**
- None.

**Revisions written:**
- `r-NNN`: new revision with the image embedded.

**WebSocket events:**
- `design.artifact.updated`: revision id, change summary.

### design_export

Export the artifact to an external format: HTML, PDF, PPTX, Google Slides.

**Signature:**
```typescript
{
  format: 'html' | 'pdf' | 'pptx' | 'gslides';
  filename?: string;
}
```

**Semantics:**

For `html`: return the artifact bytes directly as a downloadable blob.

For `pdf` or `pptx`: delegate to the sandbox. Pass the artifact bytes to `@marp-team/marp-cli` via a temporary `file://` input, collect the output, and return a signed download URL.

For `gslides`: delegate to the sandbox. Transpile the artifact to Slides `batchUpdate` commands, chunk per slide with `writeControl.requiredRevisionId` fencing, call `presentations.batchUpdate`, and return the presentation URL.

**Decision gates:**
- `export_manifest`: before export, name every file referenced in the artifact (images, stylesheets). User approves scope.
- First-use `gslides` export: gate names target file name and that it will be created in Google Drive.

**Revisions written:**
- None; exports do not mutate the artifact.

**WebSocket events:**
- `design_export.started`: format.
- `design_export.completed`: format, download_url or presentation_url.
- `design_export.failed`: error reason.

### design_handoff

Spawn a child coding session with the artifact as the starting point.

**Signature:**
```typescript
{
  implementation_task?: string;  // optional direction for the child
}
```

**Semantics:**
1. Get the artifact's current revision.
2. Commit the artifact to the session's git repo (if one is set), capturing the commit hash as `startRef`.
3. Spawn a child session with `kind='code'`, `startRef=<commit>`, and the session thread transcript as a read-only tool.
4. The child's session title is auto-filled: `<parent session title> → code`.
5. Emit `design_handoff.spawned` with the child session id.

**Decision gates:**
- None; handoff is a straightforward delegation.

**Revisions written:**
- None.

**WebSocket events:**
- `design_handoff.spawned`: child_session_id.

## Sandbox Image

A new variant `docker/Dockerfile.sandbox-design` extends the base `k8s` image to include:

- `@marp-team/marp-cli` (npm package)
- Chromium (for exporting PDF via headless browser)
- `google-api-nodejs-client` for Slides integration

**Egress policy during export:** exports run against `file://` inputs only. The sandbox's egress policy denies connections to link-local and cluster-internal IP ranges during export operations (egress firewall rules applied at tool invocation).

## Google Slides Integration

A new action group `slides.*` is added to `plugin-google-workspace`. These actions are internal to Valet; plugins do not import `slides.googleapis.com` directly.

**Actions:**

- `slides.get_presentation`: fetch a presentation by id, return element tree and metadata.
- `slides.create_presentation`: create a new empty presentation, return presentation id and URL.
- `slides.batch_update`: apply a batch of mutations (text, shapes, images, layout) to a presentation, chunked per slide.

**Scope:**
- OAuth scope: `drive.file` only. Foreign presentations (not owned by the user) are imported only via a shared link, surfaced as a decision gate.

**Chunking and fencing:**
- `batchUpdate` is split per slide (each request ≤ 50 mutations per Google's limits).
- Each chunk carries `writeControl.requiredRevisionId` set to the presentation's current revision, so partial writes are rejected rather than applied halfway.
- If a chunk fails, the operation is resumable: a retry reattempts from the failed chunk.

**Mapping: `objectId` ↔ `data-vdid`:**
- When exporting to Slides, the transpiler writes the artifact's `data-vdid` into Slides' custom `objectId` field (stored in the element's user-defined properties).
- When importing from Slides, the transpiler reads Slides' `objectId` field and uses it to populate the artifact's `data-vdid`, preserving comment anchors across round trips.

## Web Surfaces

### `/design` — Project Hub

Landing page for creating or opening design documents.

**Components:**
- Top bar: "What should we create?" prompt input box.
- Design system picker: dropdown to select the team's design system (loads from `DesignSystemProvider`).
- Model picker: dropdown to select reasoning model (default: Sonnet 4.6; vision: Opus 4.6 if image in prompt).
- Template grid: visual cards for each template (slides, document, wireframe, etc.), each clicking sends `POST /api/sessions` with `kind='design'` and the template name.
- Projects list: recent design sessions, sortable by date, filterable by template.

**TanStack Router pattern:** nested route under `/design`, uses the existing session list from `GET /api/sessions?kind=design`.

### `/sessions/$id/design` — Canvas

The design authoring surface.

**Layout:**
- Top bar: session title, Refresh button, Deck-Page toggle (for slides template), Zoom slider, Comment toggle, Edit toggle, Present (full-screen), Share (read-only link).
- Left sidebar: slide strip (visible only when template is `slides`), showing thumbnail of each section.
- Center: canvas area, renders the artifact via `DesignRenderer`.
- Right sidebar: thread history with collapsible tool-call blocks (same as code sessions). Edits appear as durable submissions.
- Bottom (slides only): speaker notes pane.

**Interactions:**
- Click on an element in the canvas: focuses the element, shows comment count if any.
- Hover over thread message: shows "Edited <filename>" badge with revert option.
- Share button: copies a signed, read-only link to clipboard.

**React patterns:** uses TanStack Router and Query for thread/artifact state (same as `/sessions/$id/thread`). Real-time updates via WebSocket `design.artifact.updated` event.

### `/sessions/$id/design/share?token=...` — Shared View (Read-Only)

Renders the artifact in the same canvas, but:
- No comment input, no edit tools.
- Design system tokens are derived (subset of tokens referenced in the artifact) rather than full.
- All interaction disabled except navigation (slides only).

**Implementation:** the share endpoint returns `{ artifact_bytes, design_system_token_subset }` and the client renderer mounts the same canvas component with `readOnly=true`.

## Security Model

The design spec names fourteen threat categories. Mitigations are normative in the sections where they live:

1. **Rendered artifact escapes the client.** Mitigation: §"Artifact Format" specifies whitelist HTML sanitization (no `<script>`, no `on*` attributes) at parse time; shadow root + strict CSP in `DesignRenderer`.

2. **Design system exfiltration through a share link.** Mitigation: §"Web Surfaces" / Share endpoint returns only derived token subset, scanning the artifact for CSS custom-property references.

3. **Element id churn.** Mitigation: §"Artifact Format" / `data-vdid` content-hashed on stable attributes; `vdid_stability_report` audits regenerations.

4. **Two design systems drift.** Mitigation: exactly one active `DesignSystemProvider` per session; conflicts surface at session creation as a decision gate.

5. **Handoff to code carries too much.** Mitigation: §"design_handoff" spawns a fresh child whose `startRef` is the artifact's git commit; brief is the design thread as read-only tool. No sandbox state copied.

6. **Multi-user chat race.** Mitigation: thread queue mode is `steer`. Every applied edit is a durable submission with `parentRevision` fence.

7. **Cost blowout on multi-modal loops.** Mitigation: per-session budget cap surfaced as decision gate. Plugin declares `default_model` and `vision_model`; org's `llm_providers` policy sets ceiling.

8. **Export leaks secrets.** Mitigation: exports through `ExportManifest` decision gate that names every referenced file.

9. **Chromium exporter probes internal network.** Mitigation: exporter runs against `file://` inputs only; sandbox egress policy denies link-local and cluster-internal ranges during export.

10. **Google Slides lossy round-trip.** Mitigation: every import writes `import-report.md`, every export writes `export-report.md`. First-use surfaces as decision gate.

11. **Google Slides scope creep.** Mitigation: v1 uses `drive.file` only. Foreign presentations imported only via shared link user confirms in `credential_request` decision gate.

12. **Google-side rate limits and partial writes.** Mitigation: chunked `batchUpdate` per slide with `writeControl.requiredRevisionId` fencing. Partial failure surfaces resumable `export_state`.

13. **Google Slides as an exfil channel.** Mitigation: every Slides export goes through same `ExportManifest` gate.

14. **Prompt injection through imported content.** Mitigation: imports return extracted content as data; agent's tool call triggers mutation (visible in thread, revertible).

## Non-Goals (with Re-Entry Seams)

Each explicitly exclusion has a future re-entry point:

| What | Why | Re-Entry |
|---|---|---|
| Preview URL through sandbox gateway | Render moves to client, eliminating the need | Separate `DesignRenderer` impl for preview mode if iframe embedding needed |
| Claude-generated sliders | Limited scope for v1; template-based refinement only | Plugin adds slider-generation actions later |
| Native DOCX/XLSX | Out-of-scope; design focus is visual | New `DeckSerializer` impl if document export lands |
| Non-Marp PPTX with animations | Marp is the authoring format; animations are template-defined | `DeckSerializer.deserialize` can accept other PPTX converters |
| Full Google Slides fidelity | Lossy round-trip is acceptable; reports surface it | Extend mapping table in Appendix A |
| Live Slides collaboration | Sync complexity; Valet model is session-owned | Periodic push/pull rather than live sync |
| Canva | Separate product; no integration seam | If Canva exposes import API, add `DeckSerializer` impl |
| Live multi-user cursors | Scope for shared link is read-only in v1 | Extend share link to real-time edit collaboration layer |
| Voice/video/shaders/3D | Template-based design, not runtime rendering | Extend `DeckRenderer` with canvas/WebGL support |
| Design-system authoring UI | v1 reads from codebase; no internal editor | `DesignSystemProvider` impl for drag-drop builder |
| Figma/Sketch import | External tools; no SDKs expose element trees | Wait for public APIs or reverse-engineering cost-benefit |
| Web capture from arbitrary sites | Security risk; Chromium in sandbox too powerful | Whitelist specific services if needed later |

## Acceptance Scenarios

Three scenarios, each observable at API/WebSocket level with integration tests under `tests/design/acceptance/`.

### Scenario A: Document Page

**Path:** `tests/design/acceptance/document-page.test.ts`

1. User opens `/design`, picks Document template, prompts "landing page for a product launch".
2. Session created with `kind='design'`, `template='document'`.
3. Initial `.dc.html` renders in client within 3 seconds.
4. User clicks on the headline, posts a comment: "Make it shorter".
5. `design_edit` tool runs, artifact mutates (text shortened).
6. New revision written, canvas re-renders in place.
7. Tool-call block shows revert option; user clicks it.
8. Artifact reverts to previous revision, canvas updates.
9. User clicks Share, receives a read-only URL.
10. User opens link in private window (same org), canvas renders with design-system tokens subset only (no full system exported).
11. User exports to PDF: `design_export` with `format='pdf'`.
12. `ExportManifest` decision gate opens, listing every referenced file (images, stylesheets).
13. User approves, `marp-cli` runs against `file://` input, signed download URL returned within 10 seconds.
14. User posts "ship this".
15. `design_handoff` spawns child session, GitHub App opens PR against marketing repo, attributed to user with `Co-authored-by: user@org.com`.

### Scenario B: Slide Deck

**Path:** `tests/design/acceptance/slide-deck.test.ts`

1. User picks Slides template, prompts "10-slide pitch deck for Series B".
2. Slide-strip visible in left sidebar.
3. Speaker-notes pane visible at bottom.
4. 10-section artifact renders in 5 seconds.
5. User clicks slide 4 title, posts: "Change this to a case study".
6. `design_edit` runs, slide 4 mutates.
7. New revision written, canvas re-renders slide 4 only (not full reload).
8. Slide-strip updates thumbnail.
9. User posts "insert a workflow-engine slide after slide 10, renumber the rest".
10. New revision with 11 sections, strip updates, previously-placed comments on slides 11+ survive because `data-vdid`s are content-hashed.
11. User exports PDF: decision gate, approval, signed URL within 10s.
12. User exports PPTX: decision gate, approval, signed URL within 10s.
13. Both file formats received and verified for 11 slides.

### Scenario C: Google Slides Round Trip

**Path:** `tests/design/acceptance/gslides-roundtrip.test.ts`

1. From the deck in Scenario B, user posts "push to Google Slides".
2. `design_export` with `format=gslides`.
3. First-use `ExportManifest` gate opens, naming target file, content categories, OAuth scope (`drive.file`).
4. User approves.
5. Exporter calls `presentations.create`, then chunked `batchUpdate` (one per slide) with `writeControl.requiredRevisionId` fencing.
6. `export-report.md` written into artifact metadata, naming unmapped features.
7. Tool result returns Slides URL and report.
8. External human edits slide 3 title in Google Slides (via browser).
9. User posts "pull those changes back".
10. `design_import_gslides` runs with recorded presentation id.
11. Calls `slides.get_presentation`, transpiles back to `.dc.html`.
12. `import-report.md` written into artifact, naming any differences from export.
13. New artifact revision written.
14. Canvas re-renders. `data-vdid` on slide 3's title unchanged because `gslides` serializer preserved it in Slides' `objectId`.
15. User posts "handoff".
16. Child session spawned, child's brief includes linked presentation id (read-only tool).
17. Scenario C is skipped explicitly (not silently) if `plugin-google-workspace` is not connected.

## Appendix A: HTML-to-Google-Slides Mapping

Normative mapping table for round-trip fidelity. Columns: element kind, MUST round-trip (row structure preserved), MAY round-trip (best-effort), UNREPRESENTABLE (surfaces in export-report.md).

| Element | MUST | MAY | UNREPRESENTABLE |
|---|---|---|---|
| Text run | yes (paragraph) | styled color, font, size | shadow, outline |
| Heading | yes | level mapped to Slides heading style | custom heading styles |
| Ordered list | yes | indentation, nesting | custom list markers |
| Unordered list | yes | indentation, nesting | custom list markers |
| Image | yes | dimensions, position | filters, blend modes |
| Link | yes (text color blue) | visited state | click handlers |
| Code block | yes (Slides preformatted) | monospace font | syntax highlighting |
| Blockquote | yes | indentation, italic font | left border |
| Background image | yes (via `<section style="background-image:">`) | opacity | video backgrounds |
| Page break | yes (`<section>` boundary) | — | — |
| Speaker notes | yes (`<aside>` in section) | — | — |
| Table | yes (converted to Slides table) | borders, shading | complex cell merges |
| Horizontal rule | yes (thin line) | color, weight | dashed patterns |
| Video | no | — | embedded video |
| Custom component | no | — | any non-HTML element |

## Appendix B: Example Artifacts

### Minimal Document

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="valet-design" content="v=1; template=document">
  <style>
    body { font-family: system-ui; margin: 2rem; }
    h1 { color: var(--color-primary); }
  </style>
</head>
<body>
  <h1 data-vdid="f2e8d1c4">Launch Day</h1>
  <p data-vdid="a3c7f2e8">Go live with the new product.</p>
</body>
<!-- valet-design:meta
{
  "v": 1,
  "template": "document",
  "created_at": "2026-08-23T12:00:00Z",
  "created_by": "user:alice",
  "revision": "r-001",
  "design_system_provider": "codebase"
}
-->
</html>
```

### Minimal Slides

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="valet-design" content="v=1; template=slides">
  <style>
    section { height: 100vh; padding: 2rem; }
    h1 { font-size: 3rem; }
  </style>
</head>
<body>
  <section data-vdid="e8f7b2a1">
    <h1 data-vdid="a1b2c3d4">Pitch Deck</h1>
    <p data-vdid="d4c3b2a1">Series B Fundraise</p>
    <aside>Welcome slide.</aside>
  </section>
  <section data-vdid="b2c3d4e5">
    <h2 data-vdid="c3d4e5f6">The Problem</h2>
    <p data-vdid="d5e6f7a8">Market is fragmented.</p>
    <aside>Spend 2 minutes here.</aside>
  </section>
</body>
<!-- valet-design:meta
{
  "v": 1,
  "template": "slides",
  "created_at": "2026-08-23T12:05:00Z",
  "created_by": "user:alice",
  "revision": "r-001",
  "design_system_provider": "codebase"
}
-->
</html>
```

## Resolved Decisions

All seven open questions from the draft are now ruled. The rulings below are final for v1; reopening one requires a spec revision.

**Decision 1: Renderer sanitization — DOMPurify, not a hand-rolled whitelist. RESOLVED.**
The client sanitizes artifact bytes with `DOMPurify` before mounting: `FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form']`, all `on*` attributes stripped (DOMPurify default), and a URI allowlist that permits only `data:` and same-document fragment URLs. The sanitized tree mounts in a shadow root. A hand-rolled whitelist sanitizer is how XSS ships; DOMPurify is maintained against browser parser quirks (mXSS) that a bespoke parser will miss. Note: CSP is a document-level control, so the draft's "strict CSP in the shadow root" is not enforceable per-artifact — the sanitizer is the load-bearing control, and the app's own CSP is the backstop.

**Decision 2: `.dc.html` schema versioning — meta tag. RESOLVED.**
`<meta name="valet-design" content="v=1; template=slides">` in `<head>`. The renderer refuses documents with unknown `v=` values. A URL scheme or JSON block adds indirection without adding capability.

**Decision 3: Token subset for shared links — `var(--*)` references only. RESOLVED.**
The share endpoint scans artifact bytes for `var(--token-name)` references and ships only those tokens. Component references are **never** included: the component index maps names to source paths in the customer's codebase, which is exactly the exfiltration surface the share link must not carry. False negatives degrade styling; false positives leak the design system. Tokens only.

**Decision 4: Vision-model routing — deferred; no special routing in v1. RESOLVED.**
Design sessions use the same model resolution as every other session (org `llm_providers` policy, session model picker). Image input flows through existing attachment support, and the org's chosen models are already vision-capable in practice. A `vision_model` plumbing layer solves a problem v1 does not have; the re-entry seam is the existing `resolveModel` hook.

**Decision 5: HTML-to-Google-Slides mapping — Appendix A as written. RESOLVED.**
The table ships as-is for v1. Anything not in the table is UNREPRESENTABLE by default and surfaces in `export-report.md`. New rows land with serializer changes, not ahead of them.

**Decision 6: Slides surface lives in `plugin-google-workspace`. RESOLVED.**
A `slides.*` action group joins the existing `drive.*` / `docs.*` / `sheets.*` groups — same credential (`google_workspace`), same fetch-based client, same plugin. A separate plugin would mean a second Google OAuth connection for the same account. Action ids follow the sibling convention: `slides.get_presentation`, `slides.create_presentation`, `slides.batch_update` (the draft's `google.slides.*` prefix does not match how workspace actions are named).

**Decision 7: Template starters are fixed in the package. RESOLVED.**
`packages/plugin-design/templates/<template>/starter.dc.html` plus `prompt.md`, shipped as static assets. Per-team template configuration is a re-entry seam (a `design_templates` table keyed by org), not v1. v1 ships six templates: `blank`, `document`, `slides`, `wireframe`, `resume`, `html-email` — the draft's twelve-template list front-loads starter-file authoring that teaches us nothing about the subsystem.

## Deviations from the Draft (Codebase Review)

Implementation review against the v2 codebase forced five corrections. Each is normative and already folded into the sections above:

1. **`agent_sessions.kind`, not `purpose`.** The engine schema already owns `purpose` (`engine_sessions.purpose`: `interactive`/`orchestrator`/`workflow`/`child`). See §Data Model.
2. **Design tools are engine `ToolDef`s, not plugin actions.** Plugin actions have no database handle and surface in every session. Design tools follow the `mem_*` pattern: API-built `ToolDef`s attached to `kind='design'` sessions, calling internal design routes over the `apiBaseUrl` + internal-token HTTP seam. Names use underscores (`design_edit`) — the Anthropic tool-name charset forbids dots. See §Tools.
3. **Session creation is REST, not a `design.create` tool.** `POST /api/sessions` with `kind`/`template` seeds revision `r-001` from the template starter. See §Tools.
4. **Bytes live inline.** Revisions store content in a `text` column (the `artifacts` table precedent); `storage_ref` is dropped. Timestamps are `bigint` epoch ms. See §Data Model.
5. **In-place migration repair.** Every new table/column added to the applied `0000_app.sql` needs a matching statement in `addColumnsMissingFromAppliedMigrations`, or deployed databases silently miss it. See §Data Model.
