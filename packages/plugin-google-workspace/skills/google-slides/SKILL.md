---
name: google-slides
description: Read, create, and edit Google Slides presentations with native tools, including text, formatting, shapes, and slide ordering.
---

# Google Slides

Use the connected Google Workspace integration. Do not open a browser or create a tunnel for supported slide edits.

1. Discover actions with `list_tools` using service `google_workspace` and query `slides`.
2. Extract the presentation ID from `/presentation/d/<id>/` in the deck URL.
3. Call `slides.get_presentation` for the title, slide IDs, element IDs, and revision ID.
4. Read the relevant slides with `slides.get_page`. Do not load every page unless the task requires it.
5. Make the requested edits with `slides.batch_update`. Supply the latest `revisionId` as `requiredRevisionId`.
6. Read the changed pages to verify their contents. Use `slides.get_thumbnail` to check appearance when needed.

Use `slides.create_presentation` only when the user requests a new deck. Use `drive.copy_file` when the user requests a copy.
Preserve existing slides, styles, images, and notes unless the requested edit requires changing them.

## Update requests

Each `requests` item uses the Google Slides API Request format. Submit at most 100 operations per batch.

Replace text on one slide:

```json
{"replaceAllText":{"containsText":{"text":"Old heading","matchCase":true},"replaceText":"New heading","pageObjectIds":["slide_id"]}}
```

Replace one shape's text with two requests:

```json
[
  {"deleteText":{"objectId":"shape_id","textRange":{"type":"ALL"}}},
  {"insertText":{"objectId":"shape_id","insertionIndex":0,"text":"New text"}}
]
```

Format text:

```json
{"updateTextStyle":{"objectId":"shape_id","textRange":{"type":"ALL"},"style":{"bold":true},"fields":"bold"}}
```

Create a slide:

```json
{"createSlide":{"objectId":"new_slide_01","slideLayoutReference":{"predefinedLayout":"TITLE_AND_BODY"}}}
```

Use returned object IDs; do not guess existing IDs. Other supported API operations include `createShape`, `createImage`, `duplicateObject`, and `updateSlidesPosition`.
Use explicit field masks when changing styles. A batch is atomic; a failed request prevents all its operations from applying.

## Failures

- Revision mismatch: read the deck again and rebase the edit on the new contents. Do not force the old edit.
- Missing connection or expired credentials: reconnect Google Workspace in Settings.
- Permission denied: check which Google account is connected and its access to the deck.
- Disabled API: ask the Google Cloud project administrator to enable `slides.googleapis.com`.
- Interrupted write: read the affected slide before retrying. The edit may already have succeeded.

Do not treat a permission or API configuration error as a reason to retry through a browser tunnel.
If native actions cannot perform an operation, explain the limitation before considering browser editing.
Thumbnail URLs are temporary and private; do not share them outside the conversation.

API reference: https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate
