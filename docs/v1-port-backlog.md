# V1 → V2 port backlog

What the V1 stack did for a user that V2 cannot do yet.

This exists because the V1 test suites are being removed. Those suites were the only
executable record of a large amount of V1 behaviour, so the behaviour they covered is written
down here before they go. Each row cites where V1 did the thing and where V2 does not, so a
reader can check the claim rather than trust it.

Method: every capability was surveyed by one agent and then re-checked by a second agent whose
task was to REFUTE the gap, searching V2 under every name the capability might carry. 90
capabilities were surveyed; 13 gaps survived; one claimed gap was refuted and is recorded in
"Not gaps" below. A false "missing" is worse than a missed gap, because it sends somebody to
rebuild what already exists.

## Ranked by user impact

| # | Gap | Effort | Where V1 did it | Where V2 does not |
|---|---|---|---|---|
| 1 | Prompt attachments — images, PDFs, files, drag-drop, paste, voice notes | Large | `packages/client/src/components/chat/chat-input.tsx:158,388-447,493-501,512,521-534` | Composer is textarea + Send/Stop only; `POST /messages` reads only `text` and `threadId` (`packages/api/src/routes/messages.ts:413-417`). The engine part type survives (`packages/engine/src/types.ts:251`) — nothing is wired to it |
| 2 | ~~Terminal and VS Code on assistant sessions and agent-spawned children~~ **PORTED** | Medium | Rendered on every session (`packages/client/src/routes/sessions/$sessionId.tsx:18`) | Closed: `PATCH /sessions/:id` takes `profile`, and the ⋯ menu turns the services on per session. The tab strip is still gated on `profile === "full"` — the profile is now changeable instead |
| 3 | Session code review — run a review, browse diffs by file, act on findings | Large | `packages/client/src/components/session/review-drawer.tsx:19-60` plus the `review/` set | No session-scoped review surface in `packages/web/src`. The only V2 "review" is the repo-level code-review workflow template |
| 4 | ~~Files-changed list for a session, per-file +/-~~ **PORTED (partly)** | Medium | `session-metadata-sidebar.tsx:424-432`, served by `GET /sessions/:id/files-changed` | Closed for the list: `GET /api/sessions/:id/files-changed` parses the diff the engine already stores at settle time (`capturePatch` → `patches/{sessionId}/{queueItemId}.diff`), so it needs no sandbox. Counts agree with `git diff --numstat`, pinned against real git output. The list carries the time it was captured, and says so when a later turn settled without capturing. **Click-to-open is NOT ported** — see "Deliberately left" below |
| 5 | Per-thread unread markers | Medium | `thread-sidebar.tsx:12-23,130-132,148-150` | No per-thread read state. Only account-level notification counts. Compounds #7 — the row neither moves nor badges |
| 6 | Remote desktop (VNC) view of the sandbox | Large | `packages/client/src/components/panels/vnc-panel.tsx:17-19` | Zero hits for vnc/novnc/websockify/xvfb anywhere; the gateway proxies exactly two targets, ttyd and vscode |
| 7 | Thread sort by activity, and channel grouping with resolved names | Medium | Sorted `ORDER BY t.last_active_at DESC` server-side, bumped on every message (`packages/worker/src/lib/db/threads.ts:139,162,230,262`); grouped per channel with server-resolved names | Sorts by `createdAt` client-side (`thread-tree.tsx:164`) with no sort control, and `ThreadSummary` carries no activity field. Channels collapse into one bucket. **Partly deliberate** — the code comment at `:152-162` argues an activity sort makes rows move under the cursor while agents work unattended. V2 gained thread search in the trade |
| 8 | ~~Live session log / audit panel~~ **PORTED** | Medium | `packages/client/src/components/panels/logs-panel.tsx:10-26` | Closed: `GET /api/sessions/:id/log` is a read model over `engine_events`, which the engine already writes per session with a monotonic `seq`. No new writer, no new table. With no cursor it serves the NEWEST page (`EventStream.readLatest`) and reports `hasOlder`, so a long session is not pinned to its first minutes; the panel follows the newest row. Retention is 7 days and the panel says so |
| 9 | ~~`@`-mention file picker in the composer~~ **PORTED (narrower source)** | Medium | `chat-input.tsx:219,655-702,909` | Closed: the `@` popup reuses `CommandPopup` and the composer's existing keyboard handling. It completes over the session's changed files and the caller's memory documents. **It does not offer the whole workspace tree** — see "Deliberately left" below |
| 10 | ~~Session rename~~ **PORTED** | Small | Inline-editable header title (`packages/client/src/api/sessions.ts:353`) | Closed: `PATCH /sessions/:id` takes `title`, and the header title is an edit box for whoever may administer the session |
| 11 | ~~Per-message copy button~~ **PORTED** | Small | `message-item.tsx:125,221,256` | Closed on dev-v2 by a separate change; this branch adds the render coverage |
| 12 | ~~Jump-to-bottom control~~ **PORTED** | Small | `message-list.tsx:108-110`, button at `:164` | Closed: a return-to-bottom button, shown past the same 80px threshold |
| 13 | ~~Thread pagination~~ **MEASURED, then capped** | Medium | Server-side, page and cursor modes (`packages/worker/src/lib/db/threads.ts:128-176`), 30-per-page history route | Measured first (see below): the busiest session held 5 threads. No cursor was built. `GET /threads` now sorts newest-first, caps at 100, and returns `total`; the sidebar offers "Show more", for the archived list as well. Search and the origin chips run over the loaded page, and the sidebar says so when the cap hides anything. The uncapped read at `store.ts:635-637` is unchanged and is not the real cost — see "What the measurement found" |

