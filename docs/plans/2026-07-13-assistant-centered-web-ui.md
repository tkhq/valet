# Assistant-Centered Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `packages/web` around the assistant: a dashboard home with identity (name + personality), a chat page with nested child sessions and signal cards, a memory explorer, and a standalone-sessions area — in the "calm companion" visual language.

**Architecture:** Four surfaces over four small API additions. The chat surface REUSES the existing session view (stream store, WS resume, gates, tool renderers) via a variant prop — no transcript rebuild. Signals become first-class on the wire (`Message.signal`), closing the Phase 4 minor. Identity is `orchestrator_identities.handle` (name) + the `assistant/personality.md` memory file (personality) — zero schema changes.

**Tech Stack:** Existing: Vite 6, React 19, TanStack Router/Query, Tailwind 3, Zustand, Hono. New deps: `@fontsource/newsreader` (web only).

**Source spec (authoritative):** `docs/specs/2026-07-13-assistant-centered-web-ui-design.md` — read it before any task; every surface, endpoint shape, token value, and out-of-scope item is defined there.

## Global Constraints

- NO schema changes (personality is a memory file). NO engine changes except none-at-all — if a task seems to need one, stop and flag.
- Legacy packages (`worker`, `client`, `runner`) untouched.
- The wire `Message.signal` change follows the CLAUDE.md persistence round-trip checklist: engine entry → bridge → REST `entryToMessage` → web renderer, each hop tested; re-run the reload-rendering integration test.
- Existing suites stay green: web 22, api 185 (w/ key; 172+ without), engine 330 untouched.
- Visual tokens come from the spec VERBATIM (paper `#FAF9F7`, ink `#1F1D1A`, muted `#6E6A63`, hairline `#E7E4DE`, moss `#3E6B4F`, amber `#B98A2F`; dark `#171614`/`#ECE9E4`/`#7FAE8F`/`#2A2825`). CSS variables in one `theme.css`; no per-component color literals. `prefers-reduced-motion` honored wherever motion is added.
- No `any`, no `as unknown as T`, no `@ts-ignore`. Node 22 (`source ~/.nvm/nvm.sh && nvm use`); `pnpm rebuild better-sqlite3` on native-version errors.
- Run `pnpm --filter @valet/web test`, `pnpm --filter @valet/api test`, and `pnpm typecheck` before every commit claim (sanctioned pre-existing failure: `packages/worker/src/integrations/packages.ts`). Web tasks also run `pnpm --filter @valet/web build`.

## Locked Design Decisions

