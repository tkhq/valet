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
| 2 | Terminal and VS Code on assistant sessions and agent-spawned children | Medium | Rendered on every session (`packages/client/src/routes/sessions/$sessionId.tsx:18`) | Tab strip gated on `profile === "full"` (`packages/web/src/components/session/sandbox-tabs.tsx:48`); assistants and children default to `headless`, and `PATCH /sessions/:id` accepts only `model`, so the profile cannot be raised later |
| 3 | Session code review — run a review, browse diffs by file, act on findings | Large | `packages/client/src/components/session/review-drawer.tsx:19-60` plus the `review/` set | No session-scoped review surface in `packages/web/src`. The only V2 "review" is the repo-level code-review workflow template |
| 4 | Files-changed list for a session, per-file +/- and click-to-open | Medium | `session-metadata-sidebar.tsx:424-432`, served by `GET /sessions/:id/files-changed` | No such route; no `filesChanged` on the wire. Nearest is the per-tool-call diff renderer, which shows one call |
| 5 | Per-thread unread markers | Medium | `thread-sidebar.tsx:12-23,130-132,148-150` | No per-thread read state. Only account-level notification counts. Compounds #7 — the row neither moves nor badges |
| 6 | Remote desktop (VNC) view of the sandbox | Large | `packages/client/src/components/panels/vnc-panel.tsx:17-19` | Zero hits for vnc/novnc/websockify/xvfb anywhere; the gateway proxies exactly two targets, ttyd and vscode |
| 7 | Thread sort by activity, and channel grouping with resolved names | Medium | Sorted `ORDER BY t.last_active_at DESC` server-side, bumped on every message (`packages/worker/src/lib/db/threads.ts:139,162,230,262`); grouped per channel with server-resolved names | Sorts by `createdAt` client-side (`thread-tree.tsx:164`) with no sort control, and `ThreadSummary` carries no activity field. Channels collapse into one bucket. **Partly deliberate** — the code comment at `:152-162` argues an activity sort makes rows move under the cursor while agents work unattended. V2 gained thread search in the trade |
| 8 | Live session log / audit panel | Medium | `packages/client/src/components/panels/logs-panel.tsx:10-26` | Org-scoped surfaces only. Neither filters to a session nor shows lifecycle and tool events |
| 9 | `@`-mention file picker in the composer | Medium | `chat-input.tsx:219,655-702,909` | Slash-command and slash-argument autocomplete exist (`composer.tsx:78-119`); no `@` path. A path can still be typed, so this is discoverability |
| 10 | Session rename | Small | Inline-editable header title (`packages/client/src/api/sessions.ts:353`) | `PATCH /sessions/:id` 400s unless the body has `model`; the header renders `session.title` read-only. Titles come only from the auto-titler |
| 11 | Per-message copy button | Small | `message-item.tsx:125,221,256` | No clipboard code in V2's `message-item.tsx`. Whole-transcript and per-tool-body copy exist |
| 12 | Jump-to-bottom control | Small | `message-list.tsx:108-110`, button at `:164` | Stick-to-bottom ported with the same 80px threshold; no return-to-bottom button |
| 13 | Thread pagination | Medium | Server-side, page and cursor modes (`packages/worker/src/lib/db/threads.ts:128-176`), 30-per-page history route | Loads all threads with no LIMIT (`packages/store-postgres/src/store.ts:635-637`). Latent: no break at small thread counts. Thread counts on a real deployment were not measured |

## Not gaps — do not rebuild these

- **Workspace file browser, preview, search.** There is no `FileBrowser` in `packages/web` and no `/api/files` router, but V2 serves this through the **VS Code tab** on the sandbox gateway. Note the dependency: that tab is profile-gated, so fixing #2 restores this with it.
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
