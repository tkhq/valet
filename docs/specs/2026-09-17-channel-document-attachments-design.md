# Channel document attachments

Status: implemented (2026-09-17)

A person sends a PDF over Slack and asks the assistant to read it. Before
this change the assistant could not: the channel host kept image
attachments and replaced every other file with the prompt-text note
`[attachment skipped: unsupported media type application/pdf]`. The
assistant then reached for `slack.fetch_file`, the only other handle on a
Slack file, and that action answered `File type is not viewable. Only
images and text files can be fetched.`

Both halves are fixed here. A non-image channel file now goes into the
session sandbox the same way an uploaded file does, and `slack.fetch_file`
reads a PDF through a host-provided extractor.

## Why the file could not simply be inlined

The model-facing content layer carries text and images only.
`userContentBlocks` (`packages/engine/src/thread.ts`) emits
`{ type: "text" }` and `{ type: "image" }` blocks, and
`attachmentsToImageBlocks` drops any attachment whose mimeType is not
`image/*`. A PDF sent as an image block is a provider error, which is what
the image-only guard in the channel host existed to prevent.

The sandbox route already solves this for uploads
(`docs/specs/2026-08-24-sandbox-file-upload-design.md`): write the bytes
into `/workspace/uploads/`, extract a markdown sidecar beside a PDF, and
persist a `type: "file"` attachment. The engine renders that as a
system-authored note naming the path and the sidecar, so the agent reads
the file with its ordinary tools and spends context on the parts it needs.
Channel files take the same route.

## Channel ingress

`packages/api/src/services/channel-file-ingest.ts` holds the shared step.
`ingestChannelFile({ sandbox, name, mimeType, data })` resolves the
destination through `resolveUploadDest`, writes the bytes, extracts a PDF
sidecar, and returns the `type: "file"` attachment fields.

`ChannelHost.handleMessage` calls it for every fetched attachment that is
not `image/*`. Images keep the existing inline data-URL path.

Rules:

- The filename arrives from a chat platform, so it is untrusted.
  `ingestChannelFile` passes no `dest`, which pins the result to
  `/workspace/uploads/<basename>` and rejects a `..` segment or a null byte.
  A platform that sends no name gets `attachment`.
- A PDF with a text layer gets a sidecar at `<path>.md` and reports
  `markdownPath`. A scanned PDF gets the one-line stub sidecar and reports
  no `markdownPath`, because `markdownPath` is what tells the agent there
  is text to read.
- A PDF that cannot be parsed is still delivered. Extraction failure
  degrades to "no sidecar", matching the upload route's `extract=auto`.
- If the file cannot be stored at all, the host falls back to
  `[attachment skipped: could not store <mimeType>]`. Losing one attachment
  is better than losing the message.
- Storing the file needs the sandbox awake. The turn that follows needs it
  awake as well, and the Slack webhook answers 200 before the fan-out runs
  (`packages/api/src/routes/slack-webhook.ts`), so the wait costs no
  provider timeout.

## Host document extraction

No sandbox image carries a PDF text tool, and `@firecrawl/pdf-inspector`
ships as a native binary beside the api bundle. A plugin action therefore
cannot read a PDF on its own.

`ToolContext.extractDocument` is the seam. The api sets it from
`extractDocumentText` (`packages/api/src/services/pdf-extract.ts`) on every
session it builds, and `Thread.buildToolContext` threads it from
`CreateSessionOptions`, the same way `pluginStoreFactory` is threaded.

Contract: it returns `{ markdown }` for a document with text, `null` for a
document with none and for any format other than PDF, and throws only when
extraction is unavailable. The field is optional, so a host that wires no
extractor leaves plugin actions to degrade rather than fail.

A `PluginActionContext` is built in exactly two places, and both set the
field:

- `Thread.buildToolContext` (`packages/engine/src/thread.ts`) for a session
  action, from `CreateSessionOptions`.
- `buildActionContext` (`packages/api/src/plugins/action-invoker.ts`) for a
  workflow tool node, which has no session, thread or sandbox behind it.