1. **Routes:** `/` = dashboard (replaces session list); `/chat` = assistant conversation; `/memory` + `/memory/$` (splat = file path); `/sessions` = standalone list (+ New session dialog); `/sessions/$sessionId` unchanged; `/orchestrator` → redirect to `/`.
2. **Wire shape:** `Message` gains `signal?: { signalType: string; attributes?: Record<string, string>; senderSessionId?: string }`. Populated in BOTH `engineToWireParts`-adjacent bridge mapping and REST `entryToMessage` from `MessageEntry.signal` (hopCount/senderOwner NOT shipped — UI doesn't need them).
3. **Signal rendering:** a wire message with `signal` renders as a card, never a user bubble. `signalType === 'child.settled'` → **child card**: title (from `attributes.title`, fallback child id), outcome badge (`attributes.outcome`), first ~200 chars of body, click target = the child. Everything else → **envelope card**: signalType chip + body. Both carry the moss left rail.
4. **Info endpoint:** `GET /api/orchestrator/info` → `{ sessionId, name, personality, presence, activeChildren }` (spec table). Presence: `working` if unsettled child_watches > 0, else `thinking` if the live session's agent status is thinking/tool-calling, else `idle`. Never creates. `PATCH /api/orchestrator/info { name?, personality? }`: name → `handle` upsert; personality → write `assistant/personality.md` (type `preference`, origin `user-stated`, not pinned) through the memory service with the caller as actor; then evict the cached engine session (`EngineHost.destroy(sessionId)` — check it exists; it does) so the next wake rebuilds the persona.
5. **Persona injection:** the orchestrator wake path (`buildOrchestratorSession` in host.ts) reads `handle` and `assistant/personality.md`; persona becomes `You are {name}. {personality-capped-500-chars}` prepended context + existing owner-kind persona body. Absent name → existing neutral persona unchanged.
6. **Children endpoint:** `GET /api/orchestrator/children` → `{ children: [{ sessionId, title, parentThreadId, status: 'running' | 'settled', outcome?, createdAt }] }` from child_watches ⋈ agent_sessions for the caller's user orchestrator. `outcome` only when settled (read from... child_watches has no outcome column — derive: settled=1 rows report status 'settled' with outcome omitted; the UI shows ✓; flag in report if trivially improvable without schema change via the engine store's submission outcome — optional).
7. **Memory tree endpoint:** `GET /api/memory/tree` → `{ entries: [{ path, title, type, pinned, updatedAt }] }` — flat file list (no dir rows; the client derives the tree from paths). Own-scope. Existing dual auth (session user or internal token) reuse.
8. **Sessions list filter:** `/api/sessions` (or client-side if the route returns everything) excludes: ids where `parseOrchestratorSessionId(id) !== null`, and ids present in `child_watches.child_session_id`. Do the filtering SERVER-side in the list route (join/parse there); the client shows what it gets. Children opened at `/sessions/$sessionId` render with a "spawned by {name}" breadcrumb when the session id appears in the children query.
9. **Theme:** CSS variables in `packages/web/src/theme.css` (`--paper, --ink, --muted, --line, --moss, --amber` + dark overrides via `prefers-color-scheme` and `:root[data-theme]` both), mapped into `tailwind.config` colors (`paper`, `ink`, `muted`, `line`, `moss`, `amber`). Newsreader via `@fontsource/newsreader` (400/500 + italic), Tailwind `font-display`. Existing danger/success semantics stay.
10. **Presence mark:** component `PresenceMark` — name in `font-display`, small dot beneath: idle = 2.4s breathing opacity loop, thinking = 1.2s, working = steady moss; reduced-motion = static. Sizes: `hero` (dashboard) and `nav` (top bar). One implementation, CSS keyframes.
11. **Identity step:** name field prefilled from pool `[Atlas, Beacon, Cleo, Dash, Echo, Fable, Iris, Juno, Lark, Nova, Opal, Piper, Quinn, Sage, Wren]` (random), 🎲 reroll; personality textarea + trait chips `["warm and direct", "dry wit", "meticulous planner", "cheerful hype-person"]` — clicking a chip appends its phrase sentence (`"You are warm and direct."` etc.) to the textarea; Start disabled until name non-empty; "Skip personality" = submit name only. Shown inline on `/` when `info.name === null`; the header's edit affordance reopens the same component prefilled.
12. **Thread tree:** the chat sidebar groups children (from the children query) under `parentThreadId`; threads without children render as today. Live updates: refetch children on `submission.settled` / sandbox-ish events is overkill — refetch on any WS `queue.state` for the assistant session + 30s interval, and optimistically add on a `task` tool_end (cheap heuristics; document).
13. **Child slide-over:** `ChildPanel` renders the existing session view with `variant="panel"` — variant hides threads sidebar + session header chrome, keeps transcript/gates/composer. Opens over the chat's right side (~480px, full-height, hairline border, ESC/✕ closes). The panel gets its own WS via the existing `useSessionWebSocket(childId)` (multiple sockets are fine — the store is keyed by session).
14. **Standalone session view:** same `variant` mechanism — `variant="standalone"` hides the threads sidebar entirely.
15. **Dashboard cards** are self-contained components each owning their query + error/empty state (per spec: per-card degradation, never blank the page). Chat card reuses the stream store if the assistant session is live, else last messages via REST (limit 6).
16. **Activity strip:** merge of notifications (existing query) + settled children (children query), sorted desc by time, top 8, each row deep-linking (notification href / child → chat). Component takes a plain `events: ActivityEvent[]` prop (org events slot in later).
17. **Memory search:** debounced 250ms against `GET /api/memory/search?q=`; while active, the tree pane shows results (path, type badge, description); ESC/clear restores the tree. Doc pane: title in `font-display`, badges for type/tags/sensitivity/origin (origin only when non-empty), body rendered through the existing markdown component wrapped in a `prose`-like display-face style; "Ask {name} to update this" navigates to `/chat` with composer prefilled `Update memory file {path}: ` (a small composer-prefill store/param).
18. **Bell fix:** refetch the notifications query when the dropdown OPENS (in addition to the 30s poll) — closes the Phase 4 dogfood staleness.
19. **Empty states** verbatim from the spec's Error handling section.
20. **The dashboard/naming flow must not double-create:** `/` probes `GET /api/orchestrator/info`; the naming step's Start calls `PATCH` then `POST /api/orchestrator` (ensure) — PATCH must work before the engine session exists (identity row upsert on PATCH if absent; check T2).

---

### Task 1: Wire signal passthrough (api)

**Files:** `packages/api/src/wire/types.ts` (Message.signal), `packages/api/src/engine/bridge.ts`, `packages/api/src/routes/messages.ts` (`entryToMessage`), tests: bridge test + a REST test asserting a persisted signal entry round-trips with `signal` populated; re-run `src/integration/reload-tool-rendering.test.ts` and the orchestrator-loop suite if key present.

- [ ] Failing tests (bridge mapping; entryToMessage passthrough) → implement → api suite green + typecheck → commit `feat(api): ship entry.signal on the wire`.

