# Sandbox File Upload — Design

Date: 2026-08-23
Status: proposed

## Problem

A session's agent can create files inside its sandbox with `write`/`edit`
tools, but a user cannot hand a file to the agent. That blocks common
work: dropping in a text file to analyze, a zip of a customer's sample
data, or a PDF to summarize. Today the only path is to paste content
into the prompt, which does not scale past a few kilobytes and does not
work for binaries at all.

## Decisions

1. **Scope: sandbox-only persistence.** Uploaded files land under
   `/workspace/uploads/` inside the sandbox and share the sandbox's
   lifetime. When the sandbox is destroyed or replaced, the files
   go with it. No blob-store backing, no cross-sandbox replay.
   Rationale: the sandbox is the unit of work; the file is context
   for that unit. Durable file storage is a separate concern
   (`Follow-ups`).

2. **One REST route.** `POST /api/sessions/:id/files`, multipart
   form-data. Streamed through, size-capped, ownership-gated. No
   separate blob-upload + attach flow. The route both writes bytes
   into the sandbox and returns an attachment ref the client can
   splice into a follow-up message.

3. **Zip auto-extract, PDF auto-transcribe.** Both are default-on
   behaviors under one `extract` setting:
   - `auto` (default): extract zips, transcribe text-based PDFs.
   - `true`: force-attempt extraction; error on non-archives.
   - `false`: land the raw file only.
   Rationale: the two common shapes users want to hand an agent are
   "a bundle of files" and "a document". Making the agent shell out
   to `unzip` or a PDF parser on every drop is friction that the
   route can remove.

4. **PDF extraction via `@firecrawl/pdf-inspector`.** Native napi-rs
   library, fast on text-based PDFs, degrades cleanly on scanned
   PDFs. Runs in-process in the API. OCR is out of scope for MVP
   (`Follow-ups`).

5. **Zip extraction via `yauzl`.** Well-vetted streaming zip reader,
   refuses symlinks by default. Hand-rolled zip decoders are a
   recurring CVE surface — do not write one.

6. **Attachment refs are short-lived and in-memory.** An upload
   response returns a `ref` string. The client splices the ref into
   the next message's `attachments[]`. The message endpoint resolves
   the ref against a per-session in-memory map with a 15-minute TTL.
   Rationale: an upload the user never sends is orphaned garbage in
   `/workspace/uploads/` and nothing more — no DB row, no cleanup
   task. The `MessageEntry.attachments[]` row is the only durable
   record.

7. **Agent sees the files on the next turn.** When a user message
   carries file attachments, the engine prepends a system-authored
   note to the user turn's content listing each attached file's
   path, size, and (if a markdown sidecar exists) the sidecar
   path. The model gets to know the file exists and where to reach
   it without a follow-up prompt.

8. **Auth: session-owner only.** Same rung of the auth ladder as
   messages. Non-owners get 404, never 403. Sandbox-token requests
   (`x-valet-sandbox`) are rejected — the sandbox writes its own
   files with `bash`/`write`; the upload route exists for the
   user-facing path.

## Wire shape

### `POST /api/sessions/:id/files`

Request: `multipart/form-data`

| Field       | Required | Notes                                                                 |
|-------------|----------|-----------------------------------------------------------------------|
| `file`      | yes      | The file bytes. Filename read from the part header.                   |
| `dest`      | no       | Target path inside the sandbox. Default `/workspace/uploads/<name>`.  |
| `extract`   | no       | `auto` \| `true` \| `false`. Default `auto`.                          |
| `overwrite` | no       | Boolean. Default `false`. Overwrites `dest` if the file exists.       |

Response 200:

```json
{
  "path": "/workspace/uploads/report.pdf",
  "bytes": 843212,
  "sha256": "9f2c…",
  "attachmentRef": "att_01H…",
  "extracted": [
    "/workspace/uploads/data/file-a.txt",
    "/workspace/uploads/data/file-b.csv"
  ],
  "pdf": {
    "type": "TextBased",
    "confidence": 0.97,
    "markdownPath": "/workspace/uploads/report.pdf.md",
    "pages": 12,
    "pagesNeedingOcr": [],
    "needsOcr": false
  }
}
```

The `extracted` field is present only when a zip was extracted. The
`pdf` field is present only when the upload is a PDF. When a PDF has
no extractable text layer, `markdownPath` is omitted and `needsOcr`
is `true`.

Error responses:

