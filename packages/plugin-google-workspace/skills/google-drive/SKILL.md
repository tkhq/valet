---
name: google-drive
description: How to use Google Drive tools effectively — file discovery, folder navigation, document creation with markdown, file operations, and template workflows.
---

# Google Drive

Google Drive access depends on the connected account, granted scopes, file permissions, and any active organization policy. Use Drive to find, organize, create, and download files. Use `docs.*`, `sheets.*`, or `slides.*` to edit Google Docs, Sheets, or Slides content.

## Available Tools

### Discovery (Finding Files)

- **`drive.list_files`** — List files with optional folder, MIME type, ownership, and date filtering. Supports sorting and pagination. Use MIME type shortcuts: "document", "spreadsheet", "folder", etc.
- **`drive.search_files`** — Search accessible files by name, content, or both. A `folderId` searches its subtree, within traversal limits.
- **`drive.list_documents`** — List Google Documents only, optionally filtered by name/content.
- **`drive.search_documents`** — Search specifically within Google Documents by name, content, or both.
- **`drive.list_folder_contents`** — List files and subfolders within a specific folder. Results are sorted with folders first.
- **`drive.get_document_info`** — Get metadata for a file: name, type, owner, sharing status, dates, links.
- **`drive.get_folder_info`** — Get metadata for a folder including child count.

### File Operations

- **`drive.create_document`** — Create a new Google Doc. Optionally provide markdown content that gets converted to formatted Docs content (headings, bold, italic, links, lists, tables).
- **`drive.create_folder`** — Create a new folder, optionally inside a parent folder.
- **`drive.copy_file`** — Copy a file, optionally to a different folder with a new name.
- **`drive.move_file`** — Move a file or folder to a different folder.
- **`drive.rename_file`** — Rename a file or folder.
- **`drive.delete_file`** — Move a file to trash by default. Set `permanent: true` only for an explicitly requested, irreversible deletion.
- **`drive.download_file`** — Download text content of a file. Auto-exports Google Workspace files (Docs to Markdown, Sheets to CSV). Reads PDF and DOCX as text. Rejects other binary files.
- **`drive.create_from_template`** — Copy a template document and optionally replace placeholder text (e.g. `{{name}}` to `Alice`).

## Common Patterns

### Finding Files

If the user provides a Google URL or file ID, resolve that item directly before searching.
Extract the ID from `/d/FILE_ID`, `/folders/FOLDER_ID`, or the `id` query parameter.
Use `drive.get_document_info` for files or `drive.get_folder_info` for folders.
Keep the resolved ID for subsequent reads and edits.

If the user provides only a title or description, start with a focused name search.
Use a known folder, file type, or date to narrow the search.
If several files match, compare metadata before selecting a target.
Ask the user to choose if the target remains ambiguous.

Follow `nextPageToken` only while more results can help the task.
Keep the same search arguments when you request another page.
An empty page with `nextPageToken` does not mean that the search is complete.
Stop after five pages per query unless the user requests an exhaustive search.
If you stop before the last page, report that the results are partial.
If a query fails, report the error instead of treating it as an empty result.

A folder subtree search supports at most 100 folders and 100 discovery pages per call.
If traversal exceeds either limit, the tool returns an error without partial results.
Narrow the folder scope before retrying.
Folder shortcuts are not traversed.

Search by name or content:

```
drive.search_files({ query: "Q1 budget report" })
```

Search only by file name:

```
drive.search_files({ query: "meeting notes", searchIn: "name" })
```

Find only Google Docs:

```
drive.list_documents({ query: "project plan" })
```

Browse a specific folder:

```
drive.list_folder_contents({ folderId: "folder-id-here" })
```

List files by type:

```
drive.list_files({ mimeType: "spreadsheet" })
```

Find recently modified files:

```
drive.list_files({ modifiedAfter: "2026-01-01", orderBy: "modifiedTime" })
```

### Creating Documents with Markdown

Create a formatted Google Doc from markdown:

```
drive.create_document({
  title: "Meeting Notes",
  markdown: "# Meeting Notes\n\n## Attendees\n- Alice\n- Bob\n\n## Action Items\n1. **Review proposal** by Friday\n2. Schedule follow-up",
  folderId: "folder-id-here"
})
```

