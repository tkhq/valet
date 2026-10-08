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
- **Unread tracking:** Track "last viewed" per thread in localStorage (threadId → timestamp). Threads with messages newer than last-viewed show a badge.

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
- Live activity updates loaded rows without refetching pages. Completed turns and normal list invalidations still refresh the list.
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
not navigate or change preferences in the new workspace. Project folders remain
personal browser preferences; archiving uses the existing chat access checks.
