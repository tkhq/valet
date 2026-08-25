# Sandbox file upload

Status: implemented (2026-08-24)

Users attach files to a session. The api writes each file into the session's
sandbox, extracts archives and PDFs, and hands the client a short-lived
attachment ref. A later message spends the ref, which persists the file
metadata on the user message and renders a note the agent can act on.

## Surfaces

- **API**: `POST /api/sessions/:id/files` (multipart form-data).
- **Web**: composer file chips (`packages/web/src/components/session/composer-files.ts`).
- **CLI**: `valet upload <session-id> <path...>` (`packages/api/src/cli/commands/upload.ts`).
- **Engine**: `type:"file"` attachments on `MessageEntry.attachments`, rendered
  as a system-authored note (`packages/engine/src/file-attachment-formatter.ts`).

## Upload route

`packages/api/src/routes/sandbox-file-upload.ts`. Auth is session-owner only:
non-owners get 404, never 403. Sandbox tokens get 404.

Form fields:

| Field | Default | Meaning |
|-------|---------|---------|
| `file` | required | The file part. Must carry a filename. |
| `dest` | `/workspace/uploads/<basename>` | Target path. A trailing `/` means directory; the filename is appended. |
| `extract` | `auto` | `auto` \| `true` \| `false`. `true` on a non-extractable file returns 415. |
| `overwrite` | `false` | Allow writes over existing files. |

Order of operations: Content-Length pre-check → multipart parse → field
validation → path resolution → size cap on the file part → read + hash +
type detection → 415 check → session/sandbox readiness → overwrite checks →
parent mkdir → write → extraction → ref mint.

### Size cap

`VALET_MAX_UPLOAD_BYTES` (default `DEFAULT_MAX_UPLOAD_BYTES` from
`@valet/shared`, 50 MB). Two enforcement points:

1. A request whose Content-Length exceeds the cap (plus 1 MB multipart
   overhead) returns 413 before the body is parsed.
2. The file part itself is checked against the cap after parsing.

Limitation: a chunked body (no Content-Length) is buffered by the multipart
parser before check 2 runs. The cap bounds well-formed clients, not parser
memory.

### Path rules

`packages/api/src/services/path-validation.ts`, applied in order:

1. If `dest` is absent, use `/workspace/uploads/<basename(filename)>`.
2. If `dest` ends with `/`, append `basename(filename)`.
3. Reject when any of these hold:
   - A raw path SEGMENT equals `..` (substrings like `report..v2.pdf` are legal).
   - The path contains a null byte.
   - The normalized path is not under `/workspace/`.
   - The normalized path is exactly `/workspace/`.

### Overwrite contract

With `overwrite=false` (the default), the route checks every path it will
write before it writes any of them:

- Destination exists → 409 ("Retry with overwrite=true, or choose a different dest.").
- PDF sidecar path (`<dest>.md`) exists and `extract=true` → 409.
- PDF sidecar path exists and `extract=auto` → the upload proceeds; the
  existing sidecar is kept; no `markdownPath` is reported.

A `stat` failure that is not a clean not-found (transport error, exec
timeout) returns 500 — it must never read as "does not exist" and bypass
the 409. Not-found detection: node:fs `ENOENT` (docker/local) or the
kubernetes stat probe's exit 2 (`PodFileOpError`).

## Type detection and extraction

Detection is magic-byte only (`%PDF-`, `PK\x03\x04`); the filename never
decides the type.

### Zip (`packages/api/src/services/archive-extract.ts`)

Extract root: the archive path minus a case-insensitive `.zip` suffix, or
`<path>.extracted/` when the name has no such suffix. The rule lives in one
place (`zipExtractRoot`), and clients print the server's `extractedTo`
verbatim.

`extractZip` creates the extract root itself before any entry work — the
raw provider `Sandbox.writeBinary` does not create parent directories, and
a flat zip has no directory entries to trigger a per-entry mkdir.

