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

`drive.search_files` visits the root and accessible descendant folders in breadth-first discovery order.
Each request contains one parent predicate. Multi-parent OR queries are not used.
For each folder, discovery reads child folder IDs without content or label filters; result queries retain all requested filters.
Folder shortcuts are not traversed. A set of visited IDs prevents cycles.

A continuation stores discovered folder IDs, the current folder, phase, and native Drive page token.
It is authenticated with the account credential and bound to the caller, thread, root, and complete search criteria.
It expires after one hour. Invalid, changed, or expired cursors require a fresh search.
No process-local cache or database migration is required.

Each call makes at most ten HTTP requests and returns at most one native result page.
Empty pages can carry a continuation; callers must follow it to finish the search.
Later pages resume rather than rediscovering folders. Across the complete search, discovery allows 100 folders and 100 pages.
Exceeding a bound returns an error; earlier pages are not a complete search.
HTTP errors and Drive incomplete-search responses return errors with corrective guidance.

Ordering applies within each folder, not globally across descendants.
The results are not a snapshot: concurrent Drive changes and account visibility can affect pagination.
The existing label filter limits returned files. This does not enable the inactive v2 guard wrapper.

## Validation

Mocked HTTP regressions cover nested folders, cycles, empty discovery pages, escaping, label filters, sorting, and result pagination.
They also cover discovery HTTP errors, folder and page limits, and incomplete search responses.
Existing action tests cover default trash and explicit permanent deletion.
These tests do not verify a live Google account or organization policy.
