# Assistant-Centered Web UI — Design Spec

> Reimagines `packages/web` around the orchestrator ("the assistant") as the center of the product, replacing the flat session-list home. Covers information architecture, the four surfaces (dashboard, chat, memory, sessions), the supporting API additions, and the visual language. Applies to the greenfield stack only (`packages/web` + `packages/api`); the legacy client is untouched.

## Problem

Phase 4 added the orchestrator, memory, signals, and child sessions to the engine/API — but the web UI still presents everything as a flat list of interchangeable sessions. The orchestrator is just another chat with a colon-y id; memory has no surface at all; child sessions look identical to top-level work; `child.settled` signals render as fake "You" messages. The product's actual shape — a persistent assistant with durable memory that delegates work — is invisible.

## Direction (decided with the user)

1. **Home is an assistant dashboard** (legacy-orchestrator-page-like), not the chat itself and not a session list.
2. **Two kinds of sessions, kept distinct.** The assistant is the daily driver; **standalone sessions** are the automation substrate (heavily used by workflows in Phase 5) and keep their own area. **Orchestrator-derived (child) sessions nest inline in the assistant's page**, under the thread that spawned them — they never appear in the standalone list.
3. **Standalone sessions have no thread UI.** One self-contained chat per standalone session (the engine's default thread underneath, never surfaced).
4. **Memory is browse + read + search** this pass. Writes stay agent-mediated ("ask the assistant to edit it"); no UI editing.
5. **The assistant is named and given a personality on first visit**, and users are actively encouraged to do both: one step, suggested name + reroll, plus a personality field seeded by selectable trait chips ("warm and direct", "dry wit", "meticulous planner", "cheerful hype-person") that compose into editable free text. Skippable (defaults to a neutral persona), editable later from the dashboard identity header. No avatar/handle ceremony.
6. **Org visibility is deferred** to a future `/org` page; the dashboard stays personal, with the activity feed shaped to accept org events later.
7. **Aesthetic: calm companion** — warm, quiet, personal; one signature element (the presence mark); everything else disciplined.

## Information Architecture

Top nav: `◈ {name}` (→ `/`) · `Sessions` (→ `/sessions`) · notifications bell. "New session" moves into the Sessions page.

### `/` — Assistant dashboard

- **First visit** (no `orchestrator_identities.handle`): an inline identity step — "Meet your assistant". A suggested name (Atlas/Wren/… pool) with 🎲 reroll and an editable field, then a **personality** field: 3–4 trait chips ("warm and direct", "dry wit", "meticulous planner", "cheerful hype-person") that append composable phrases into an editable textarea, or write your own. Copy encourages it ("Give them a voice — you can change this anytime"). Start = `PATCH /api/orchestrator/info { name, personality }` + ensure. Skipping personality yields the neutral persona.
- **Identity header**: name set in the display face, presence mark beneath (see Visual Language), one-line status ("idle" / "thinking" / "working on 2 tasks") derived from live agent status + unsettled children. An edit affordance on the header reopens the identity step inline for renaming / re-personality.
- **Chat card**: the last ~3 exchanges of the active thread, live via the existing stream store; a composer at its foot — sending admits the prompt and navigates to `/chat`.
- **Memory card**: pinned files (📌) + today's journal excerpt (first lines, rendered), each linking into `/memory/$path`.
- **Your work card**: recent **standalone** sessions (status dot, title, relative time) linking to `/sessions/$id`, plus a count line for active children ("2 tasks running under today's thread") linking to `/chat`. Children are NOT listed flat here — they live in the chat's thread tree.
- **Activity strip**: recent events — notifications (approvals, escalations) and child settlements — newest first, each with a deep link. Personal-only now; the component takes a generic event list so org events can interleave later.

### `/chat` — the assistant conversation

The existing session view re-mounted for the assistant session id (threads, gates, tool cards, WS resume — not a rebuild), with three changes:

1. **Thread tree sidebar.** Threads list children nested beneath the thread that spawned them:

   ```
   THREADS
   ├─ ● today                    ← active
   │    ├─ ▸ fix-auth       ● running
   │    └─ ▸ gate child     ✓ settled
   └─ (channel/schedule origins render here in later phases)
   ```

   Children come from `GET /api/orchestrator/children` (child_watches ⋈ agent_sessions), grouped by `parent_thread_id`, live-updated from `child.settled` signals and session status events.

   Added 2026-08-14: each thread row carries a context menu (archive thread, replace sandbox — the latter labeled session-wide since all threads share one sandbox). A "Show archived" toggle lists archived threads with an unarchive action. Settled children render muted with a dismiss affordance; dismiss hides the row, it never deletes the child session. The header trash-can (which destroyed the whole orchestrator — threads, history, children) is replaced by an overflow menu: replace sandbox + an explicit, confirmed "Delete session". Server-side, the ChildWatcher reclaims a child's compute the moment it settles (attachment destroy + cache evict): the orchestrator has no tool to message an existing child, so a settled child's sandbox is dead weight. Session data survives for `child_read` and `/sessions`; if a child-messaging tool is ever added, immediate teardown must move to a retention sweep.

2. **Signal cards.** Transcript entries carrying `signal` metadata render as cards, not user bubbles: `child.settled` → a **child card** (title, outcome badge, one-line result, "open" affordance); any other signalType → a generic labeled envelope card (signalType chip + body). Requires the wire change below.

3. **Child slide-over.** Clicking a child (sidebar or card) opens the child session **in place** as a right-hand slide-over panel: the child's live transcript, its gates resolvable there, an "open full page" affordance to `/sessions/$id`. Implemented by reusing the session view components with a `variant: "panel"` (no threads sidebar, compact header). Closing the panel returns to the assistant with no navigation.

   Added 2026-08-15: **Escape interrupts the running turn.** While the agent is busy, Escape triggers the same thread abort as the Stop button (window-level listener in the `Composer`, so it works anywhere on the chat tab). Layered dismissals keep priority through `preventDefault`: an open command popup consumes Escape to close itself; an open child panel consumes Escape (capture phase) to close; only an unclaimed Escape interrupts.

### `/memory` and `/memory/$` — memory explorer

Two panes:

- **Tree** (left): directories collapsed/expandable, pinned files marked 📌, `journal/` sorted newest-first with "today" highlighted. Data from the new JSON tree endpoint. A search field above the tree runs FTS (`GET /api/memory/search`) and swaps the tree for a result list (path, type badge, description) while active.
- **Document** (right): the rendered OKF doc — title in the display face, `type`/`tags`/`sensitivity`/`origin` as quiet badges, body as book-like rendered markdown (Newsreader). Frontmatter never shown raw. Footer affordance: **"Ask {name} to update this"** → navigates to `/chat` with the composer pre-filled (`Update memory file {path}: …`).

Read-only. No editing, no graph, no import UI this pass (import stays curl/API).

### `/sessions` and `/sessions/$sessionId` — standalone sessions

- The list shows **standalone sessions only** (owner user, purpose `interactive`; children and orchestrators excluded). "New session" dialog lives here. Framing copy: this is the space for direct/automation sessions.
- The session detail page hides the thread sidebar for standalone sessions — one chat, full width. (Children opened full-page also render here; they show a "spawned by {name} · thread {x}" breadcrumb linking back to `/chat`.)
- `/orchestrator` redirects to `/`.

## API additions (packages/api)

| Route | Shape | Notes |
|---|---|---|
| `GET /api/orchestrator/info` | `{ sessionId, name: string \| null, personality: string \| null, presence: 'idle'\|'thinking'\|'working', activeChildren: number }` | name from `orchestrator_identities.handle`; personality read from the `assistant/personality.md` memory file (null when absent); presence from live session agent status + unsettled child_watches. Never creates. |
| `PATCH /api/orchestrator/info` | `{ name?, personality? }` → `{ ok }` | `name` writes `orchestrator_identities.handle`. `personality` writes a **memory file**, not a column: `assistant/personality.md` (type `preference`, origin `user-stated`, NOT pinned) in the orchestrator's own scope, via the existing memory service. The wake path reads that file and appends it to the persona ("You are {name}. {personality}" — after the identity line, before the operating rules, capped ~500 chars at injection). No schema change. Consequences by design: the assistant can evolve its own personality via `mem_write` when asked; the file is visible in the memory explorer; OKF bundles carry it across migrations. Any identity change evicts the cached session so the next wake picks it up. |
| `GET /api/orchestrator/children` | `{ children: [{ sessionId, title, parentThreadId, status: 'running'\|'settled', outcome?, createdAt }] }` | child_watches ⋈ agent_sessions for the caller's orchestrator. Excludes dismissed watches (`dismissed_at` set — see the dismiss route below). |
| `POST /api/orchestrator/children/:childSessionId/dismiss` | `{ ok }` | Added 2026-08-14. Hides a settled child from the thread tree (`child_watches.dismissed_at`). Display state only — the child session and its history stay reachable from `/sessions`. 409 while the child is unsettled. |
| `PATCH /api/sessions/:id/threads/:threadId` | `{ model?, archived? }` → ThreadSummary | Extended 2026-08-14: `archived` toggles `session_threads.archived_at`. An archived thread leaves the default `GET /threads` list; `GET /threads?archived=1` lists archived threads only. The engine thread and its history are untouched. |
| `POST /api/sessions/:id/sandbox/replace` | `{ ok }` | Added 2026-08-14. Tears down the session's sandbox and re-provisions a fresh one (`SandboxAttachment.replace()`, epoch bump). Session-scoped — all of a session's threads share one sandbox. 409 while any submission is unsettled. With thread archive + child dismiss, this replaces the header trash-can's destroy-everything role. |
| `GET /api/memory/tree` | `{ entries: [{ path, title, type, pinned, updatedAt, dir: boolean }] }` | JSON listing for the explorer; the markdown virtual index stays for agents. Own-scope (+ read-union later; this pass own-scope is fine). |
| Wire `Message.signal?` | `{ signalType, attributes?, senderSessionId? }` | bridge + REST (`entryToMessage`) stop dropping `entry.signal`. Closes the Phase 4 minor; **full persistence round-trip checklist applies** (engine entry → wire → REST → renderer). |

Also in scope: fix the notifications bell's stale-dropdown (refetch on open) while restyling it.

## Visual Language — "calm companion"

Deliberately NOT the stock cream-and-terracotta AI look.

- **Palette (light):** paper `#FAF9F7`, ink `#1F1D1A`, muted `#6E6A63`, hairline `#E7E4DE`; accent **moss** `#3E6B4F` (actions, links, live presence); **amber** `#B98A2F` reserved for waiting states (thinking, pending gates); error red unchanged. **Dark:** ground `#171614`, ink `#ECE9E4`, moss `#7FAE8F`, hairline `#2A2825`. Delivered as CSS variables consumed by Tailwind config; both themes supported from day one.
- **Type:** UI remains the existing sans (Inter) — quiet and disciplined. **Newsreader** (self-hosted via fontsource) is the assistant's voice: the name in the presence header, dashboard section headings, and memory document rendering (title + body) — the explorer reads like a notebook. Mono only for ids/paths.
- **Signature element — the presence mark.** The assistant's name with a small living indicator beneath: slow breath (≈2.4s ease) while idle, quicker while thinking, steady while children run. It shrinks into the nav on other pages so the assistant feels present app-wide. This is the single place the design spends boldness. `prefers-reduced-motion` → static dot.
- **Signal cards** carry a soft moss left rail — events from the world look categorically different from typed messages.
- Everything else: quiet cards on paper, hairline borders, generous spacing, gentle hover lift, no gradients, no numbered decorations.

## Component/unit boundaries

- `packages/web/src/api/`: `orchestrator.ts` (info/children queries), `memory.ts` (tree/doc/search queries) — query-key factories per house pattern.
- `components/assistant/`: `presence-mark.tsx`, `identity-header.tsx`, `naming-step.tsx`, dashboard cards (`chat-card`, `memory-card`, `work-card`, `activity-strip`).
- `components/session/`: gains `signal-card.tsx` (+ child card), `thread-tree.tsx` (replaces the flat thread list when children exist), `child-panel.tsx` (slide-over), and a `variant` prop threaded through the existing view for panel/standalone modes.
- `components/memory/`: `memory-tree.tsx`, `memory-doc.tsx`, `memory-search.tsx`.
- Theme tokens in one `theme.css` (CSS variables) + Tailwind config mapping; no per-component color literals.

## Error handling & empty states

Empty states direct, in-voice: dashboard before first message ("Say hello — {name} remembers what matters"), memory before any files ("Nothing remembered yet. Talk to {name}, or import a bundle via the API"), sessions empty ("Standalone sessions are for direct work and automation — create one"). API failures on cards degrade per-card (card shows a quiet retry), never blanking the dashboard. The chat page keeps all existing resume/error behavior.

## Testing

- Web: store/hook tests per existing idioms (query hooks, signal-card rendering from a wire fixture, thread-tree grouping, presence derivation). Existing 22 tests stay green.
- API: route tests for info/PATCH/children/tree; the wire `signal` change adds a bridge test + REST `entryToMessage` test and re-runs the reload-rendering integration test (persistence-shape rule).
- Manual browser dogfood of all four surfaces ends the work.

## Explicitly out of scope

Org page and org activity; memory editing/graph/import UI; avatars and handles beyond the name; team management UI; channel/schedule thread origins (render when Phase 6 delivers them); mobile-app polish beyond responsive-that-works; legacy client changes.
