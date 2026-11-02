# Gmail attachments and Drive export

Status: implemented (2026-10-30)

The assistant can attach files to Gmail messages and drafts. It can also save a Google Doc, Sheet, or Slides deck as a PDF or Office file in the thread. Before this change, an email that needed a generated SOW and a contract in Google Docs had to wait for the person to download and attach both files by hand.

## Surfaces

- **Engine**: `ToolContext.threadFiles`, a `ThreadFileStore` bound to the calling thread (`packages/engine/src/types.ts`). `CreateSessionOptions.threadFiles` supplies it per thread.
- **API**: `generatedFileStore` (`packages/api/src/services/generated-files.ts`) implements the seam over the `file_attach` store. The engine host wires it into every session that has a database and a blob store.
- **Google Workspace plugin**: `drive.export_file`.
- **Gmail plugin**: an `attachments` parameter on `gmail.send_email`, `gmail.create_draft`, and `gmail.update_draft`, and a new `gmail.add_draft_attachments` action.

## Thread file store

A thread file is a durable, private download in one thread: the same `generated_files` row and blob that `file_attach` writes. The seam has two methods:

- `save({ name, mimeType, data })` stores the bytes and returns `{ id, name, mimeType, bytes, url, webUrl }`. It applies the `file_attach` limits: 50 MB for each file, and 1 GiB and 1,000 files for each organization. A refusal throws an error that names the fix.
- `read(id)` returns the file and its bytes. It returns null for an ID that is malformed, not ready, or saved in another thread.

`file_attach` and the seam share one save function, so the caps, the deduplication, and the reservation rules are the same on both paths. The `file_attach` result now also carries the file `id`.

The seam is absent in workflow tool nodes and on hosts without a blob store. Actions that need it return an error that names another path.

## `drive.export_file`

Parameters: `fileId`, `format?` (`pdf`, `docx`, `xlsx`, `pptx`, `csv`), `fileName?`. Risk: low. Labels guard category: READ_GET.

| Source type | Formats | Default |
|---|---|---|
| Google Docs | pdf, docx | pdf |
| Google Sheets | pdf, xlsx, csv (first sheet) | pdf |
| Google Slides | pdf, pptx | pdf |
| Google Drawings | pdf | pdf |
| Any other file | saved unchanged | none |

The action reads the file metadata, then calls `files.export` for a Google editor file or `alt=media` for any other file. It reads at most 50 MB and saves the bytes with `ctx.threadFiles.save`. The saved name is `fileName` or the Drive name, plus the format extension after a conversion. The result returns `threadFileId`, `url`, and `webUrl`.

Drive refuses to export more than 10 MB from a Google editor file. The action reports that limit and tells the agent to share the Drive link. A format that does not match the source type fails before the download.

## Gmail attachments

Each attachment item names one file:

- `threadFileId`: a thread file ID, or a thread file download URL.
- `path`: an absolute path in the session sandbox. The action checks the size with `stat` before it reads the file.
- `filename` (optional): the name the recipient sees.

A Drive file reaches Gmail in two steps: `drive.export_file`, then `threadFileId`. The Gmail action never reads the Google Workspace credential. Each integration keeps its own connection, approval policy, and labels guard. Gmail does not fetch URLs, because no integration fetches arbitrary URLs.

Gmail limits the attachments of one message to 25 MB in total. The action refuses a message over that limit before it calls Gmail. For a sandbox path, it checks the size before it reads the file. The error tells the agent to share a Google Drive link instead. `add_draft_attachments` counts the files the draft already has, from the draft's `format=full` part sizes.

### MIME structure

Without attachments, the message keeps its `multipart/alternative` body. With attachments, the top level is `multipart/mixed`: the alternative body first, then one base64 part for each file, with lines of at most 76 characters.

A short printable ASCII name is a quoted `name` and `filename` parameter. Any other name uses RFC 2231 percent-encoded UTF-8, split into numbered sections so each header line stays under 78 characters. Names lose control characters and path separators. The Content-Type comes from the thread file or a well-formed declared type. Otherwise it comes from the extension, with `application/octet-stream` as the fallback.

### Adding to an existing draft

`gmail.add_draft_attachments` reads the draft in `format=raw` and appends parts without decoding the rest of the message. It handles the message as latin1 so the bytes of the other parts do not change. A `multipart/mixed` message gets the new parts before its closing delimiter. Any other message becomes the first part of a new `multipart/mixed` body. Its `Content-*` headers move into that part, and its other headers stay at the top level. The draft keeps its thread ID.

`gmail.update_draft` is still a full replace. Its `attachments` list replaces every earlier file.

### Upload path

A message of at most 3 MB goes in the JSON `raw` field. A larger message uses the Gmail resumable upload endpoint (`/upload/gmail/v1/...?uploadType=resumable`). The first request sends the metadata and the `X-Upload-Content-*` headers. The second request sends the message as `message/rfc822` to the returned session URL. The action sends the token only to an HTTPS `*.googleapis.com` session URL.

## OAuth scopes

No scope changes. Gmail already requests `gmail.compose` and `gmail.send`, which cover drafts and messages with attachments. Google Workspace already requests `drive`, which covers `files.export` and media downloads. Existing connections keep working without a reconnect.

## Limitations

- A thread file belongs to one thread. A file saved in another thread of the session cannot be attached by ID. Attach it by path, or save it again.
- Workflow tool nodes have no thread file store and no sandbox. Attachments and `drive.export_file` fail there with a corrective error.
- The web UI renders a download link only for `file_attach` results. For `drive.export_file`, the agent gives the URL as a Markdown link.
