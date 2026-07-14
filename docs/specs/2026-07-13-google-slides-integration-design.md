# Google Slides Integration — Design Spec

**Status:** Draft, ready for review
**Author:** Conner Swann
**Date:** 2026-07-13
**Target:** `@valet/plugin-google-workspace`
**Motivation:** Keisha's 2026-07-13 request in #proj-valet: stitch together slide-level Granola call notes + slide comments + deck content into actionable revisions. Also closes the twice-asked "how do I make slides" gap (Carey, Akshar) from the H1 docs audit.

## 1. Problem statement

Today Valet is blind to Google Slides beyond three limited surfaces:

1. `drive.list_files` with `mimeType: 'presentation'` — can find decks
2. `drive.download_file` — exports a deck to plain text (loses per-slide structure, speaker notes, layout, shapes)
3. Generic `drive.*` mutations — delete/move/rename/copy at the file level only

There is **zero structured read** (per-slide text, speaker notes, tables, images), **zero write** (create/edit/duplicate), and **zero comment** access for Google Slides files. Keisha's workflow — stitch comments + Granola notes into an actionable diff — is blocked on all three fronts.

The Slides API (`https://slides.googleapis.com/v1`) is a first-party Google REST API with the same auth pattern the plugin already uses for Docs/Sheets/Drive. Slides comments live on the **Drive Comments API** — the exact same endpoint that already backs `docs.list_comments`. Almost all the plumbing exists.

## 2. Non-goals

- **New plugin package.** Slides belongs inside `@valet/plugin-google-workspace` alongside Docs/Sheets/Drive. Users get the capability from their existing Google Workspace OAuth connection.
- **PowerPoint / `.pptx` binary parsing.** Only native Google Slides files (`application/vnd.google-apps.presentation`). `.pptx` files can be converted via `drive.copy_file` + MIME-type conversion in a follow-up.
- **Rendering slides to images.** The Slides API supports `pages.getThumbnail`, but image-return is out of scope for v1. Track as future work.
- **Excalidraw parity.** We already have a rich Excalidraw tool suite for from-scratch decks. Slides tools are for **existing Google Slides decks** (edit + read + comment), not a general presentation-authoring workspace.

## 3. Scope of v1

Ship a `slides.*` namespace with 13 actions across four capability groups:

### Read (5 actions, `low` risk)
| Action ID | Purpose |
|---|---|
| `slides.read_presentation` | Structured read of a whole deck. Multi-format: `text` \| `json` \| `markdown` (mirrors `docs.read_document`). |
| `slides.list_slides` | List slides in presentation order with slide ID, title, layout name, element counts, speaker-notes preview. |
| `slides.get_slide` | Full detail of one slide: elements, text, speaker notes, layout, transitions. |
| `slides.get_presentation_info` | Metadata: title, page size, master/layout inventory, revision ID, owner. |
| `slides.get_speaker_notes` | Speaker notes across all slides as `{ slideId, notes }[]`. Optimized shortcut — reading the full deck just for notes is wasteful. |

### Comments (6 actions)
Slides comments are per-file, not per-slide (Drive-level constraint), but they often *quote* slide content — same shape as Docs. Mirror the Docs comment tools 1:1 on Drive's `/files/{id}/comments` endpoint.

| Action ID | Risk |
|---|---|
| `slides.list_comments` | `low` |
| `slides.get_comment` | `low` |
| `slides.add_comment` | `medium` |
| `slides.reply_to_comment` | `medium` |
| `slides.resolve_comment` | `medium` |
| `slides.delete_comment` | `high` |

### Write (5 actions)
Slides API v1 exposes ~30 batch-update request types. v1 tools cover the highest-leverage subset — the ones needed for "apply feedback to a deck":

