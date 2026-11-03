# Images in replies

Status: implemented on branch `xbalbinus/images-in-replies`.

The assistant can send images to people: charts, diagrams, screenshots, and other image files it makes in the sandbox. The web chat shows them inline. A Slack turn uploads them to the origin thread.

## What already existed

- `file_attach` (`packages/api/src/services/generated-files.ts`) saves a sandbox file as a durable thread download. `ToolContext.threadFiles` is the same store for plugin actions.
- `slack.reply_file_to_origin` uploads a sandbox file to the origin thread with `files.getUploadURLExternal`, an upload POST, and `files.completeUploadExternal`.
- `show_widget` draws a `Chart` card in the web chat. `slack.reply_to_origin` takes `charts` and Slack draws them natively.
- The OpenAI plugin and native image generation make images and show a preview. This design adds no image provider and no cost.
- The web chat draws a ```` ```mermaid ```` code block. Slack cannot.

## Changes

### Web chat

`file_attach` stores PNG, JPEG, GIF, WebP, and SVG files with an image MIME type. Image bytes decide the type over the extension. The tool takes optional `alt` and `title` and returns them for an image. The download route already serves the bytes with `content-security-policy: sandbox`, so an SVG cannot run script.

The web renderer for `file_attach` and `render_diagram` shows an image result as `ImagePreview`: a thumbnail at most the column width and 384px high, a lightbox at full size, and a download link. The OpenAI image preview uses the same component. The thread's Outputs panel lists every file the assistant saved this way.

### Diagrams

`render_diagram { source, alt, title? }` renders Mermaid to a PNG in the session sandbox and saves it to the thread store. It runs `npx @mermaid-js/mermaid-cli@11.17.0` with the sandbox's Chromium (`valet-chromium` or `chromium`). The first render downloads mermaid-cli from npm; later renders use the sandbox npm cache. Errors name the fix: the Mermaid parse error, a missing browser, a missing `npx`, a timeout, or no network. The PNG also stays at `/workspace/diagrams/`.

### Slack

`slack.reply_file_to_origin` takes `path` or `file_id` (a file saved in this thread), plus `alt_text` and `title`. `alt_text` goes to Slack as `alt_txt` on `files.getUploadURLExternal`. `title` goes on the file in `files.completeUploadExternal`. Image bytes decide the MIME type. SVG uploads succeed, but the result says that Slack shows no preview for them.

In a Slack turn, `file_attach` and `render_diagram` results name the `reply_file_to_origin` call that posts the image, the same way `show_widget` names the chart path.

## Permissions

- Uploads go only to the origin thread with the bot token, through `resolveSlackOrigin`. A turn without a Slack origin is refused before the file is read. Bot-token and user-token rules do not change.
- `file_id` reads through the thread-bound store, so an id from another thread reads as missing and is refused.
- Personas do not hold `render_diagram`, for the same reason they do not hold `file_attach` (INV-32).

## Limits

- No new image-generation provider. Generation stays with the OpenAI plugin.
- `render_diagram` needs npm network access on first use. Without it, the assistant sends a Mermaid code block.
- `reply_file_to_origin` posts only to the origin thread. Posting an image to another channel is not in scope.
