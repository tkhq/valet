# Orchestrator Thread List — Tabs by Origin

**Author:** Jarvis (via Conner)
**Date:** 2026-07-24
**Status:** Design + initial implementation

## Problem

The orchestrator thread list (rendered by `ThreadSidebar` inside the chat, and
`ThreadHistoryPage` at `/sessions/$sessionId/threads`) is a single scrollable
list of threads. When automation/scheduled-trigger threads fire — which they
do frequently, and often in bursts — they crowd the top of the list and push
Slack- and UI-originated threads out of view.

Conner's stated fix (2026-07-23 meeting):

> "Add tabs at the top (e.g. 'Web Automations', 'Slack') and sort by origin
> workflow."

## The hard part

The flat list made it easy to notice threads that need human intervention
(pending approval, question, or escalation). If we split into tabs, an
attention-needed thread can be hidden inside a tab the user isn't looking at.
The design must not regress this.

## Origin data model (grounded)

Threads carry origin metadata on the `session_threads` row (see
`packages/worker/src/lib/schema/threads.ts:5-25`):

| Column | Values observed | Set by |
|---|---|---|
| `origin_type` | `'web'` (default in `createThread`, threads.ts:94), `'automation'` (triggers.ts:185, workflows/nodes/orchestrator.ts:81, worker/src/index.ts:860), or a channel type string like `'slack'` / `'telegram'` (channel-threads.ts:85) | Whoever creates the thread |
| `origin_channel_type` | `ChannelType` = `'web' \| 'slack' \| 'github' \| 'api' \| 'telegram'` (shared/src/types/index.ts:1084) | Channel-originated threads |
| `origin_channel_id` | Channel-specific id | Channel-originated threads |
| `origin_trigger_id` | Trigger UUID | Automation-originated threads |
| `origin_trigger_type` | Config trigger type (`'schedule'`, etc.) | Automation-originated threads |

Legacy threads may have neither `origin_*` populated; existing UI falls back to
`channelType` / `channelId` on the thread row itself.

The existing `getThreadGroupTarget` helper
(`packages/client/src/components/chat/thread-sidebar.tsx:90-107`) already
normalizes these into a `(channelType, channelId)` bucket key. This design
reuses it.

## Tab taxonomy

Four fixed tabs, in a fixed order:

1. **UI** — `originType === 'web'` (or legacy web fallback)
2. **Slack** — `originType === 'slack'` OR `originChannelType === 'slack'` OR legacy `channelType === 'slack'`
3. **Automation** — `originType === 'automation'`
4. **Other** — everything else (telegram, github, api, unknown)

**Why "Other" and not one tab per channel?** Today the volume of
telegram/github/api-originated orchestrator threads is negligible; a
per-channel-type tab explosion (Telegram, GitHub, API, plus every future
integration) burns horizontal space and adds cognitive load. Inside the Other
tab we still sub-group by channel/origin using the existing grouping helper,
so users can find them. If Telegram (or any single origin in Other) grows,
promote it to its own tab — a one-line change to `THREAD_ORIGIN_BUCKETS`.

**Within the Automation tab**: keep the existing sub-grouping so multiple
triggers stay legible. We sub-group by `originTriggerId` (falling back to
`originTriggerType`) and show trigger label as the sub-header. Threads without
a trigger id land in a "Miscellaneous" bucket. This satisfies the "sort by
origin workflow" ask.

## Attention-required surfacing (the hard part)

**Solution:** per-tab numeric badge for attention-needed threads that are NOT
in the currently active tab.

Rationale:
- Reuses the existing `responseRequiredThreadIds` set already computed at the
  chat container level (`chat-container.tsx:281-284`) from
  `interactivePrompts` (approvals, questions).
- Zero backend or API changes required — purely a client-side derivation from
  data we already have.
- Symmetric with the existing per-thread bell icon in `ThreadItem`
  (`thread-sidebar.tsx:223-231`), so the visual language is consistent.
- Rejected alternatives:
  - **Pinned "Needs attention" section spanning tabs.** Duplicates threads
    (they appear in the pinned section AND their origin tab), which drove the
    2026-07-23 confusion when we prototyped it. Also fights the tab metaphor
    ("what tab am I in?").
  - **Global banner on tab bar.** Doesn't tell you WHICH tab needs attention.
  - **Auto-switch tab.** Hostile — steals context from the current tab.

Additionally, when the current tab has attention-needed threads, we sort them
to the top within their sub-group so they're visible without scrolling.

## Component/state changes

### `packages/client/src/components/chat/thread-sidebar.tsx`

New:
- `THREAD_ORIGIN_BUCKETS` — declarative `{ id, label, matches(thread) }` list.
- `bucketForThread(thread)` — returns bucket id.
- `computeBucketCounts(threads, responseRequiredIds)` — returns per-bucket
  `{ total, attentionNeeded }`.
- Tab bar UI at the top of `ThreadSidebar`, using existing `Tabs`/`TabsList`
  primitive from `packages/client/src/components/ui/tabs.tsx` (keeps styling
  aligned with the rest of the app). Extended with a small numeric badge per
  tab that renders when `attentionNeeded > 0`.
- Persist last-selected bucket in `localStorage` (`thread-sidebar-bucket`).

Preserved:
- `groupThreadsByChannel` continues to do sub-grouping within a tab.
- Dismissed threads section stays global (not per-tab) — it's a low-noise
  archive.
- All existing keyboard/hover/dismiss behavior.

### `packages/client/src/routes/sessions/$sessionId/threads/index.tsx`

Same tab bar, same taxonomy, applied above the paginated list. The paginated
list is filtered client-side after fetch. Pagination + filter interaction: for
this first pass we filter within the current page (30 items). If a page ends
up empty for a tab, the paginator still shows "Prev / Next" — the user can
walk pages until they find matches. This mirrors how `SessionTable` treats
its filters. A server-side filter pass can be a follow-up (see below).

### Grouping utility split

`groupThreadsByChannel` is retained as-is and moves nothing; a thin new helper
`getThreadOriginBucket` is added and unit-tested. The two live side-by-side —
one buckets into tabs, the other sub-groups within a bucket.

## Backend / API changes

**None required for this PR.** Everything derives from data the client already
fetches.

Follow-up (out of scope): a `?originBucket=` query param on
`GET /sessions/:id/threads` so pagination is bucket-aware. Only needed if the
history list becomes long enough that client-side filtering feels sparse.

## Testing

- Unit tests in `thread-sidebar.test.ts` (co-located): extended to cover
  `getThreadOriginBucket` (each bucket + fallback) and
  `computeBucketCounts` (attention math across buckets).
- Existing `groupThreadsByChannel` tests remain untouched — no behavior
  change to sub-grouping.