The markdown is converted to native Google Docs formatting: headings, bold, italic, links, lists, and more.

### Creating from Templates

Copy a template and fill in placeholders:

```
drive.create_from_template({
  templateId: "template-doc-id",
  title: "Offer Letter - Alice",
  folderId: "hr-folder-id",
  replacements: {
    "{{name}}": "Alice Smith",
    "{{title}}": "Senior Engineer",
    "{{start_date}}": "2026-05-01"
  }
})
```

### Folder Navigation

Navigate a folder hierarchy:

```
drive.get_folder_info({ folderId: "folder-id" })
drive.list_folder_contents({ folderId: "folder-id" })
```

### Reading File Content

Download text content:

```
drive.download_file({ fileId: "file-id" })
```

Google Workspace files are auto-exported: Docs become Markdown, Sheets become CSV, and Slides become plain text.

### Organizing Files

Move a file:

```
drive.move_file({ fileId: "file-id", folderId: "destination-folder-id" })
```

Rename a file:

```
drive.rename_file({ fileId: "file-id", name: "New Name" })
```

Copy a file:

```
drive.copy_file({ fileId: "file-id", name: "Copy Name", folderId: "destination-folder-id" })
```

## When to Use Drive vs Dedicated Tools

Drive is the file system layer. For editing the **content** of Google Workspace files, use the dedicated tools:

| Task | Use This | NOT This |
|------|----------|----------|
| Create a Google Doc with content | `drive.create_document` (markdown) | `docs.insert_text` (lower-level) |
| Edit document sections | `docs.*` tools | drive tools |
| Read structured doc content | `docs.read_document` | `drive.download_file` (loses formatting) |
| Read spreadsheet data | `sheets.read_range` | `drive.download_file` (exports as CSV) |
| Write/format cells | `sheets.*` tools | drive tools |
| Edit slides | `slides.batch_update` | drive tools |
| Find files across Drive | `drive.search_files` | `drive.list_documents` (Docs only) |
| Get file metadata/links | `drive.get_document_info` | docs/sheets tools |
| Move/rename/copy/delete | `drive.move_file`, `drive.rename_file`, etc. | N/A |

## Google Workspace MIME Types

| Type | MIME Type | Shortcut |
|---|---|---|
| Google Docs | `application/vnd.google-apps.document` | `document` |
| Google Sheets | `application/vnd.google-apps.spreadsheet` | `spreadsheet` |
| Google Slides | `application/vnd.google-apps.presentation` | `presentation` |
| Google Forms | `application/vnd.google-apps.form` | `form` |
| Folder | `application/vnd.google-apps.folder` | `folder` |
| PDF | `application/pdf` | `pdf` |

## Access Errors and Verification

A missing file, denied access, or empty search does not establish the cause.
Do not assume that a Drive label is missing.
Check the supplied ID and report the API error accurately.
If authentication fails, ask the user to reconnect Google Workspace.
If permissions fail, ask the user to check the connected account and file sharing.
Mention a required label only when an explicit guard response or confirmed policy identifies it.
If a required label is confirmed, ask the administrator which label to apply.

Read the target before editing its content.
After an edit, read the changed content with the corresponding Docs, Sheets, or Slides tool.
After a metadata change, retrieve the file metadata to verify the result.
If verification fails, report the completed action and the verification failure separately.
Do not claim that unverified changes succeeded.

## Tips

- **Search with context**: Use a supplied ID directly. Otherwise, start with a focused query.
- **Use document-specific search**: `list_documents` and `search_documents` restrict results to Google Docs.
- **Browse folders**: `list_folder_contents` shows folders first, then files — good for navigation.
- **PDF and DOCX files are read as text**: `download_file` returns document text. DOCX includes headers, footers, footnotes, endnotes, and comments. Images are not transcribed. It still rejects other binary files, such as images and zip archives.
- **Trash is the default**: `delete_file` moves items to trash. Use `permanent: true` only when the user explicitly requests permanent deletion.