## What the measurement found (#13)

Thread counts were measured before anything was built, against the local
deployment's Postgres — 4 sessions, 8 threads, 142 entries, 896 engine events.

| Measure | Value |
|---|---|
| Threads per session, median | 1 |
| Threads per session, maximum | 5 (an orchestrator session) |
| Entries in the busiest session | 108, across 5 threads |

That is a small corpus and a developer machine, so the number alone does not
settle the question. What settles it is where threads come from. Two of the
five callers of `Session.thread(key)` mint a key that human activity does not
bound:

- `packages/api/src/workflows/engine-deps.ts:420` opens
  `signal:workflow:{runId}` — **one thread per workflow RUN**. A workflow with
  an `orchestrator` node on a 15-minute schedule adds ~96 threads a day to the
  assistant's session, forever.
- `packages/api/src/channels/host.ts:722` opens one thread per channel
  conversation. Slack's key is `slack:{channelId}` (per channel, not per
  message thread), so this one IS bounded — by how many channels the assistant
  is in.

So the load is real but it is not a pagination problem: it is an unbounded
render on one session type. A cap plus "Show more" answers that. A cursor
would not have been used by any session measured.

**The uncapped read is not the first thing that breaks.** `GET /threads` reads
`engineSession.listThreads()` — the in-memory map — not the store. The store
read the backlog cites (`store.ts:635-637`) runs inside `Session.rehydrate`
(`packages/engine/src/session.ts:465-470`), which loads every thread AND
issues a separate `getEntries` per thread with no limit. That is an N+1 over
full transcripts on every session restore, and no amount of wire pagination
touches it. It is left alone here deliberately: changing session hydration is
an engine change with reconciliation consequences, not a UI port. It is the
next thing to look at if a long-lived orchestrator ever gets slow to wake.

## Deliberately left

Written down rather than half-built, per row:

- **#4, click-to-open.** V1 opened the file in its own workspace browser. V2
  browses files through the VS Code tab on the sandbox gateway, so the
  equivalent is a deep link into that iframe — which is profile-gated, needs a
  live sandbox, and could not be verified here. The list ships without it.
- **#4, per-file diffs.** The stored patch holds the hunks, so this is
  reachable, but it needs a diff viewer and a second route. The counts answer
  "what did this session touch", which is what the sidebar was for.
- **#9, the workspace tree.** V1 completed against every file in the sandbox.
  Reading that needs a sandbox round trip (`sandbox.readdir`, or a `git
  ls-files` exec — the pattern `api/src/engine/repo-instructions.ts:42` uses),
  and a keystroke must not wake a sandbox. The popup completes over the two
  path sets the client already holds and says so when it has none.
- **#13, thread search over the whole session.** Search and the origin chips
  filter the loaded page in the browser, so a capped list searches only what
  it has loaded. Pushing both to the server is a small route change, but it
  moves a filter that is instant today onto a round trip, and no measured
  session is anywhere near the cap. The sidebar states the limit instead of
  hiding it: the empty state names how many threads were searched, and the
  button below reads "Search N more" while a query is active.
- **#13, thread hydration.** See above.

## Not gaps — do not rebuild these

- **Workspace file browser, preview, search.** There is no `FileBrowser` in `packages/web` and no `/api/files` router, but V2 serves this through the **VS Code tab** on the sandbox gateway. Note the dependency: that tab is profile-gated, so fixing #2 restores this with it. (#2 is done, so it is restored on any session whose profile is raised.)
- **Slash commands.** V2 is ahead — it has command *and* command-argument autocomplete with keyboard navigation.
- **Thread search and origin filtering.** New in V2; V1 had neither.
- **Thread archive / un-archive.** Ported. V1's dismiss/reactivate maps to `useSetThreadArchived` plus the `?archived=1` list.
- **Stick-to-bottom auto-scroll.** Ported, same threshold. Only the manual button is missing (#12).
- **Automatic thread titling.** Present (`POST /sessions/:id/auto-title`). Only manual rename is missing (#10).
- **Per-thread model override.** Present and richer than V1 (`ThreadSummary.model`, `PatchThreadRequest.model`).
- **Thread rename.** Never existed on either side — V1's thread PATCH accepted only `status`. #10 is sessions only.

## Caveats

Two claims in this document were not verified to the end, and are marked here rather than
presented as settled:

- Gap #7 states the engine persists a thread `updatedAt` (`packages/engine/src/types.ts:106`,
  `packages/store-postgres/src/store.ts:349`). Whether that value is bumped on message append
  was NOT confirmed. An activity sort depends on it being fresh.
- The file-browser refutation was checked as far as the VS Code tab wiring, not end to end.