| Status | When                                                              | Body                                                                                                            |
|--------|-------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| 400    | Missing `file` field, bad `dest`, unknown `extract` value.        | `{ error: "…", corrective: "…" }`                                                                              |
| 404    | Session does not exist, or caller is not its owner.               | `{ error: "session not found" }`                                                                                |
| 409    | `dest` exists and `overwrite=false`.                              | `{ error: "…", corrective: "Retry with overwrite=true, or choose a different dest." }`                          |
| 409    | Sandbox is not ready.                                             | `{ error: "sandbox not ready", wake: true }`                                                                    |
| 413    | Upload exceeds `VALET_MAX_UPLOAD_BYTES`.                          | `{ error: "…", corrective: "Reduce the file, or raise VALET_MAX_UPLOAD_BYTES on the server." }`                 |
| 415    | `extract=true` on a non-archive.                                  | `{ error: "…", corrective: "Set extract=false or omit it — this file cannot be extracted." }`                   |
| 422    | Zip guard tripped (bomb, entry count, symlink, traversal).        | `{ error: "…", corrective: "The archive was rejected by a safety guard. See the message for which one." }`      |

### `POST /api/sessions/:id/messages` — new field

The message create route accepts an optional `attachments` array on
the body:

```json
{
  "content": "summarize this",
  "attachments": [{ "ref": "att_01H…" }]
}
```

Each `ref` is resolved against the per-session attachment-ref map. A
ref that does not exist, expired, or belongs to a different session
is rejected with `400 { error: "unknown attachment", corrective: "Re-upload the file and retry." }`.

## Path resolution

The `dest` field is normalized and then validated. In order:

1. If `dest` is absent, use `/workspace/uploads/<basename(filename)>`.
2. If `dest` ends with `/`, treat it as a directory and append
   `basename(filename)`.
3. Reject the whole request when any of these hold:
   - The normalized path contains a `..` segment.
   - The normalized path contains a null byte.
   - The normalized path is not under `/workspace/`.
   - The normalized path is exactly `/workspace/` (root write).
4. `mkdir -p` the parent directory inside the sandbox before writing.

## Streaming and the size cap

The route reads the multipart body as a stream. The `file` part is
piped straight to the sandbox's `writeBinary` after a size-counting
transform. When the counter exceeds `VALET_MAX_UPLOAD_BYTES`
(default 50 MB), the transform aborts the stream, the partial file
is deleted from the sandbox, and the response is `413`. The whole
payload MUST NOT be buffered in memory. `await c.req.arrayBuffer()`
is forbidden on this path.

## Zip extraction guards

`yauzl` is opened in strict mode. Each entry is validated before its
bytes are read:

1. **Path traversal.** The entry name, normalized, must resolve
   under the extract root (`/workspace/uploads/<basename-no-ext>/`).
   Reject absolute paths (Unix `/`, Windows `C:\`), `..` segments,
   null bytes, and empty names.
2. **Symlinks and hard links.** Any entry whose external attributes
   mark it as a symlink or hard link is skipped. Do not follow, do
   not create.
3. **Entry count.** Cap at 10,000 entries. Abort at the 10,001st.
4. **Uncompressed size.** Cap total uncompressed size at
   `min(VALET_MAX_UPLOAD_BYTES × 10, 500 MB)`. Track running total
   as entries decompress; abort mid-extract on breach.
5. **Compression ratio.** Cap per-entry compression ratio at 100×.
   An entry whose declared uncompressed size divided by compressed
   size exceeds 100 is rejected without reading its bytes.
6. **Central directory vs local header mismatch.** When an entry's
   local file header declares a different size or CRC than the
   central directory, reject the archive. This closes a class of
   zip parsers where the two headers disagree and the reader
   trusts the wrong one.

On any abort, every file written from the archive so far is deleted
before the response returns. The raw uploaded zip itself is left in
place at `dest` — the user can decide what to do with it.

## PDF handling

Detection is by magic bytes (`%PDF-` at offset 0), not the filename
extension.

For a detected PDF:

1. Write the raw bytes to `dest` (as with any other upload).
2. When `extract` is `auto` or `true`, call
   `processPdf(bytes)` from `@firecrawl/pdf-inspector`. This is
   synchronous and typically returns in tens of milliseconds for
   text-based PDFs.
3. Route on `result.pdfType`:
   - `TextBased` — write `result.markdown` to `<dest>.md`.
     Set `pdf.markdownPath` in the response. `needsOcr` = false.
   - `Mixed` with `result.confidence ≥ 0.5` — same as `TextBased`.
     Note the mix in `pdf.pagesNeedingOcr`.
   - `Mixed` with `result.confidence < 0.5`, `Scanned`, or
     `ImageBased` — write a stub file at `<dest>.md`:
     ```
     > PDF has no extractable text layer. OCR is not enabled in this build.
     ```
     Do NOT set `pdf.markdownPath`. Set `pdf.needsOcr` = true.
4. When `extract` is `false`, skip steps 2-3. The `pdf` field in
   the response still carries type + confidence + pages (detection
   is cheap).

The prebuilt native binaries required by `@firecrawl/pdf-inspector`
must be available for `linux-x64` and `linux-arm64`. If a target
platform's binary is missing, boot fails loudly at API startup —
this is a real dependency, not a best-effort feature.

## Attachment refs

An upload response's `attachmentRef` is a random 128-bit id
prefixed `att_`. The API keeps a per-session `Map<ref, AttachmentInfo>`
with a 15-minute TTL:

```ts
interface AttachmentInfo {
  ref: string;
  sessionId: string;   // fenced — reject cross-session use
  createdAt: number;
  path: string;
  bytes: number;
  sha256: string;
  mimeType?: string;
  markdownPath?: string;
  extracted?: string[];
}
```

Two consumers:

1. **`POST /api/sessions/:id/messages`.** When the request body
   carries `attachments: [{ref}]`, each ref is resolved, the info
   is stamped onto the persisted `MessageEntry.attachments[]` as
   a `{type: "file", ...}` entry, and the ref is removed from the
   map. Refs are single-use.
2. **TTL sweep.** Every minute, entries older than 15 minutes are
   dropped. The corresponding files in `/workspace/uploads/` are
   NOT deleted — the user may still want them, and they only cost
   sandbox disk.

Refs are process-local. An API restart forgets every outstanding
ref. Clients that hold a stale ref get a 400 on message send with
a corrective hint to re-upload.

## Engine changes

`MessageEntry.attachments[]` currently carries one variant:

```ts
{ type: "image"; url?: string; data?: Uint8Array; mimeType: string; name?: string }
```

A new variant is added:

```ts
{
  type: "file";
  path: string;         // absolute path inside the sandbox
  bytes: number;
  sha256: string;
  mimeType?: string;
  markdownPath?: string; // for PDFs with a text sidecar
  name: string;          // display name (basename of path)
}
```

The wire projection (`projectAttachments` in
`packages/api/src/routes/messages.ts`) ships both variants under one
union in the message payload. The web client's existing image
renderer stays as-is; a new file renderer handles the file variant.

### Agent annotation

When the engine builds the user turn for a message that carries
`type: "file"` attachments, it prepends a short system-authored
note to the user content:

```
[User attached files to the sandbox:
  - /workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)
  - /workspace/uploads/data.zip (extracted to /workspace/uploads/data/)
]
```

Format rules (STE):

- One line per file. Path first, then the parenthetical.
- Size in the shortest sensible unit (`B`, `KB`, `MB`).
- For a PDF with a markdown sidecar, name the sidecar.
- For a zip that was extracted, name the extract root and end the
  path with `/`.

The image-attachment path stays unchanged. Files add a note; images
still go in as inline `data:` URLs on the user content.

## Web UI

The session view gains a drop zone. Behavior:

1. Dragging a file anywhere over the session view shows a
   full-viewport overlay: dashed border, "Drop to upload" copy.
2. Dropping the file(s) posts each to
   `POST /api/sessions/:id/files`. One request per file. Progress
   is shown in a chip above the composer input.
3. On success, the chip stays: filename, size, and an `x` to
   remove. The chip holds the returned `attachmentRef`.
4. Sending the message includes the refs in the POST body's
   `attachments`. The composer clears its chips after send.
5. Errors surface inline on the chip:
   - 413 → `File too large (max <N> MB).`
   - 415 → `This file type cannot be extracted.`
   - Network fail → `Upload failed — retry` with a retry button.
6. On reload, the persisted message shows a compact file badge
   in the transcript for each attachment: `name (bytes)`, click
   opens a small popover with the sandbox path and (for PDFs) a
   link that opens the markdown sidecar in a modal.

The composer also gains a paperclip button that opens the native
file picker for users who cannot drag.

## CLI

`valet upload <session-id> <path...>` is added to the `valet` CLI.

```
valet upload sess_abc report.pdf
  → /home/me/report.pdf → /workspace/uploads/report.pdf (843212 bytes, sha256:9f2c1a3b)