| Action ID | Risk | Purpose |
|---|---|---|
| `slides.replace_all_text` | `medium` | Global find-and-replace across a deck. Cheap, high-leverage, mirrors `docs.find_and_replace`. |
| `slides.replace_slide_text` | `medium` | Replace text on a specific slide by search string. Preserves paragraph shape. |
| `slides.insert_text_box` | `medium` | Add a new text box to a specific slide at optional coordinates. |
| `slides.duplicate_slide` | `medium` | Copy an existing slide (useful for template-style expansion). |
| `slides.delete_slide` | `high` | Remove a slide by ID. |

### Create (2 actions, `medium`)
| Action ID | Purpose |
|---|---|
| `slides.create_presentation` | Create an empty deck with a title. Optional `folderId`. |
| `slides.create_from_template` | Copy a template deck and run placeholder text replacements — mirrors `drive.create_from_template` but returns the presentation URL and slide IDs. |

**Explicitly deferred to v2:**
- Shape/table insertion, image insertion (deferred pending clarity on what agents actually need)
- Slide layout application (`applyLayout` batch request)
- Reorder slides
- Delete text ranges (agents can `replace_slide_text` with an empty string)
- Thumbnail export
- Slide-level property mutation (background, transitions, notes edits beyond the deck-level replace_all)

Rationale: Slides API has ~30 request types. Shipping all of them adds surface area without demonstrated demand. The 13 above cover Keisha's workflow (read comments + read notes + apply targeted edits) and the "how do I make slides" gap (create + create_from_template).

## 4. Where the code goes

**Plugin path:** `/packages/plugin-google-workspace/src/actions/` (existing).

**Files to create:**

- `slides-actions.ts` (new) — mirrors `sheets-actions.ts` / `docs-actions.ts` structure: `allActions: ActionDefinition[]` array + single `executeAction` switch. Estimated ~800-1000 lines for 13 actions given the existing per-namespace file sizes.
- `slides-helpers.ts` (new) — `SLIDES_API` constant, `slidesFetch(path, token, options)` helper, `normalizePresentationId(id)` (accepts bare ID or full `https://docs.google.com/presentation/d/{id}/edit` URL — mirrors `normalizeDocumentId` in `docs-helpers.ts`), `batchUpdatePresentation(id, requests, token)` helper (mirrors the Docs `batchUpdate` chunking helper).

**Files to modify:**

1. **`actions.ts`** — three additions:
   - Import: `import { slidesActionDefs, executeSlidesAction } from './slides-actions.js';`
   - Spread `...slidesActionDefs` into `allActions`.
   - Add `if (actionId.startsWith('slides.')) return executeSlidesAction(actionId, params, ctx);` in `dispatchAction`.

2. **`provider.ts`** — add one OAuth scope to `WORKSPACE_SCOPES`: `https://www.googleapis.com/auth/presentations`. Rationale for adding rather than relying on the broad `.../auth/drive` scope: idiomatic, self-documenting, robust against future Google-side scope narrowing. Matches how `.../auth/documents` is declared even though `.../auth/drive` covers Docs.

3. **`labels-guard.ts`** — add slides action IDs to the classification maps (`READ_GET_ACTIONS`, `WRITE_MODIFY_ACTIONS`, `CREATE_ACTIONS`), and extend `extractFileId` (return `params.presentationId` for `slides.*` actions) and `extractCreatedFileId` (return `result.data.presentationId` for `slides.create_presentation` / `slides.create_from_template`).

4. **`workspace-output-schemas.ts`** — add JSON Schema entries for each of the 13 new action IDs. Reuse the existing docs-comment schema for all 6 slides-comment actions; define new `presentationInfoSchema`, `slideSchema`, `speakerNotesSchema`, etc.

5. **`skills/google-slides.md`** (new) — LLM-facing usage guide. Auto-bundled into `content-registry.ts` by the generator. Model on the existing `google-docs.md` / `google-sheets.md` shape.

**Nothing else needs to change.** The worker's plugin registry generator auto-discovers plugins that already export `src/actions/index.ts`, so `google-workspace` is already registered. The SDK's `ActionDefinition` / `ActionSource` interfaces are unchanged.