Guards, in order: entry-count cap (10,000) → per-entry path validation
(empty name, null byte, absolute path, `..` segment, resolve-under-root) →
symlink skip → 100× compression-ratio cap → header sanity → total
uncompressed cap (min(cap × 10, 500 MB)).

On any abort, extractZip deletes every file it wrote and returns a
structured error (the route maps it to 422). Directories created during the
aborted extraction remain. The raw zip stays in place.

A zip that extracts zero files (all symlinks, or only directory entries)
reports NO extraction: `extracted`/`extractedTo` are omitted from the
response and the attachment, so the agent note never points at content that
is not there.

### PDF (`packages/api/src/services/pdf-extract.ts`)

`@firecrawl/pdf-inspector` (native binaries, external to the esbuild
bundle) is imported lazily: a bundle run without node_modules still serves,
and the first PDF extraction fails with a clear message instead of failing
api boot. `extract=true` surfaces that failure as 422; `extract=auto`
degrades to an upload with no sidecar.

Routing: TextBased, or Mixed with confidence ≥ 0.5 → markdown sidecar at
`<dest>.md` and `markdownPath` reported. Anything else → a one-line stub
sidecar and `needsOcr: true`.

## Attachment refs

`packages/api/src/services/attachment-refs.ts`. A ref (`att_` + 128 random
bits) is minted per upload, scoped to the session, single-use, 15-minute
TTL, swept once a minute.

`POST /:id/messages` resolves `fileRefs` by CONSUMING them up front —
the consume loop is synchronous, so two concurrent sends can never both
spend the same ref. Duplicate refs in one request collapse to one
attachment. Any failure before the prompt is queued (a bad ref in the
batch, a submit throw) RESTORES every ref the request took, with the
original `createdAt`, so good refs survive for a retry.

Limitation (known, accepted for now): the store is a process-local Map. An
api restart between upload and send forgets every outstanding ref; the
client must re-upload. The web composer turns the resulting 400 into an
errored chip whose retry re-uploads the held File.

## Engine persistence

The prompt carries `type:"file"` attachments (path, bytes, sha256, optional
mimeType/markdownPath/extractedTo/extractedFiles, name). `Thread`
validation is discriminated on `type` first: a malformed file attachment is
dropped with a warning — it must never fall through to the image branch,
where it would persist as a phantom image and silently vanish from the REST
projection on reload. The transcript note renders from the persisted
attachments on both the hot turn and reload (`entriesToAgentMessages`).

## Web composer

Budgets: 5 files, `DEFAULT_MAX_UPLOAD_BYTES` per file, 250 MB total.
Uploads start on accept; chips show uploading/success/error, and the error
state offers a retry that re-uploads the held File.

Send failure handling: the draft and chips are restored, and the failure is
shown in the composer error strip. When the failure is an
unknown-attachment 400 (expired or lost refs), the restored chips flip to
the error state — a chip must not read as uploaded when its ref is dead.

## CLI

`valet upload` posts one multipart request per file via `InstanceClient`.
It prints the server's `path`, size, short sha256, and — when the response
carries them — `extracted` count and `extractedTo`. Server error bodies are
mapped through `errorMessage`, which prefers the server's `corrective`.
`--message` sends a follow-up with the refs and streams the reply like
`valet send`.

## Error responses

| Status | Cause |
|--------|-------|
| 400 | Bad multipart, missing file/filename, bad `extract` value, invalid path, read error. |
| 404 | Unknown session or non-owner. |
| 409 | Destination (or PDF sidecar with `extract=true`) exists without `overwrite`; sandbox waking (`wake: true`). |
| 413 | Content-Length or file above the cap. |
| 415 | `extract=true` on a non-extractable file. |
| 422 | Zip guard rejection or PDF extraction failure with `extract=true`. |
| 500 | Session load, mkdir, write, or destination-verification failure. |

Every error body carries `error` and a `corrective` naming the next action.