### Task 2: Orchestrator info/children + memory tree endpoints (api)

**Files:** `packages/api/src/routes/orchestrator.ts` (GET/PATCH `/info`, GET `/children`), `packages/api/src/routes/memory.ts` (GET `/tree`), `packages/api/src/engine/host.ts` (persona injection per decision 5; eviction on PATCH), tests for all four + persona-injection test (restore after rename → system prompt contains name + personality).

**Interfaces:** decisions 4–8, 20 verbatim.

- [ ] Failing route tests → implement → api green + typecheck → commit `feat(api): assistant identity, children, and memory-tree endpoints`.

### Task 3: Theme foundation + nav (web)

**Files:** `packages/web/src/theme.css` (new), `tailwind.config` mapping, `@fontsource/newsreader` dep + imports, `components/assistant/presence-mark.tsx`, top-nav restructure (`◈ {name}` → `/`, `Sessions` → `/sessions`, bell stays; "New session" button removed from nav), `/orchestrator` redirect route, bell open-refetch fix (decision 18).

**Tests:** presence-mark state/reduced-motion class test; nav renders name from the info query (mock); existing web tests updated for nav changes only.

- [ ] Implement → web tests green + build + typecheck → commit `feat(web): calm-companion theme, presence mark, assistant-first nav`.

### Task 4: Dashboard + identity step (web)

**Files:** `routes/index.tsx` rewritten (dashboard), `routes/sessions.tsx` NEW (the old session list + New-session dialog moved here, standalone-filtered per decision 8 — server filter lands in this task's api touch if not done in T2; keep it server-side), `components/assistant/`: `identity-step.tsx`, `identity-header.tsx`, `chat-card.tsx`, `memory-card.tsx`, `work-card.tsx`, `activity-strip.tsx`; `api/orchestrator.ts` + query keys; composer-prefill mechanism (small store or search param).

**Tests:** identity-step chip composition + skip path; dashboard renders naming state vs dashboard state from mocked info; activity merge/sort; work-card excludes children.

- [ ] Implement → green + build + typecheck → commit `feat(web): assistant dashboard — identity, chat/memory/work cards, activity`.

### Task 5: Chat page — thread tree, signal cards, child slide-over (web)

**Files:** `routes/chat.tsx` (mount session view for the assistant id), session view `variant` prop (`"full" | "panel" | "standalone"`), `components/session/thread-tree.tsx`, `signal-card.tsx` (child card + envelope), `child-panel.tsx`; standalone detail view uses `variant="standalone"` + child breadcrumb (decision 8).

**Tests:** signal-card renders child card for child.settled fixture and envelope otherwise (NOT a user bubble); thread-tree groups children by parentThreadId; variant prop hides the right chrome; message-list routes signal messages to the card renderer.

- [ ] Implement → green + build + typecheck → commit `feat(web): assistant chat — nested children, signal cards, child slide-over`.

### Task 6: Memory explorer (web)

**Files:** `routes/memory.tsx` + `routes/memory.$.tsx`, `components/memory/`: `memory-tree.tsx`, `memory-doc.tsx`, `memory-search.tsx`; `api/memory.ts` queries.

**Tests:** tree derivation from flat paths (dirs, journal newest-first, pinned marker); search debounce/swap behavior; doc badges + ask-to-update prefill navigation.

- [ ] Implement → green + build + typecheck → commit `feat(web): memory explorer — tree, notebook doc view, search`.

### Task 7: Polish + full gates

**Files:** empty states (decision 19), dark-mode audit (every new surface in both themes), reduced-motion audit, responsive audit (dashboard cards stack; chat sidebar collapses; memory panes stack), any straggler restyles for visual coherence (session page header, cards) WITHOUT rewriting components.

- [ ] Audit + fix → ALL gates: web + api (+ key) + engine untouched + typecheck + web build → commit `polish(web): dark mode, motion, responsive, empty states`.
- [ ] **Coordinator (manual dogfood):** naming flow with personality chips → dashboard cards live → chat: spawn a child, see it nested + as a card, open slide-over, resolve a gate in-panel → memory: browse, search, read today's journal, ask-to-update prefill → sessions: standalone-only list, no thread sidebar in a standalone session → bell opens fresh → both themes screenshotted.

## Exit Criteria

- Opening the app lands on the assistant dashboard; first visit walks through name + personality; the persona actually speaks as the named assistant (verified: system prompt contains both).
- `child.settled` renders as a child card (never a fake user bubble); children nest under their thread in the chat sidebar; a child opens in the slide-over with resolvable gates.
- Memory is browsable/searchable/readable in the notebook style; personality file visible there.
- `/sessions` shows only standalone sessions; a standalone session has no thread sidebar.
- All suites green; both themes coherent; reduced-motion clean.
