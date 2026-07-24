# Orchestrator Thread List — Tabs by Origin

**Author:** Jarvis (via Conner)
**Date:** 2026-07-24
**Status:** Implemented (round 4) — PR #173, branch `feat/orchestrator-thread-tabs`

> **Revision history**
> - **Round 1** — client-side bucketing of one flat page. No backend changes.
> - **Round 2** — moved filtering server-side (`originBucket` param), added
>   server-computed per-bucket totals (`originCounts`) and per-bucket
>   pagination. Backend changes.
> - **Round 3** — re-added client-side bucket filtering as defense-in-depth
>   (round 2 had a version-skew bug), fixed tab-bar truncation, hid the thread
>   list scrollbar.
> - **Round 4** — skew *compensation*: detect a bucket-filter-ignoring worker at
>   runtime and overfetch + cap so each tab still loads up to 30 threads by
>   default in both worlds. Self-retires on deploy.
>
> This doc describes the CURRENT (round 4) design. Where round 1's design was
> replaced, the rationale for the change is recorded rather than deleted.

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
| `origin_type` | `'web'` (default in `createThread`), `'automation'` (triggers.ts, workflows/nodes/orchestrator.ts, worker/src/index.ts), or a channel type string like `'slack'` / `'telegram'` (channel-threads.ts) | Whoever creates the thread |
| `origin_channel_type` | `ChannelType` = `'web' \| 'slack' \| 'github' \| 'api' \| 'telegram'` | Channel-originated threads |
| `origin_channel_id` | Channel-specific id | Channel-originated threads |
| `origin_trigger_id` | Trigger UUID | Automation-originated threads |
| `origin_trigger_type` | Config trigger type (`'schedule'`, etc.) | Automation-originated threads |

Legacy threads may have neither `origin_*` populated; the UI falls back to
`channelType` / `channelId` on the thread row itself, and the worker falls back
to the earliest `channel_thread_mappings` row.

`getThreadGroupTarget` (`thread-sidebar.tsx:118`) normalizes these into a
`(channelType, channelId)` key for **sub-grouping inside a tab**. Tab
membership is a separate, coarser concern — see below.

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

### Single source of truth for the taxonomy

The bucket id set lives in `@valet/shared`
(`ThreadOriginBucketId`, `packages/shared/src/types/index.ts:272`) because the
rule is now implemented **twice** — once in TypeScript and once in SQL:

| Implementation | Location |
|---|---|
| Client | `getThreadOriginBucket` — `thread-origin-buckets.ts` |
| Worker (SQL `CASE`) | `originBucketCaseSql` — `packages/worker/src/lib/db/threads.ts:28` |

These MUST classify identically, including the legacy
`channel_thread_mappings` fallback. Change them together; the worker tests
(`threads.test.ts`) cover the legacy-fallback parity case.

## Attention-required surfacing (the hard part)

**Solution:** per-tab numeric badge for attention-needed threads that are NOT
in the currently active tab.

Rationale:
- Reuses the existing `responseRequiredThreadIds` set already computed at the
  chat container level (`chat-container.tsx:283`) from `interactivePrompts`
  (approvals, questions).
- Symmetric with the existing per-thread bell icon in `ThreadItem`, so the
  visual language is consistent.
- Rejected alternatives:
  - **Pinned "Needs attention" section spanning tabs.** Duplicates threads
    (they appear in the pinned section AND their origin tab), which drove the
    2026-07-23 confusion when we prototyped it. Also fights the tab metaphor
    ("what tab am I in?").
  - **Global banner on tab bar.** Doesn't tell you WHICH tab needs attention.
  - **Auto-switch tab on new attention.** Hostile — steals context from the
    current tab.

### Attention badges across unfetched buckets

Once the sidebar fetches only ONE bucket (round 2), a pending prompt in
another bucket has no loaded thread row to attribute the badge to. Handled by
`attentionBucketFromPrompt` + `mergeBucketCounts`:

- `attentionBucketHint` (`chat-container.tsx:292`) maps threadId -> bucket,
  derived best-effort from `interactivePrompt.channelType`.