Everywhere else takes the context as a parameter. The workflow site was
missed when the field was introduced, so a workflow node reading a PDF
reported that extraction was unavailable on the deployment: wrong about the
deployment, and true only of that context. Extraction belongs here because it
is a pure call over bytes against the native extractor in the api process,
unlike the thread, sandbox and approval capabilities that context stubs out.
A case in `plugins/action-invoker.test.ts` extracts a real PDF fixture
through the workflow context, so the two paths cannot drift apart again
silently.

## `slack.fetch_file`

The action gains a PDF branch between the text branch and the
metadata-only fallback:

- Over 25 MB → refused, naming the cap. The number matches the transport's
  document budget, so a PDF the inbound path accepts is not refused here.
- No `ctx.extractDocument` → an error naming the missing capability and the
  two things the user can do. The old message blamed the file type, which
  sent the agent looking for a tool that does not exist.
- Extraction returns `null` → an error saying the file has no text layer and
  is probably a scan.
- Otherwise → `{ content, mimetype, filename }`, the same shape the text
  branch returns.

The metadata-only fallback stays for formats the api cannot read, with its
note corrected to name PDFs as fetchable.

## Shared document read

`extractDownloadedPdf` (`packages/engine/src/document-text.ts`) is the one
place that sends downloaded PDF bytes to `extractDocument`. A plugin does
not grow a private PDF extractor branch.

`readResponseBytes` reads a response stream only up to its byte cap. It
checks each chunk when Content-Length is absent, invalid, or stale. It starts
cancellation without waiting when a source does not settle cancellation.
`readResponseText` decodes the same bounded bytes as UTF-8. Generic streams
are inspected through the `%PDF-` prefix before they are buffered. A non-PDF
stream is cancelled after the prefix. The PDF cap is 25 MB, the same budget
the Slack transport uses for a document.

Callers:

- `slack.fetch_file`
- `drive.download_file`. Google Workspace files use metadata to select an
  export. Other files use the media response MIME type, not metadata, to
  select PDF, generic, text, or binary handling. A declared PDF or generic
  byte stream uses the 25 MB cap unless the caller sets `maxSizeBytes`. A
  generic stream is extracted only when its bytes start with `%PDF-`. Text
  stays at 1 MB.
- `github.read_repo_file`. It requests raw Contents API media for every PDF,
  because GitHub omits inline bytes from PDFs over 1 MB. It reads the raw
  stream with the 25 MB cap before it extracts text.

A new downloader calls the same function. Adding a format other than PDF
is still one branch, and that branch is `extractDocumentText`.

## Tests

- `packages/api/src/services/channel-file-ingest.test.ts`: a real one-page
  PDF fixture extracts to a sidecar; a non-PDF gets no sidecar; a
  malformed PDF is still written; a `..` name stays inside the uploads
  directory; a failed write returns `null`.
- `packages/api/src/channels/host.test.ts`: a PDF direct message persists as
  a `type: "file"` attachment with `markdownPath` and no image block, and an
  unstorable attachment still yields a skipped note.
- `packages/plugin-slack/src/actions/actions.test.ts`: `fetch_file` returns
  extracted text, reports a scan, reports a missing extractor, and keeps the
  metadata answer for a zip.
- `packages/engine/test/document-text.test.ts`: the shared reader normalizes
  MIME types, identifies generic PDF bytes, cancels an oversized declared
  response, and returns a size result when cancellation fails.
- `packages/plugin-google-workspace`: `drive.download_file` returns extracted
  PDF text, accepts a generic PDF after it reads the header, rejects a generic
  non-PDF, and stops a media stream that exceeds stale metadata.
- `packages/plugin-github`: `github.read_repo_file` requests raw content for
  a PDF larger than the Contents API inline limit and returns extracted text.

## Not covered

- Formats other than PDF. A spreadsheet or a Word file reaches the sandbox
  and the agent can see its path, but nothing extracts its text. Adding a
  format means one more branch in `extractDocumentText`.
- OCR for scanned PDFs. The stub sidecar names the limitation.
- `ToolAttachment` still has no document variant, so a plugin cannot hand
  raw document bytes to the model. `extractDocument` covers the case that
  matters by returning text instead.