## 5. Auth + rollout implications

Adding `https://www.googleapis.com/auth/presentations` to `WORKSPACE_SCOPES` means **every existing Google Workspace-connected user will be forced to re-consent** on their next OAuth start. This is normally handled naturally because the provider already forces `prompt: 'consent'` — but the important user-visible detail is that the consent screen will list Slides access on next reconnect.

**Rollout plan:**
1. Ship unconditionally with a changelog + Slack post to #proj-valet warning users their next Google reconnect will ask for Slides scope.
2. Users on active connections continue to work with cached tokens; they only re-consent when tokens are refreshed or they explicitly reconnect.
3. First-time connectors after this ships get the new scope in their initial consent.

**Refresh-token behavior:** Google's OAuth honors existing refresh tokens even when new scopes are added to a client — the refresh will just return an access token without the new scope. In practice, the code path calling `slides.*` will 401/403 until the user re-consents. This is acceptable and self-correcting; the plugin's `apiError()` helper will surface the scope issue clearly.

## 6. Result-shape conventions (mirror `docs.read_document`)

`slides.read_presentation` is the flagship read tool. Following the pattern established by `docs.read_document`:

**Params:**
```ts
z.object({
  presentationId: z.string().describe('Presentation ID or full Google Slides URL'),
  format: z.enum(['text', 'json', 'markdown']).default('text')
    .describe('Output format: text (plain), json (structured, slim), markdown (with slide headings)'),
  maxLength: z.number().optional()
    .describe('Max character limit; truncates with a continuation marker'),
  includeSpeakerNotes: z.boolean().default(true)
    .describe('Include speaker notes in output'),
})
```

**Format shaping:**

