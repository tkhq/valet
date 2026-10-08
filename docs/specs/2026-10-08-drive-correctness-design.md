# Google Drive search and skill correctness

Date: 2026-10-08

## Problem

The Drive skill claimed full access and described every deletion as permanent. It also inferred missing labels from generic access errors.
The folder search used an unsupported `in ancestors` query despite promising subtree search.

## Behavior

The skill describes access through the connected account, scopes, file permissions, and active policy.
It resolves supplied URLs and IDs before search. It routes content edits to Docs, Sheets, and Slides tools.
It requires focused searches, bounded pagination, accurate error reporting, and verification after edits.
The skill describes trash as the default. Permanent deletion requires an explicit user request.
A generic access error does not establish that a Drive label is missing.

## Subtree search

Google documents `parents` as the supported parent membership query term.
See the [Drive search reference](https://developers.google.com/workspace/drive/api/guides/ref-search-terms).

`drive.search_files` discovers the root folder and its accessible descendant folders before searching for matching files.
Each discovery request lists non-trashed child folders with a valid `in parents` clause.
Discovery follows page tokens, including tokens on empty pages. A set prevents duplicate traversal and cycles.
Folder shortcuts are not traversed.

The discovery phase allows at most 100 folders, including the root, and 100 response pages per call.
Exceeding either bound returns an error that asks for a smaller subtree. It never returns a partial success.
HTTP errors and incomplete searches also return errors.

Discovery reads only folder IDs. It does not apply result filters to intermediate folders.
This lets searches find a matching file beneath an unlabeled folder or a folder with an unrelated name.
The final search combines escaped parent clauses with content, MIME type, date, trash, and label filters.
The existing label filter still limits returned files. This change does not enable the currently inactive v2 guard wrapper.

One final Drive request retains native ordering, page size, and page tokens across the whole subtree.
Folder IDs are sorted to keep the query stable when discovery order changes.
Each pagination call repeats discovery. Changes to the folder tree can change the query between calls.
Callers must restart pagination if the tree changes or Drive rejects a page token.
Search results remain limited to files visible to the connected account.

## Validation

Mocked HTTP regressions cover nested folders, cycles, empty discovery pages, escaping, label filters, sorting, and result pagination.
They also cover discovery HTTP errors, folder and page limits, and incomplete search responses.
Existing action tests cover default trash and explicit permanent deletion.
These tests do not verify a live Google account or organization policy.
