---
name: design
description: How to author and edit design artifacts in a design session — the .dc.html format, the design_* tools, element addressing, revisions, imports, exports, and handoff to a coding session.
---

# Valet Design Sessions

You are working in a design session. The session owns one artifact: a self-contained `.dc.html` document that the user sees rendered live in their canvas. Every change you make writes a new revision; the user can revert any revision.

## The artifact format

- One HTML document. `<head>` carries `<meta name="valet-design" content="v=1; template=<name>">`.
- Slide decks wrap each slide in a `<section>`. Speaker notes go in an `<aside>` inside the section. Documents and other templates are plain HTML.
- Addressable elements carry `data-vdid` attributes. Do not invent or edit these by hand — the system recomputes them after every edit.
- Styling lives in a `<style>` block in the head. Prefer design-system tokens (`var(--token-name)`) with sensible fallbacks over hard-coded values.
- Keep the document under 2 MB. Prefer SVG over embedded raster images.

## Tools

- `design_edit(kind, content, summary)` — the main tool. `kind='rewrite'` replaces the whole document with `content` (a complete .dc.html). `kind='patch'` applies a targeted change; give `content` as the full outer HTML of the element(s) to replace, each carrying the `data-vdid` of the element it replaces. Always pass a short `summary` — it appears in the revision history.
- `design_render_token(token_name)` — look up a design-system token value before using it.
- `design_comment_resolve(comment_id)` — mark a user's element comment as addressed. Resolve a comment only after you actually made the change it asked for.
- `design_import_marp(file_path)` — import a Marp Markdown deck from the workspace as the artifact.
- `design_import_image(file_path, placement?)` — embed an image from the workspace into the artifact.
- `design_export(format, filename?)` — export to `html`, `pdf`, `pptx`, or `gslides`. Exports never mutate the artifact.
- `design_handoff(implementation_task?)` — spawn a coding child session that starts from the artifact. Use when the user asks to implement, ship, or build the design.

## Working style

1. When the user comments on an element, the message names its `data-vdid`. Change that element, not the whole document, and resolve the comment.
2. One `design_edit` call per user request. Batch related changes into a single revision with one clear summary.
3. Iterate on structure first, polish second. Do not rewrite working slides to change one heading.
4. When the user asks for a change you already know conflicts with the template's layout, say so briefly, then do the closest reasonable thing.
