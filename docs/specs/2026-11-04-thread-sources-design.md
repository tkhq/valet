# Thread sources and citations

## Goal

Show where each fact in a reply came from, on the sentence that states it. A tool call that reads an item (a Slack message, a file at a commit, a memory file) returns a source record. The model cites a source by its short id, and the web app shows the source at the end of the sentence. The proof stays on the claim; no separate summary receipt holds it.

This document covers source records, inline citation chips, and navigation to the tool step that fetched a source.

## Decisions

1. A source record has an id, a service, a title, and an optional URL, snippet, and location. The URL is an http(s) link or a Valet web path that starts with `/`. The location names the exact place in the item, such as `L1-L40 at 3f2a1c9` or a message time. `SourceRecord` lives in `@valet/shared`.
2. A tool returns sources without ids: `ToolResult.sources`, or `PluginActionResult.sources` for a plugin action. The tool bridge trims and bounds each source: 20 for each call, 300 characters for a snippet. It drops a source without a service or title.
3. The tool bridge gives each source a thread-scoped id (`s1`, `s2`, and so on) through `ToolContext.allocateSourceIds`. The thread keeps the last number in thread metadata (`sourceSeq`). The patch applies in memory before the save, so parallel calls in one turn never share an id, and a restored thread keeps counting.
4. The model sees the ids in the tool result text, after the tool's own output: a `Sources:` block with one `[sN] title (location)` line for each source.
5. The records ride `details.sources` on the persisted tool result, next to `details.label`. Text-only live tool events also carry these details. REST preserves them when it trims large tool output.
6. If the context has no allocator, or the allocation fails, the bridge drops the sources. An id that the model cannot cite, or that the app cannot resolve, would mislead.
7. The web app lists a call's sources when its step opens, above the tool card. Each row shows the service glyph, title, id, location, and snippet.
8. All models use `[sN]` tags. The system prompt requests a citation after each supported factual claim. At message end, the engine removes unknown tags from prose. A source must exist on a stored tool result in this thread's active history. Reserved source numbers do not count.
9. The web app renders known tags in assistant prose as quiet service icons. Code and Markdown links keep literal tags. Hover or keyboard focus shows a bounded title preview. A click opens a compact panel with a short plain-text excerpt and **Open original** and **Show step** actions. These actions also work on touch screens. Memory previews hide internal team scope ids and use readable document titles. Old stored sources receive the same display cleanup.
10. **Show step** opens the enclosing task card, grouped calls, and tool output. It focuses and scrolls to the call. The source index is scoped to the active thread and its loaded messages. A tag without a loaded source stays plain text.
11. A tool result with `details.ok: false` appears as failed even when the call completed normally. Source existence proves provenance, not that the claim follows from the source.

## Step labels

Every tool call shows one specific line in the task card. No built-in tool or bundled action shows a generic line such as "Used a tool".

1. An action can write its own line with `PluginAction.label(args)`. The engine reads it after a successful call.
2. If an action has no label, or its label throws or says nothing, the engine builds a line from the action name and its arguments (`deriveActionLabel` in `@valet/shared`). Example: `linear.get_issue` with `id: "ENG-123"` gives "Read Linear issue ENG-123".
3. A tool from a connected MCP server gets a label function when the SDK maps it to an action (`deriveMcpToolLabel`). A tool name with an unknown verb gives "Ran <service> <tool name>".
4. While a call runs, the web app shows the agent's one-line purpose, or the same derived line in the present tense. After the call ends, it shows the action's line, then the derived line, then the purpose.
5. Native tools have a verb pair in `BUILTIN` in `work-group.tsx`.
6. Two tests enforce coverage. `packages/api/src/plugins/action-labels.test.ts` runs every bundled action through `actionLabel`. `step-labels.test.tsx` in the web app checks every native tool name found in the engine and API sources.
7. A dynamic MCP service that is not connected has no action list, so the coverage test cannot check its tools. The SDK test covers the mapping.

## First sources

