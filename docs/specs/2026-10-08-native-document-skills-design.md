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
The route checks current session access and thread visibility before reading the snapshot.
It sends an attachment disposition and prevents content sniffing and caching.
Downloads do not wake a sandbox and remain available after the source file is removed.
The chat renderer provides a Download link from live and persisted tool results.
`artifact_publish` rejects native document paths and directs the agent to `file_attach`.

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
