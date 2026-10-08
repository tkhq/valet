# Native document skills

Status: implemented

## Purpose

Valet can edit native DOCX, XLSX, PPTX, and PDF files in its standard sandbox images.
Users do not need a Google connection to work with native files.
Existing Google Workspace tools remain the route for edits to live Google objects.
A native export uses the file workflow after download.

## Bundled plugin

`@valet/plugin-native-documents` exports a skills-only `ValetPlugin`.
Its manifest enables default registry discovery with `v2: true`.
The API dependency and root TypeScript reference include the package in normal builds.
The plugin has no credential declaration, external MCP server, or connection step.

The plugin loads four original Valet skills:

| Skill | Library | Main operations |
| --- | --- | --- |
| `native-docx` | python-docx | Read, create, and edit Word paragraphs, runs, tables, and sections |
| `native-xlsx` | openpyxl | Read, create, and edit workbook cells, formulas, and formatting |
| `native-pptx` | python-pptx | Read, create, and edit slide shapes, text, tables, and images |
| `native-pdf` | pypdf, reportlab | Read, create, rotate, combine, split, and overlay PDF pages |

Each skill includes an example that edits an existing native file.
Static asset reads let the API binary build embed the Markdown content.
The skills are original project content. They do not copy restricted third-party document skills or scripts.

## Sandbox runtime

The runtime uses `/opt/valet-office/bin/python` with pinned Python dependencies.
The runtime also provides LibreOffice, Poppler tools, and common fonts.
`/opt/valet-office/office.py` exposes `check`, `inspect PATH`, and `validate PATH` commands.
The helper reports JSON results for runtime readiness and file structure.
Validation checks readability and package integrity. It does not prove feature or visual fidelity.
Custom sandbox images must provide this runtime to support the same workflow.

## Editing contract

1. Preserve the source file unless the user explicitly requests an overwrite.
2. Inspect existing structure before editing.
3. Make targeted edits and preserve unaffected content.
4. Save the result to a separate path.
5. Validate and reopen the result.
6. Render the result and inspect changed pages.
7. Compare representative unchanged pages with the source.
8. Attach the native output with `file_attach`.
9. Return its direct download URL and describe unresolved limitations.

The output remains a native file. A rendered PDF or image is a verification artifact.
The agent must not substitute an HTML download page or flattened images for the requested native file.
`file_attach` supplies durable file delivery through the session's authenticated attachment route.

## File delivery

`file_attach` snapshots sandbox bytes into the existing blob store, with a random file ID and separate metadata.
Storage keys include organization, session, and thread identifiers.
The tool checks the upload size limit before reading and after reading.
The returned URL points directly to `/api/sessions/:id/threads/:threadId/files/:fileId`.
The host prefixes the configured public origin for links sent through Slack or other channels.
The origin comes from `VALET_PUBLIC_URL`, or a public HTTPS `BETTER_AUTH_URL`.
The tool does not accept an origin from model arguments or request headers.
Without a configured public origin, links remain relative and work only in the Valet web app.
The tool reports this limitation with instructions to configure `VALET_PUBLIC_URL`.
Recipients must sign in to Valet and pass the existing download authorization checks.
The web renderer accepts relative links and absolute links on its current origin.
The route checks current session access and thread visibility before reading the snapshot.
Workflow engine sessions use the run owner, current team membership, private origin visibility, and private event visibility.
Authorization follows the workflow run detail policy (`ownedRun`), including private-event checks for personal runs.
These sessions have no `agent_sessions` row. The route still requires the requested thread to belong to that engine session.
It sends an attachment disposition and prevents content sniffing and caching.
Downloads do not wake a sandbox and remain available after the source file is removed.
The chat renderer provides a Download link from live and persisted tool results.
`artifact_publish` rejects native document paths and directs the agent to `file_attach`.

### Storage lifetime

Generated files use the host's existing `FsBlobStore`, as browser evidence does.
Set `VALET_BLOBS_DIR` or `VALET_DATA_DIR` to retained storage outside the application release directory.
The standard Helm API deployment currently mounts no persistent blob volume.
Its default writable container storage does not retain downloads after pod replacement.
Helm operators must supply persistent blob storage before promising downloads across API rollouts.
A filesystem-store reopen test verifies retained bytes; it does not verify a deployment's storage configuration.

Generated snapshots have no automatic expiration. Each organization can retain at most 1 GiB of payload bytes and 1,000 files.
Each file remains limited to 50 MiB. The file-count cap also covers empty files and bounds metadata overhead.
The `generated_files` database table stores metadata and reservations. A transaction locks the organization row before checking both caps.
Reservations commit before blob writes and remain charged across API restarts. Independent hosts use the same database lock.
The same filename and bytes in the same organization, session, and thread reuse a completed download.
Other filenames or threads create separate reservations. Pending duplicates cannot start another writer.

A failed write deletes partial blob data before releasing its reservation.
A crash or failed cleanup leaves a charged pending reservation, preventing repeated failures from bypassing the caps.
Pending files cannot be downloaded. Deleted sessions lose download access, but retained files still consume capacity.
Capacity exhaustion refuses new attachments and asks the operator to remove retained files.

To remove retained files or abandoned reservations:

1. Stop attachment writers on every API replica. Confirm that no old writer can resume.
2. Select exact file IDs from `generated_files` within the intended `org_id`.
3. Delete each blob with `BlobStore.delete(generatedFileKey(orgId, sessionId, threadId, id))`.
4. After deletion succeeds, delete each manifest row with both its ID and organization filter.
5. Restart the writers. Monitor pending reservations and disk usage.

Do not delete a reservation before its blob. Do not remove a reservation while a writer can still finish its upload.
This maintenance intentionally invalidates the selected downloads. There is no automatic eviction or new administration UI.

The migration and deployed schema repair create the manifest table and its scoped deduplication index.
Pre-manifest preview blobs have no database reservations. They cannot be counted automatically through the existing BlobStore interface.
Before upgrading such a preview, import its retained files into the manifest or stop writers and remove the legacy generated-file prefix.
Legacy links without manifest rows return 404. Do not claim the new cap covers historical untracked blobs until maintenance finishes.

Deployment requires both the API bundle and rebuilt standard sandbox image.
Existing sandboxes retain their previous image until replaced through the normal sandbox lifecycle.
The skills report a missing runtime instead of claiming that an old image supports editing.

## Format limits

DOCX edits must preserve runs when formatting matters.
Tracked changes, fields, comments, and embedded objects require separate inspection.
XLSX editing preserves formulas with `data_only=False`; openpyxl does not recalculate them.
Unsupported workbook features require a targeted XML edit or an explicit limitation.
PPTX rendering checks visible layout but cannot verify animations or interactive behavior.
PDF overlays do not redact underlying content, and edits invalidate digital signatures.
Library saves and LibreOffice renders cannot guarantee Microsoft Office fidelity.
The agent must report checks that could not run and unsupported features that remain unverified.

## Validation

Package tests load all four skill files through the real Markdown loader.
They check names, credential-free registration, delivery instructions, and format-specific limitations.
The existing API bundled-skill tests validate frontmatter and registry discovery.
Runtime tests exercise native file creation, edits, inspection, validation, and rendering where the tools are available.

The tool returns a relative webUrl for authenticated web downloads and a public-origin url for channel replies. The renderer validates the local path. This keeps downloads on the current login origin when a deployment has multiple domains.