valet upload sess_abc data.zip --extract=false
  → /home/me/data.zip → /workspace/uploads/data.zip (2048000 bytes, sha256:…)

valet upload sess_abc report.pdf --message "summarize this"
  → /home/me/report.pdf → /workspace/uploads/report.pdf (843212 bytes, sha256:…)
  ↳ sent message to sess_abc (thread: default). Streaming reply…
```

Options:

| Flag             | Notes                                                                   |
|------------------|-------------------------------------------------------------------------|
| `--dest <path>`  | Only valid with a single file. Rejected with two or more paths.         |
| `--extract=…`    | `auto` \| `true` \| `false`. Passed through to the API.                 |
| `--overwrite`    | Passed through to the API.                                              |
| `--message "…"`  | After all uploads succeed, POST a message with the refs spliced in and stream the reply, same shape as `valet send`. |

Exit codes: `0` on success, `1` on any upload failure, `3` if a
follow-up message stops on a decision gate (same convention as
`valet send`).

## Configuration

| Env                          | Default | Meaning                                                            |
|------------------------------|---------|--------------------------------------------------------------------|
| `VALET_MAX_UPLOAD_BYTES`     | 52428800 (50 MB) | Per-upload size cap. Enforced streaming; a payload larger than this returns 413 without buffering the whole body. |

The 10× cap on total uncompressed zip size and the 100× per-entry
ratio cap are constants in the extractor, not env vars. They are
security floors, not tuning knobs.

## Rollout

No feature flag. The route is additive, the engine attachment shape
adds a variant to a union (existing image code paths untouched), the
web UI drop zone is inert until the user drags a file. Ship in one
commit series behind normal review.

## Test surface

- Unit: path validation (traversal, null bytes, `//`, valid cases).
- Unit: zip guards on a corpus of adversarial archives — zip-slip,
  symlink entry, hard-link entry, absolute-path entry (both Unix
  and Windows), null-byte name, 100× compression ratio, 20k
  entries, UTF-8 filenames, local-vs-central-header size mismatch.
- Unit: PDF detection by magic bytes; PDF stub written for a
  scanned PDF; markdown sidecar written for a text-based PDF.
- Route integration: happy path (text, zip, PDF text-based, PDF
  scanned); non-owner 404; sandbox-token rejected; 413 on size
  cap; 415 on `extract=true` non-archive; 409 on overwrite
  conflict; 409 on sandbox-not-ready.
- Engine: `MessageEntry.attachments` round-trips file variants
  through the store; the wire projection ships both variants; a
  message carrying file attachments produces the annotated user
  turn.
- Regression (per `CLAUDE.md` tool-call round-trip rule):
  `pnpm --filter @valet/engine test happy-path`,
  `pnpm --filter @valet/engine test in-memory-store`,
  `pnpm --filter @valet/store-postgres test`, and the api
  integration suite.
- CLI: `valet upload` with and without `--message`.
- E2E: the scorecard includes a new upload suite that drops a
  small text file, a small zip, and a small text-based PDF into a
  running session and asserts the resulting file paths + a
  follow-up `bash ls /workspace/uploads` from the agent.

## Follow-ups

Deliberately out of scope for this pass. Each is a real thing we
will want, and each has enough surface to justify its own spec.

1. **Blob-backed persistence.** Write the bytes to `BlobStore` as
   well as the sandbox, keyed by `sessions/<id>/uploads/<sha>`,
   and replay them into `/workspace/uploads/` on sandbox rebuild
   via a `PrepStep`. Makes uploads survive sandbox replace and
   hibernation eviction.
2. **PDF OCR.** Wire `pdf-inspector`'s selective-OCR path. Needs
   PDFium and ONNX Runtime shared libraries at runtime, plus a
   model cache. Cover model download, cold-start budget, and a
   hosted fallback for large or degraded documents.
3. **Archive formats beyond zip.** `.tar`, `.tar.gz`, `.tgz`,
   `.7z`. Reuse the guard set from zip.
4. **Multi-file upload in one request.** The route today accepts
   one `file` part per request. Batch shape is a future addition
   that must keep the streaming and size-cap guarantees.
5. **User-visible upload history.** A per-session listing of
   uploads under `/workspace/uploads/` in the web UI, with a
   "re-attach" button that mints a fresh ref for a file already
   on disk.
