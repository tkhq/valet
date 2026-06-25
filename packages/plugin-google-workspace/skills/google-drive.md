---
name: google-drive
description: How to use Google Drive tools effectively — file discovery, folder navigation, document creation with markdown, file operations, and template workflows.
---

# Google Drive

You have full access to Google Drive through the Google Workspace integration. Drive is the file system layer — use it to find, organize, create, and download files. For editing the content of Google Docs or Sheets, use the `docs.*` or `sheets.*` tools instead.

## Available Tools

### Discovery (Finding Files)

- **`drive.list_files`** — List files with optional folder, MIME type, ownership, and date filtering. Supports sorting and pagination. Use MIME type shortcuts: "document", "spreadsheet", "folder", etc. Searches only your personal My Drive by default, which excludes Shared Drives (Team Drives); pass `corpora: "allDrives"` to include team/shared-drive files.
- **`drive.search_files`** — Full-text search across all file types by name, content, or both. The fastest way to find any file. Searches only your personal My Drive by default, which excludes Shared Drives (Team Drives); pass `corpora: "allDrives"` to include team/shared-drive files.
- **`drive.list_documents`** — List Google Documents only, optionally filtered by name/content. Searches only your personal My Drive by default, which excludes Shared Drives (Team Drives); pass `corpora: "allDrives"` to include team/shared-drive files.
- **`drive.search_documents`** — Search specifically within Google Documents by name, content, or both. Searches only your personal My Drive by default, which excludes Shared Drives (Team Drives); pass `corpora: "allDrives"` to include team/shared-drive files.
- **`drive.list_folder_contents`** — List files and subfolders within a specific folder. Results are sorted with folders first. Searches only your personal My Drive by default, which excludes Shared Drives (Team Drives); pass `corpora: "allDrives"` to include team/shared-drive files.
- **`drive.get_document_info`** — Get metadata for a file: name, type, owner, sharing status, dates, links.
- **`drive.get_folder_info`** — Get metadata for a folder including child count.

### File Operations

- **`drive.create_document`** — Create a new Google Doc. Optionally provide markdown content that gets converted to formatted Docs content (headings, bold, italic, links, lists, tables).
- **`drive.create_folder`** — Create a new folder, optionally inside a parent folder.
- **`drive.copy_file`** — Copy a file, optionally to a different folder with a new name.
- **`drive.move_file`** — Move a file or folder to a different folder.
- **`drive.rename_file`** — Rename a file or folder.
- **`drive.delete_file`** — Permanently delete a file (cannot be undone).
- **`drive.download_file`** — Download text content of a file. Auto-exports Google Workspace files (Docs to text, Sheets to CSV). Rejects binary files.
- **`drive.create_from_template`** — Copy a template document and optionally replace placeholder text (e.g. `{{name}}` to `Alice`).

## Searching Across Drives (corpora)

All five discovery tools (`list_files`, `search_files`, `list_documents`, `search_documents`, `list_folder_contents`) accept an optional `corpora` parameter that controls which Drive corpus is searched:

| Value | Scope | When to use |
|---|---|---|
| `user` (default) | **My Drive only** — files the user owns or that are shared directly with them. **Does NOT include files that live in a Shared Drive (Team Drive).** | Use only when the user explicitly asks about "my files" / personal Drive. |
| `domain` | Files shared to the user's Google Workspace domain (visible to anyone in the org). | Use for company-wide or org-shared resources the user may not have in their personal Drive. |
| `allDrives` | My Drive **plus every Shared Drive** the user can access. | **Use this whenever the search involves team, project, or company docs** — Shared Drives are invisible under the default `user` corpus. On very large workspaces results may be slightly incomplete; narrow with a more specific query if needed. |

> ⚠️ **Important:** The default `user` corpus silently omits everything stored in a Shared Drive (Team Drive). Most team/engineering/company docs live in Shared Drives, so a default search can come back empty even though the doc exists and the user can open it. When in doubt, search with `corpora: "allDrives"`.

**Tips:**
- Reach for `corpora: "allDrives"` when the user is looking for team/shared/company docs, or whenever a default (`user`) search returns nothing for a doc you expect to exist.
- Use `domain` to target only org-shared files; use the default `user` only for explicitly-personal queries.
- The org admin may set a default corpora via configuration, which overrides `user` unless you pass an explicit value.

## Common Patterns

### Finding Files

Search is the fastest way to find files:

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

Search across all drives (My Drive + shared drives):

```
drive.search_files({ query: "quarterly review", corpora: "allDrives" })
```

Search only organization-shared files:

```
drive.search_files({ query: "company handbook", corpora: "domain" })
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

Google Workspace files are auto-exported: Docs become plain text, Sheets become CSV, Slides become plain text.

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

## Drive Labels Guard

Your organization may have a Drive Labels guard enabled. When active, only files with an admin-configured Google Drive label are accessible.

**If you get "File not found or access denied"** for a file the user says exists, the file likely doesn't have the required Drive label. Tell the user:
- The file needs a specific Google Drive label applied to be accessible to Valet
- They can apply the label in the Google Drive web UI (right-click > Labels)
- Their admin can tell them which label is required

**If search returns fewer results than expected**, the guard may be filtering out unlabeled files. Let the user know that only labeled files are visible.

## Tips

- **Search broadly**: `search_files` searches both file names and content. It's the best starting point.
- **Use document-specific search**: `list_documents` and `search_documents` are faster when you know you need a Google Doc.
- **Browse folders**: `list_folder_contents` shows folders first, then files — good for navigation.
- **Binary files are rejected**: `download_file` only works with text-based and Google Workspace files.
- **Delete is permanent**: `delete_file` cannot be undone. Confirm with the user before deleting.
