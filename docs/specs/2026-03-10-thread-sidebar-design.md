# Thread Sidebar for Orchestrator UI

**Date:** 2026-03-10
**Status:** Approved

## Summary

Replace the channel selector dropdown in the orchestrator chat UI with a persistent, collapsible thread sidebar panel. Threads are grouped by their originating channel. Each thread can be dismissed (archived) via a hover-reveal X button. Dismissed threads auto-reactivate when new messages arrive from that channel.

## Motivation

The channel selector dropdown was a workaround — channels route *to* threads, making threads the primary organizational unit. The sidebar makes threads first-class navigation, visually groups them by channel origin, and adds the ability to dismiss threads the user is done with.

## Design

### Thread Sidebar Panel

- ~210px wide, left side of the orchestrator chat area
- **Collapsible** via a toggle button on the sidebar edge. Open by default. Collapse state persisted in localStorage.
- **Header:** "Threads" label + "+" new thread button
- **Body:** Active threads grouped under channel section headers (Web, Slack DM, Slack #engineering). Channel names resolved via the existing `GET /api/channels/label` endpoint. Sections are static visual grouping (not collapsible).
- **Thread items:** Thread title (or first message preview if untitled). Hover-reveal X button to dismiss. Unread badge (count) for threads with activity since last viewed.
- **Subconversations:** A parent with subconversations has an accessible expand/collapse control. Each parent starts expanded. The browser stores the state by parent thread ID.
- **Footer:** "Dismissed" row with count, expandable to show archived threads. Clicking a dismissed thread reactivates it and switches to it.

### Interactions

- **Select thread:** Click sets `activeThreadId`, messages filter to that thread.
- **Dismiss thread:** Hover X → PATCH thread status to `archived` → thread moves to dismissed section → if dismissed thread was active, select the next active thread.
- **Reactivate dismissed thread:** Click in dismissed section → PATCH status to `active` → moves back to active list → becomes selected thread.
- **Auto-reactivate:** When a channel message arrives for an archived thread, the backend flips status to `active`. Sidebar re-fetches and shows it in the active list.
- **New thread:** "+" button creates a new thread (existing `useCreateThread`), selects it.
- **Unread tracking:** The server records when each person last read each thread (`thread_reads`). A thread with an agent message newer than that time, and newer than the last user activity, shows as unread. The open thread's view records the read when the thread opens and when a message lands, and only while the page is visible: a background tab leaves new messages unread.
- **Recap:** When another person wrote to Valet in a thread since the reader's last read, the transcript shows a "New since" line before the first new message, and a card above the composer recaps the new messages in at most three lines (`GET /api/threads/:threadId/recap`). A reader who never opened or wrote in the thread gets a "Where this stands" recap of the whole thread. A short window gets the line only. Activity from Valet alone shows nothing. The card closes with its X or when the reader sends, and it folds to its heading while a question or approval card waits.
- **Who else is here:** A team or shared thread shows the faces of the other people who have it open beside its title, up to three on a desktop and two on a phone, and "<name> is typing..." on top of the composer. Each session WebSocket reports the threads its tab shows, the tab's visibility, and a yes/no typing signal; the API keeps them in memory (`services/active-viewers.ts`), so this needs the single API replica. Closing the socket removes the person at once, a background tab drops after 45 seconds, typing ends 5 seconds after the last signal, and nothing is stored. Thread list rows read `GET /api/threads/viewers` every 15 seconds, because a team workspace's rows span several sessions. Viewer frames pass the socket's per-thread filter, so a private thread or a guest's stream shows only its own people.
- **Team threads:** A reply in a team thread notifies only the people who wrote in it, through any path (web, Slack, an event delivery). The thread list derives this from the stored messages and their authors. For other members the thread stays in the list without an unread mark or a waiting question, and "Waiting on you" leaves it out. A thread that no person wrote in, such as one only a team API key prompts, notifies every member.

### Component Structure

```
ChatContainer (orchestrator)
├── ThreadSidebar (new, ~210px left panel)
│   ├── ThreadSidebarHeader ("Threads" + "+" button)
│   ├── ThreadGroupList
│   │   ├── ThreadGroup (per channel)
│   │   │   ├── ThreadGroupHeader (channel icon + resolved label)
│   │   │   └── ThreadItem[] (title, unread badge, hover X)
│   │   └── ...more groups
│   └── DismissedSection (expandable, count badge)
│       └── ThreadItem[] (click to reactivate)
├── MessageArea (existing, flex:1)
│   ├── Header (session title, active thread title, toolbar)
│   ├── MessageList (filtered by activeThreadId only)
│   └── ChatInput
└── OrchestratorMetadataSidebar (existing right panel)
```

### API Changes

**New endpoint:** `PATCH /api/sessions/:sessionId/threads/:threadId`
- Body: `{ status: 'active' | 'archived' }`
- Updates thread status in DB
- Returns updated thread

**Modified:** `GET /api/sessions/:sessionId/threads`
- Add optional query param `?status=active` to filter by status
- Default (no param) returns all threads (backwards compatible)

**Auto-reactivate:** In channel inbound paths (slack-events.ts, etc.), after resolving the orchestrator thread, check if archived and flip to active. Single UPDATE query.

### What Gets Removed

- `ChannelSwitcher` component and `deriveChannels` function
- `selectedChannel` state in chat-container
- Channel-based message filtering (threads are the only filter)

## Files Changed

| File | Change |
|------|--------|
| `packages/client/src/components/chat/thread-sidebar.tsx` | **New** — sidebar component |
| `packages/client/src/components/chat/chat-container.tsx` | Replace channel switcher with thread sidebar, remove channel state |
| `packages/client/src/components/chat/channel-switcher.tsx` | **Delete** |
| `packages/client/src/api/threads.ts` | Add `useDismissThread` mutation, status filter to `useThreads` |
| `packages/worker/src/routes/threads.ts` | Add PATCH endpoint, status filter to GET |
| `packages/worker/src/lib/db/threads.ts` | Add `updateThreadStatus` helper |
| `packages/worker/src/routes/slack-events.ts` | Auto-reactivate archived threads on new message |

## Out of Scope

- Thread reordering / pinning
- Thread renaming from sidebar (exists in thread detail page)
- Notification sounds or desktop notifications for new thread activity
- Mobile/touch interactions (long-press to dismiss)

### Thread Sort Preference

- The sidebar defaults to **Last user activity**. It orders active threads by each thread's latest user action.
- **Created** orders active threads by creation time, newest first.
- The browser stores the selected mode at `valet:thread-sort`.
- Web, Slack, and Telegram user prompts update the server-derived timestamp. Agent-driven submissions do not update it.
- Timestamp writes are monotonic. A durable WebSocket event updates every connected viewer after persistence.
- Origin filters and the archived-thread section keep their existing order and behavior.

### Progressive loading (2026-10-08, current web UI)

- The current sidebar requests ten recent threads from the server. Scrolling to the end requests the next page.
- A **Load more threads** button supports keyboard use. If a request fails, **Retry** keeps the rows already loaded.
- The server applies authorization, archive state, origin filters, and sort order before it selects a page.
- A cursor uses the sort timestamp, creation timestamp, and thread ID. Equal timestamps do not drop rows.
- Pins, grouped project threads, pending approvals, the selected thread, and the implicit default remain available beyond the recent page.
- Recent pages are independent of pins and projects. A pinned recent row can reduce the number of unpinned rows among the first ten.
- Search checks titles and persisted messages across authorized history. Project-name matches include assigned threads outside loaded pages.
- Page cache keys include the workspace runtime, sort, and origin. Selection, pins, project assignments, and approvals do not reset loaded pages.
- Supplemental rows use separate requests with at most 50 IDs and 3,000 encoded fixed-ID query bytes per batch. These rows ignore origin filters.
- The archived approval marker waits for supplemental reads. An active row outside the origin filter does not imply archived history.
- Workspace switches do not reuse another workspace's rows. The selected thread is requested explicitly when opening its conversation.
- The server and client break equal creation timestamps by ascending thread ID.
- Live activity updates loaded rows without refetching pages. An unloaded row gets one authorized fixed-row read per active activity-sorted list.
- Promoted rows enter the first cached page without changing its cursor. Pending page reads are cancelled before insertion to prevent stale overwrites.
- Supplemental placeholders contain only current pins, project assignments, approvals, and selection. Clearing selection removes its old supplemental row immediately.
- Successful archiving cancels pending activity reads for that thread before refreshing lists. A late response cannot restore the archived row.
- Completed turns and normal list invalidations still refresh the list. A failed activity read uses the existing list retry path.
- Existing mutation updates support both single-page and infinite-query cache shapes.

The first version scans authorized candidate metadata before paging. Activity and pull-request enrichment runs only for returned rows.
This limits response size and enrichment work, but does not bound candidate metadata reads. Unpaged API callers and archived history keep their existing response behavior.


## Start a thread in a project

Each project folder has a visible plus button, including when collapsed.
The button creates a thread with workspace defaults and assigns it to that project using existing sidebar preferences.
Creation expands the project, opens the thread, and focuses the composer.
If creation fails, the project stays unchanged and the sidebar shows retry guidance.
Switching workspaces while creation is pending must not navigate to the previous workspace's thread.

Project folder hover and focus highlights use square corners, matching the adjacent thread selection rows.


### Delete a project

Right-click a project folder header or use its visible menu button to select
**Delete project**. The confirmation explains that every assigned chat will be
archived, including pinned chats and chats outside the loaded pages. An empty
folder can also be deleted. Archived chats remain available in **Show archived**.

The folder and its assignments are removed only after every archive succeeds.
If an archive fails, the folder stays and the dialog offers **Retry delete
project**; chats already archived remain archived. A new assignment from another
tab during the operation also keeps the folder for retry. Deletion uses the
original workspace even if the user switches workspaces while it runs, and does
not navigate or change preferences in the new workspace. Archiving uses the existing chat access checks.
Before each archive starts, the client reads current folder membership from the server.
It skips chats already moved elsewhere and keeps their assignments and pins. A failed membership read stops archiving and keeps the folder.

### Project folders across devices

The server stores project folders, names, assignments, pins, and grouping preferences for each viewer and workspace runtime.
Two devices signed in as the same viewer see the same folders in that runtime.
Other viewers, teams, and organizations keep separate preferences. Team membership does not share a viewer's folder organization with teammates.
The workspace stores assignments and pins for visible threads in its root session, team execution sessions, and migration-retained histories.
Folder sync checks each thread's actual session and governing conversation before accepting or retaining its reference.
It rejects unrelated sessions and conversations hidden from the viewer.
It removes references to archived threads or deleted sessions without removing the folders.
Retry sync can replay a failed assignment after the server recognizes its execution session.
The sidebar refreshes these preferences when the window regains focus. The project menu also offers **Rename project**.

`GET` and `PATCH /api/me/thread-projects/:sessionId` use the signed-in viewer and existing session and thread access checks.
Each write asserts its original viewer ID. If the account changed, the server refuses the write instead of applying it to the new account.
Writes contain individual operations. An atomic revision check retries competing operations against the latest stored state.
A stale folder deletion cannot remove another device's newer assignment or pin.
If another device adds a chat to the folder during archive, deletion stops and offers a retry.
An already-started create or archive can finish its preference changes for its original viewer and runtime after a workspace switch.
It does not update the new workspace or navigate there.

Each browser imports its existing folders by ID and merges unique folders and assignments into the server state.
An import never replaces a server rename, move, explicit unpin, or deletion with an older browser copy.
The server retains deletion and change markers for that purpose. Repeated imports produce the same organization.
The browser retains the original local data. It records a migration marker only after the server acknowledges the import.
A separate local cache stores acknowledged server data. A failed import or unavailable browser storage does not delete the original data.
A failed import still loads the server folders and leaves organizing controls available. The warning offers **Download saved folders** and **Retry sync**.
An import that exceeds storage limits fails atomically. The viewer can remove unused server folders and retry without losing local data.
Imported duplicate names receive a unique numeric suffix; project IDs and assignments remain distinct.
The server removes stale references to archived or deleted chats in bounded batches.
If history markers reach their bound, the server closes legacy imports and compacts the history.
A generation check rejects stale create operations after compaction. New operations use the current server generation.
A browser whose legacy import is closed retains its original data and can download it; normal server folder controls remain available.

The sidebar shows loading and saving states. A failed read or write keeps the last available folders visible and offers **Retry sync**.
Offline requests fail visibly instead of remaining paused. A migration stops if its viewer or runtime changes before it sends the import.

Requests allow at most 2 MiB, 500 operations, 200 folders, 5000 assignments, and 5000 pins.
Folder names allow 100 characters. IDs allow 200 characters.
Each deletion or change marker list allows 20000 IDs. The server rejects an over-limit write without changing the saved data.