- **`text`** — one slide per section (`# Slide N: Title` heading, body text, optional `[Speaker notes: ...]`). Uses a `fields` mask to minimize payload.
- **`json`** — slim structured output. Strip `masters`, `layouts`, `pageSize`, `revisionId`, and empty `textStyle`/`shapeProperties`/`paragraphStyle` objects (mirrors `docs.read_document`'s slimming treatment).
- **`markdown`** — write a `slidesJsonToMarkdown()` converter in `slides-helpers.ts`, mirroring `docsJsonToMarkdown` in `docs-markdown.ts`. Each slide gets an `## Slide N: Title` heading; body elements become plain paragraphs; tables become markdown tables; speaker notes become a blockquote.

**Return shape:** `{ success: true, data: { content: string } }` — same as `docs.read_document`. Single string field regardless of format.

**`slides.list_slides` return shape** (structured JSON, mirrors `docs.list_tabs`): a `slides` array of `{ id, index, title, layout, elementCount, speakerNotesPreview, objectIds }` plus a `total` count.

**`slides.get_slide` return shape:** `{ id, index, title, layout, elements, speakerNotes }` where each element is `{ objectId, type, text, position, size }`. Raw Slides API JSON is deeply nested (`shape.text.textElements[].textRun.content`); we extract to a single `text` string per element.

**Comment actions** — reuse the `docs.list_comments` / `docs.get_comment` shapes verbatim (same underlying Drive API endpoint): `{ id, author, content, quotedText, resolved, createdTime, replyCount, replies }`.

**Write action returns** — mirror the Docs pattern. `slides.replace_all_text` returns `{ occurrencesChanged }` (Slides API returns this natively). `slides.duplicate_slide` and `slides.insert_text_box` return `{ objectId }`. `slides.create_presentation` returns `{ presentationId, presentationUrl, title }`.

## 7. Naming conventions locked in

| Convention | Value |
|---|---|
| Action ID pattern | `slides.<snake_case_verb>` |
| ID param field name | `presentationId` (accepts bare ID or full URL) |
| Slide ID param field | `slideObjectId` (consistency with Slides API terminology) |
| Risk rubric | `low` = read; `medium` = write/comment-add; `high` = hard delete (`delete_slide`, `delete_comment`) |
| Zod `.describe()` | Required on every param — feeds MCP JSON Schema for tool discovery |

## 8. Testing plan

Following the existing plugin's test structure (`src/actions/__tests__/`):

- **`slides-actions.test.ts`** — unit tests using mocked fetch. Cover: `presentationId` normalization (URL vs bare), format-flag branching in `read_presentation`, batch-update chunking, error propagation from Google API 4xx/5xx responses.
- **`labels-guard.test.ts`** — extend with slides classification cases (`slides.read_presentation` → read_get, `slides.replace_all_text` → write_modify, `slides.create_presentation` → create, `slides.delete_slide` → write_modify).
- **`output-schemas.test.ts`** — extend with slides schema roundtrip tests.

**Integration test hook:** the plugin has no existing integration-test harness against a live Google account. Manual verification against a real deck (with the owner's permission).

## 9. Documentation

- Update `docs/product/integrations/google-workspace.mdx` — add a Slides section with the 13 actions and their signatures. The catalog is auto-generated from Zod schemas (per the docs-integration-reference work in PR #19), so running the generator will pick these up.
- New `skills/google-slides.md` — LLM-facing best-practice guide covering: format selection (`text` for summarize, `json` for structured editing, `markdown` for display); combining `slides.list_comments` + `slides.read_presentation` + external Granola notes into an edit plan; `replace_all_text` case-sensitivity semantics; when to `duplicate_slide` vs `create_from_template`; the cheaper `slides.get_speaker_notes` shortcut vs full-read.

## 10. Estimated effort

- `slides-actions.ts` + `slides-helpers.ts`: ~2 days for a Valet-familiar engineer. Bulk is thoughtful result shaping and the `slidesJsonToMarkdown` converter.
- `labels-guard.ts` extension: ~30 min.
- `workspace-output-schemas.ts` entries: ~1 hr.
- `provider.ts` scope + comms: 15 min for code, 30 min for the changelog/#proj-valet post.
- Tests: ~1 day.
- Skill markdown: ~2 hrs.
- Docs update (auto-generated): ~30 min to spot-check.

**Total:** ~4 days of focused work for one engineer, plus review.

## 11. Success criteria

**Before shipping:**
- All 13 actions dispatch through the labels-guard cleanly (guard-enabled tests pass).
- `slides.read_presentation` on a 10-slide deck returns under ~50KB in `text` mode, under ~200KB in `json` mode.
- No new dependencies added to `package.json` (still raw fetch).

**After shipping — user-facing outcome:**
- A user can run a prompt like *"Read my deck, list all comments, and cross-reference with these Granola notes to produce a per-slide revision list"* — end-to-end, one Valet session, no manual export/copy-paste.
- Answers the twice-asked "how do I make slides" question with `slides.create_presentation` + `slides.replace_all_text`.

## 12. Follow-ups + open questions

1. **Image support** — Slides supports `createImage` batch requests with a public URL. Straightforward v2 add; deferring only because insertion coordinates + sizing UX is non-trivial.
2. **Placeholder/layout API** — Slides' `applyLayout` request lets templates truly work. v1 relies on `create_from_template` (Drive-side copy). If users hit template limitations, layout support becomes the fix.
3. **`.pptx` conversion** — Drive can convert uploaded `.pptx` to native Slides via `drive.copy_file` with a target MIME type. Worth documenting as a workflow, not a new action.
4. **Slack thread response** — after this ships, post an update to the originating #proj-valet thread with a demo prompt.

## 13. Approval requested

Sign-off needed from:
- **Conner Swann** — plugin-google-workspace de facto owner, Applied AI direction
- **Xiangan He (@xBalbinus)** — Engineering-vertical Valet co-owner (may already be tracking a related ask)
- **Sam Ebstein** — manager review, since this is Platform-team-adjacent surface
