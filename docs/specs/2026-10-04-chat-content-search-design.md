# Chat content search

## Thread search

The chat sidebar searches active threads in the current workspace. It matches thread titles, project names, and persisted user and assistant message text.

`GET /api/sessions/:id/threads?q=...` matches titles and message text. The existing session authorization, thread visibility, and archive filters apply. The query uses a case-insensitive literal substring and accepts at most 500 characters. It does not search tool output or reasoning.

The browser adds project-name matches from sidebar preferences. It waits 250 milliseconds after typing before requesting content matches. Loading and error states appear in the search dialog. Users can retry a failed request. Results keep the sidebar's sort order. Selection follows the thread ID when more results arrive.

## Validation

API tests cover title matching, user and assistant text, literal wildcard characters, session isolation, and private team thread visibility. A component test covers selection stability while content matches arrive.