- `mergeBucketCounts` counts attention from loaded threads first (authoritative
  — the thread row's own bucket), then falls back to the hint map for
  response-required ids that were NOT in the loaded page. Ids present in both
  are not double-counted.

The hint is explicitly **not** authoritative: a loaded `SessionThread` +
`getThreadOriginBucket` always wins.

## Filtering, counts, and pagination

Three separate concerns that round 1 conflated:

### 1. Which threads a tab shows — filtered on BOTH sides

`GET /api/sessions/:id/threads?originBucket=<id>` filters server-side
(`listThreads`, `packages/worker/src/lib/db/threads.ts`). The client then
**re-filters the returned page** via `selectVisibleBucketThreads`
(`thread-sidebar.tsx:193`) / `filterThreadsByBucket`.

**This redundancy is deliberate and load-bearing.** Round 2 removed the
client-side filter and trusted the server. A worker build that predates
`originBucket` support silently *ignores* the unknown query param and returns
every bucket — so the sidebar rendered all origins under whichever tab was
selected. Conner hit exactly this on the deployed preview: the **UI** tab
listed `WEB`, `AUTOMATIONS`, and `SLACK DM` group headers simultaneously.

Since the frontend and worker deploy independently, "client trusts server" is
only correct when they're in lockstep. The split of responsibilities is now:

| Layer | Job | Failure mode if it were alone |
|---|---|---|
| Server `originBucket` | **Efficiency** — keeps per-bucket pagination honest, avoids over-fetching | — |
| Client re-filter | **Correctness** — right threads under the right tab | Sparse pages under skew, but never *wrong* threads |

Regression tests: `thread-sidebar.test.ts` feeds a deliberately mixed-origin
page (simulating a worker that ignores the param) and asserts no foreign
thread — and no foreign group *header* — renders for any selected bucket.

#### Skew compensation (round 4) — keeping "30 per tab" true in both worlds

The client re-filter fixes correctness but leaves a **capacity** gap: under
skew a `pageSize=30` request returns 30 *mixed* threads, so after filtering a
tab renders only its share (~7-12 rows). Tabs under-fill until the worker
deploys.

Round 4 closes it with a runtime probe. A worker that understands
`originBucket` **always** returns `originCounts` when counts are requested
(`wantsCounts = !!originBucket || !!includeOriginCounts`,
`packages/worker/src/lib/db/threads.ts:386`); one that predates the feature
never does. So *the absence of `originCounts` on a response that asked for it
proves the bucket filter was ignored* — `backendIgnoredBucketFilter`.

On that signal, `planBucketFetch` overfetches: request
`SIDEBAR_PAGE_SIZE * 4` rows **without** the (ignored) `originBucket` param,
then filter and **cap** the render at `SIDEBAR_PAGE_SIZE * pagesForActiveBucket`
via `selectVisibleBucketPage`. The render cap is identical in both worlds —
that's the point. `Load more` still adds exactly 30 per click, and reveals
already-overfetched rows with no round-trip.

Three details that matter:

- **The flag is latched in React state, not derived inline.** Deriving it from
  the current response would oscillate: flipping it changes the react-query
  key, so `data` goes `undefined` for the new key, which reads as "not skewed"
  and flips it straight back.
- **Overfetch is clamped to `MAX_THREADS_PER_REQUEST = 100`**, mirroring the
  route's own `Math.min(..., 100)` clamp (`routes/threads.ts:84`) — which
  predates this branch and therefore also applies to the old deployed worker.
  Requesting past it would silently truncate and make `hasMore` lie.
- **`hasMore` is no longer just the server's flag.** It's true when we hold
  more bucket rows than we render, and false once `pageSize` has hit the
  request cap with everything shown — otherwise `Load more` becomes a no-op
  button.

This path **self-retires**: the first response carrying `originCounts` flips
the flag off and restores precise per-bucket fetching, permanently and at
runtime. Nothing needs to be removed when the worker ships.

The history page (`routes/sessions/$sessionId/threads/index.tsx`) has the same
under-fill, but can't simply overfetch in place: `page` counts offsets in the
*mixed* stream, so filtering page N and capping it at 30 would silently skip
bucket rows that fell past page N-1's cap. Under skew it therefore switches to
the sidebar's cumulative-window model (`planBucketHistoryFetch`) — request one
`page: 1` window big enough to cover pages 1..N, slice it client-side, and
derive `totalPages` from the *filtered* window so the pager doesn't advertise
pages that render empty. Cost while skewed: history reaches only the newest
`MAX_THREADS_PER_REQUEST` threads. Lossless within that window, and it
self-corrects on deploy.

### 2. Tab counts — TRUE totals, independent of the active filter

A tab label must show the real size of its bucket even when that bucket isn't
loaded. `listThreads` therefore piggybacks per-bucket totals onto the same
response as an optional `originCounts` field on `ListThreadsResponse`
(`packages/shared/src/types/index.ts:294`), requested with
`includeOriginCounts=1` (implicit whenever `originBucket` is set).

Crucially the count aggregate runs against `baseWhere` (session|user + status)
and **not** the bucket-filtered `WHERE` — that independence is the whole point.
It's a single `GROUP BY bucket` over the same join, so it costs one extra cheap
aggregate rather than a second round-trip.

`mergeBucketCounts` prefers these server totals for `total`, and computes
`attentionNeeded` client-side (it's a runtime signal, not a persisted column).
When `originCounts` is absent (older worker), it falls back to counting the
loaded page — which is why `selectActiveThreads` deliberately spans *all*
buckets in the payload rather than being bucket-scoped.

### 3. Per-bucket pagination

Round 1's bug: one flat 30-item page split across four buckets meant a busy
Automation bucket (10+ threads) starved Slack (2 threads) of visible rows.
Because each bucket is now its own query, each paginates independently —
starvation is structurally impossible.

- Sidebar: `SIDEBAR_PAGE_SIZE = 30`, grown by a `Load more` button
  (`pagesForActiveBucket` counter). Switching tabs resets the counter so a
  bucket can't inherit another's deep scroll. **30 is a render cap, not just a
  fetch size** — under backend skew the fetch is deliberately larger than the
  cap (see "Skew compensation" above).
- History page: standard `page`/`pageSize` pagination (`HISTORY_PAGE_SIZE = 30`),
  bucket in the URL (`?bucket=`), page reset to 1 on tab switch.

**Open question (deferred):** `Load more` button vs. scroll-triggered
infinite pagination in the sidebar. Button shipped because it's predictable and
doesn't fight the scroll-position restore; Conner hasn't picked a preference.

Alternative considered and rejected: **just raise the flat fetch limit.**
It only moves the starvation threshold instead of removing it, and it fetches
strictly more data than any one tab can display.

## Layout decisions

### Sidebar width: 210px -> 248px (+18%)

Four tabs with labels and count pills don't fit in 210px. Conner's constraint
was to widen "a little bit but not too much", so 248px — enough for
non-truncating tabs, small enough not to meaningfully narrow the transcript.

Set in **two** places that must stay in sync, or the transcript jumps sideways
when the lazy chunk resolves:
- `ThreadSidebar` — `thread-sidebar.tsx:612`
- `ThreadSidebarFallback` (Suspense skeleton) — `chat-container.tsx`

### Tab labels must fit deterministically, not truncate

Round 2 rendered `UI 12 | SL… 2 | AU… 16 | OTHER` — truncation made the tabs
unreadable, and ellipsizing a 5-char label costs more width than it saves.
The fix is labels **sized to fit** rather than labels allowed to shrink:

- `shortLabel` (<=5 chars: `UI` / `SLACK` / `AUTO` / `OTHER`) for the narrow
  sidebar; the full `label` ("Automation") is kept for the wide history page
  and carried in the `title` + `aria-label` tooltip so nothing is lost.
- `tracking-wider` **dropped** — at 0.05em it added ~0.5px/char (~5px across
  "AUTOMATION") for no legibility gain at 10px. Labels are pre-uppercased in
  data instead of via the `uppercase` class.
- Counts >99 render as `99+` (`formatTabCount`, `thread-sidebar.tsx:323`) so
  pill width is bounded and the math holds at any thread volume.
- `truncate`/`min-w-0` **removed** from the label span, making a mid-word
  ellipsis structurally impossible rather than merely unlikely.

Width budget at 248px:

```
248px / 4 tabs                                    = 62.0px per tab
  - px-0.5 both sides                             = 58.0px content box
worst case ("SLACK"/"OTHER" + 2-digit pill):
  5 chars x ~6.6px (10px semibold, normal tracking) = 33.0px
  + gap-1                                           =  4.0px
  + pill (min-w-[16px], px-1)                       = 16.0px
                                                total 53.0px  <= 58.0 ✓
```

`THREAD_ORIGIN_SHORT_LABEL_MAX_CHARS` encodes the 5-char ceiling and is
asserted in `thread-origin-buckets.test.ts`, so adding a longer-labelled
bucket fails a test instead of silently truncating in the UI.

### No visible scrollbar on the thread list

Conner asked for no visible scrollbar (scrolling itself unchanged). Added a
`.scrollbar-none` utility to `@layer utilities` in
`packages/client/src/styles/globals.css`, applied to the sidebar list and the
history page list.

All three declarations are required for cross-browser coverage:
`scrollbar-width: none` (Firefox), `-ms-overflow-style: none` (legacy Edge/IE),
`::-webkit-scrollbar { display: none }` (Chrome/Safari/WebKit+Blink). The
WebKit rule also has to override the global 6px `::-webkit-scrollbar` styling
declared in `@layer base` of the same file.

A utility (not a one-off inline style) because the repo had no existing
`scrollbar-none`/`no-scrollbar` helper and two call sites already need it.

## Backend / API changes

Round 1 needed none. **Round 2 added:**

- `packages/shared/src/types/index.ts` — `ThreadOriginBucketId`,
  `OriginBucketCounts`, optional `ListThreadsResponse.originCounts`.
- `packages/worker/src/lib/db/threads.ts` — `originBucketCaseSql`,
  `isThreadOriginBucketId`, `computeOriginCounts`; `listThreads` extended with
  `originBucket?` / `includeOriginCounts?` (existing callers unaffected).
- `packages/worker/src/routes/threads.ts` — parses `originBucket` and
  `includeOriginCounts`. Unknown bucket values are **silently dropped** rather
  than 400ing, so a stale frontend degrades to an unfiltered list instead of a
  broken one.

Both additions are backward-compatible: `originCounts` is optional and the
filter is opt-in.

## Preserved behavior

- Cross-orchestrator-session thread aggregation (`userId` -> `crossSession`
  mode), so history survives session rotation/hibernation.
- Dismissed threads are fetched **unfiltered** by bucket — that section is a
  global low-noise archive and its count stays authoritative.
- Auto-switching to the active thread's bucket on deep-link/selection. This
  resolves against the raw fetched page, not the bucket-filtered list — the
  filtered list only ever contains the active bucket, so checking there could
  never detect a mismatch. It stays keyed on `activeThreadId` alone;
  re-running on every fetch would snap the tab back and fight manual clicks.
- All existing keyboard/hover/rename/dismiss behavior.
- `groupThreadsByChannel` sub-grouping within a tab, unchanged.

## Testing

- `thread-origin-buckets.test.ts` — `getThreadOriginBucket` (each bucket +
  legacy fallback), `computeBucketCounts`, `mergeBucketCounts` (server-total
  precedence, hint-map attribution, no double-count),
  `attentionBucketFromPrompt`, and the `shortLabel` width invariants. Round 4
  adds `backendIgnoredBucketFilter` (skew probe, incl. all-zero counts still
  meaning "supported" and no-response meaning "assume healthy"),
  `planBucketFetch` (identical `visibleLimit` in both worlds, bucket param
  dropped under skew, request cap never exceeded) and
  `planBucketHistoryFetch` (cumulative window, contiguous non-skipping slices).
- `thread-sidebar.test.ts` — `groupThreadsByChannel` (unchanged), plus the
  round-3 defense-in-depth guard: a mixed-origin page must never leak a
  foreign thread or group header into a bucket, exact page partitioning,
  archived-thread exclusion, order preservation, and `formatTabCount` bounds.
  Round 4 adds `selectVisibleBucketPage`: fills a tab to 30 from an
  overfetched mixed page, caps at `visibleLimit` while preserving newest-first
  order, per-bucket independence, and the `hasMore` rules (reveal held rows,
  suppress the no-op button at the request cap).
- `packages/worker/src/lib/db/threads.test.ts` — real in-memory D1
  (better-sqlite3): `originCounts` independence from the bucket filter,
  bucket-fill independence (busy Automation must not starve Slack),
  within-bucket pagination, page-mode counts, backward-compat omission, and
  legacy `channel_thread_mappings` bucketing parity with the client.
- `packages/worker/src/routes/threads.test.ts` — param forwarding, unknown
  bucket defensive drop, `includeOriginCounts=1` parsing.

## Known non-issues

`packages/worker/src/lib/oauth-state.test.ts > rejects tampered signature` was
a ~6-10% base64url flake unrelated to this work; fixed on this branch in
`49afcdf4`.