- `slack_user.search_messages`: each match with a permalink. The title names the channel, or says "Direct message" or "Group message", because Slack puts a user id in a DM's channel name. The location is the message time in UTC.
- `github.read_repo_file`: the file at a commit with the line range read (`#L1-L40`). The action resolves the commit before reading and uses that commit for both content and link. If resolution fails, the link keeps the mutable ref without claiming a pinned revision. A PDF has no line range.
- `mem_read`: a memory file, linked to its page in the web app. The source uses the document title and short description when available. A directory index is not a source.
- Gmail message reads and lists: the subject, snippet, and Gmail thread link.
- Drive file and document lists, search, metadata, and downloads: the original document link and available excerpt.
- Slack bot file reads: the file permalink and extracted text.
- `slack.read_history`, `slack.read_thread`, `slack_user.read_history`, `slack_user.read_thread`: each message with text, up to 20. Slack gives no permalink for these reads, and `chat.getPermalink` costs one call for each message. The action calls `auth.test` once for the workspace URL and builds the documented link (`/archives/<channel>/p<ts>`). A reply link carries `thread_ts` and `cid`. If `auth.test` fails, the call returns no sources and keeps its messages.
- Linear (MCP): an issue, or a comment, that has a `linear.app` link. The SDK passes the parsed result of a `get_`, `list_`, `search_` or `find_` tool to the plugin's `sources` function. Writes give no source.
- Notion (MCP): a fetched page, or each search result, with a `notion.so` or `notion.site` link.
- `calendar.list_events`: each event with a link (`htmlLink`) and a title. The location is the start time. Sources omit event descriptions and physical locations, which can contain passcodes. The full tool output keeps these fields. Web previews also omit snippets from older stored Calendar sources. This is specific to Calendar snippets, not general secret redaction.
- `github.get_issue`, `github.get_pull_request`: the page, titled with the repo and number, with the start of its text.
- `browser.execute`: each page the cell read with an accessibility observation (`tab.getAXState`, `tab.getAXStateAndScreenshot`). The source has the page URL without its query, the page title (the host when the title is empty), an excerpt of the snapshot text, and the read time in UTC. The service is `web`. A cell that only navigates, clicks, or takes screenshots gives no source. One URL gives one source for each call.
- `sheets.read_spreadsheet`: the sheet name, the range, and the first rows. `sheets.get_spreadsheet_info`: the title and the sheet count. Both use the Google Sheets service and link to the spreadsheet. The link has no `gid`, because the values API does not return one.

## Presentation

- Source services have readable names: Google Drive, Google Docs, Google Sheets, Google Slides, Google Calendar, Gmail, Linear, Notion, Slack, GitHub and Memory.
- A source list of more than 5 shows the first 5 and a "Show N more sources" button ("Show 1 more source" for one).
- **Show step** opens the call and unfolds its list when the cited source is after the first 5.
- The citation panel says "No link for this source" when a source has no link. The step detail counts sources as "1 source" or "N sources".
- Service icons: Drive, Docs, Sheets, Slides and Calendar use brand marks. Memory and Security use a glyph. Calendar action and source service aliases use the same Calendar mark.

## Privacy

A snippet repeats part of the tool output. The full tool output already persists on the same tool event, and every person who can read the thread can open the tool card. A snippet therefore shows nothing new to a thread reader. A snippet from a private Slack channel in a team thread is the same exposure as that channel's search result in the team thread today. Whether team threads should hold private-channel content at all is an open product question; this change does not answer it.

## Scope and limits

The web app renders chips. Other channels retain plain tags. Native Anthropic citation blocks are not required.
Sources outside the loaded transcript need earlier messages loaded before their chips can resolve.
Memory and document links open the current item; the persisted excerpt captures what the tool read.
The Linear and Notion extractors support structured server output. They are not checked against a live server. Notion raw markup gives no source; no captured hosted response verifies that shape.
These readers give no source, for these reasons:

- Sentry (MCP): results are Markdown text with no structured link per item.
- Fireflies and Granola: no plugin for either service exists in this codebase.
- `docs.read_document`: the action returns no title or link, and its many output formats each need a change. `drive.download_file` already cites a document.
- Browser reads other than an accessibility observation: `tab.domSnapshot`, locator text reads, and `browser.describe` (the browser guide, not a web page). A locator read does not record its page. The daemon also omits an observation from the receipt when the cell's results pass 32,000 characters, and an omitted observation gives no source.
- No other tool fetches the web. The browser is the only path. The `web_search` entry in the engine step labels names no tool in this stack.
- Other GitHub reads (lists, commits, workflow runs, job logs): they return many items or logs, and each needs its own mapping. `github.get_issue` and `github.get_pull_request` cite the page.
Citation opening analytics and measured comparisons across models remain follow-up work.

Citation-open analytics are deferred on purpose. The repo has no path that sends a web interaction to the server, so a count needs a new authenticated endpoint and a privacy decision about recording which sources a person opens.

## Validation

- Shared: `normalizeSource` and `readSources` keep only well-formed records and safe links.
- Engine: the bridge assigns ids, lists them for the model, stores the records, and drops sources without an allocator. Parallel allocations get distinct ids, and a restored thread continues the count.
- Plugins: browser page sources from observation receipts, Slack search sources, GitHub file sources pinned to a commit with a line range, and the fallback link without a commit. Memory file sources and no source for a directory.
- Web: a step counts its sources and lists each with its link.
- Web: chips preserve code and links, isolate thread ids, support keyboard controls, and reveal collapsed tool input and output.
- Eval: `citation_validity` requires a citation and rejects ids without tool sources. It reports citation and invalid-id counts. The judge checks factual citation coverage separately.
- Eval cases: `slack-sources`, `github-sources`, `gmail-sources`, `drive-sources`, `browser-sources` (mocked tools that return sources) and `multi-source-attribution` (mocked Slack and GitHub facts, each requiring its own supporting source). Gmail and multi-source prompts do not request citations. These mocks do not test live integrations. The integration profile excludes dynamic MCP actions, including Linear. Tests check that they parse, that every mocked action exists, and that mock sources get ids. They have not been run against a model.
- Run the model comparison case with `make eval EVAL_ARGS="--cases evals/cases/citations --model <provider/model>"`. Model results are measured only when this command runs with credentials.
