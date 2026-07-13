# Engine v2 Phase 4 — Orchestrator, Signals, Memory (Local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The product's core loop locally — a persistent, principal-owned orchestrator that wakes instantly sandbox-less with an injected memory snapshot, converses on the web, journals via `mem_*` tools, spawns Docker child sessions via `task`, receives their `child.settled` signals, routes attention to web notifications, and survives a process restart mid-child-run.

**Architecture:** The engine gains its three missing service seams — `SignalContent` admission (XML envelope rendering, engine-stamped sender identity, hop budget), ordered `systemContext` fragments + per-session `toolConfig`, and the `task` built-in over an app-injected `ChildSpawner`. The API gains the clean-slate principal model (teams, orchestrator identities, memory, notifications, drop log — 0000 app migration edited in place), an owner-tuple OKF memory service with FTS5, `mem_*` ToolDefs that call the memory HTTP surface through `toolConfig`, an orchestrator wake path in `EngineHost` (persona role + snapshot `systemContext` + cold `SandboxCreateOpts`), a durable child-settlement watcher, and an attention router feeding a web notifications surface.

**Tech Stack:** TypeScript, Node 22, better-sqlite3 + Drizzle (+ SQLite FTS5), `yaml` (document API), Hono, Vite/React 19 + Zustand, vitest, pi-agent-core/pi-ai pinned 0.73.0.

**Source specs:** `docs/specs/2026-07-11-orchestrator-engine-design.md` (identity, lifecycle, memory scoping, signals authorization, child sessions, notifications, limits). `docs/specs/2026-05-02-portable-runtime-engine-design.md` — SignalContent §341–426, CreateSessionOptions §269–302, task tool §722, awaitResult §402–422, clean-slate schema §2191. OKF memory format: scratchpad copy of `2026-07-02-okf-memory-design.md` (legacy-targeted; Phase 4 re-lands the FORMAT and core tool surface clean-slate — see decision 12 for exactly what's in/out). Roadmap: `docs/plans/2026-07-11-engine-v2-local-e2e-roadmap.md` Phase 4.

## Global Constraints

- Pre-1.0 migration policy applies to BOTH schemas: engine 0000 (`packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql`) and the app 0000 (`packages/api/migrations/`) are edited in place; `rm ~/.valet/app.db` after schema changes; no numbered migrations. The roadmap regenerates the app schema once at Phase 4 start — this is that regeneration.
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md rules).
- Every new engine behavior lands with tests in the same task; kill/restart recovery for the child-watcher is a local cross-process test, not deferred.
- Legacy packages (`worker`, `client`, `runner`) untouched.
- pi-agent-core / pi-ai pinned 0.73.0. Node 22 (`source ~/.nvm/nvm.sh && nvm use`). Docker via Rancher Desktop.
- Run `pnpm --filter @valet/engine test`, `pnpm --filter @valet/api test`, and `pnpm typecheck` before every commit claim (sanctioned pre-existing typecheck failure: `packages/worker/src/integrations/packages.ts`).
- Channel transports (Slack/Telegram), workflow host, task board, and team credentials are OUT of this phase (Phases 5/6 / later). Tables that Phase 6 will fill (`channel_bindings`, `user_identity_links`) are created now (clean-slate schema lands once) but carry no logic.

## Locked Design Decisions

The specs leave gaps; these are decided. Do not re-open them mid-task — flag concerns to the coordinator instead.

1. **Principal helpers live in `@valet/engine`** (which already owns `Principal`): `serializePrincipal(p): string` (`${type}:${id}`), `parsePrincipal(s)`, `orchestratorSessionId(p): string` (`orchestrator:{type}:{id}`), `parseOrchestratorSessionId(id): Principal | null`. New file `packages/engine/src/principal.ts`, exported from the package index. All orchestrator-id handling goes through these — never ad-hoc prefix checks.
2. **`SignalContent`** added to `PromptContent` exactly per engine spec §348: `{ kind: 'signal'; signalType: string; body: string; attributes?: Record<string, string>; tagName?: string }`. `tagName` validated against `/^[A-Za-z_][A-Za-z0-9_.-]*$/` at admission (reject with `ValidationError`), default `'signal'`.
3. **Signal persistence + rendering:** `MessageEntry` gains `signal?: { signalType: string; attributes?: Record<string, string>; tagName: string; senderSessionId?: string; senderOwner?: Principal; hopCount?: number }`. Signal prompts persist as user-role `MessageEntry` with `content` = the raw body and `signal` metadata. `entriesToAgentMessages` renders signal entries as an XML envelope: `<{tagName} signalType="…" {attrKey}="…">{body}</{tagName}>` — attribute values and body XML-escaped (`& < > " '`), tagName never escaped (hence the regex). Attributes render in sorted key order (deterministic). `senderSessionId`/`hopCount`, when present, render as attributes `sender_session` / `hop` (stamped values win over same-named entries in `attributes`).
4. **Internal signal admission (engine stamping):** `PromptOptions` gains `internalSender?: { sessionId: string; owner: Principal; hopCount?: number }` — set only by trusted host code, never by route handlers from client input. When present on a signal admission the engine: (a) stamps `signal.senderSessionId`/`senderOwner`; (b) sets `signal.hopCount = (internalSender.hopCount ?? 0) + 1` and rejects with `ValidationError` when it exceeds the hop budget; (c) namespaces the dispatchId as `${internalSender.sessionId}:${opts.dispatchId}` (dispatchId required for internal signals — reject if absent). Hop budget: `CreateSessionOptions.signalHopBudget?: number`, default `SIGNAL_HOP_BUDGET = 3` (constant in `packages/engine/src/submission.ts` or types-adjacent). Edge ACL is NOT engine code — the app layer authorizes edges before calling prompt (decision 16).
5. **Per-thread pending cap (engine):** `CreateSessionOptions.maxPendingPerThread?: number`, default `MAX_PENDING_PER_THREAD = 20`. Admission counts unsettled items on the thread; at/над the cap, admission throws a structured `PendingCapError` (new error class, `code: 'pending_cap_exceeded'`, message names the thread and cap). Steer supersession is exempt from the count check it performs (a steer that supersedes N items nets out) — implement as: count items that are NOT already superseded.
6. **`systemContext`:** `CreateSessionOptions.systemContext?: Array<{ name: string; content: string; order?: number }>`. Assembled once at agent construction: base `systemPrompt` + `\n\n` + fragments sorted by `(order ?? 100, name)`. **Deliberate deviation from spec §286 ("after role overlays"):** role overlays are per-turn appends and land AFTER systemContext — order is base → systemContext → role overlay → cold-sandbox hint. The spec's intent (stable injection position for service context) is preserved; do not "fix" the ordering.
7. **`toolConfig`:** `CreateSessionOptions.toolConfig?: Record<string, unknown>` → surfaced verbatim as `ToolContext.config?: Record<string, unknown>` (already typed in the spec's ToolContext; wire it through `buildToolContext`).
8. **`owner` on sessions:** `CreateSessionOptions.owner?: Principal`, default `{ type: 'user', id: userId }` (today's behavior). `Session.toData().owner` persists it; `SessionData.owner` already exists.
9. **Compaction hooks:** `CreateSessionOptions.compactionHooks?: CompactionHook[]` with `type CompactionHook = (args: { sessionId: string; threadId: string; mode: 'proactive' | 'reactive' | 'manual'; summary: string }) => Promise<void>`. Run in order after a successful compaction (in `Thread.compactThread` after the summary entry persists); each hook individually try/caught (log, continue) — failures never block compaction.
10. **`task` built-in tool:** enabled per-session via `toolConfig.childSpawner` being present — the tool is registered always but returns a structured error text (`[task_unavailable] this session cannot spawn child sessions`) when the spawner is absent (children get no spawner: depth limit 1 falls out structurally). Contract (types in `packages/engine/src/types.ts`):
    ```typescript
    export interface SpawnChildRequest {
      prompt: string;
      title?: string;
      repo?: string;      // clone URL or org/repo — interpretation is host policy
      branch?: string;
      model?: string;
    }
    export interface SpawnChildResult { childSessionId: string; queueItemId: string }
    export type ChildSpawner = (req: SpawnChildRequest, ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string; owner: Principal }) => Promise<SpawnChildResult>;
    ```
    The tool validates `toolConfig.childSpawner` is a function at call time (single `as ChildSpawner` after a typeof check, commented), calls it, and returns `{ text: "spawned child session {id} (submission {queueItemId}). Its result will arrive in this thread as a child.settled signal." }`. Spawner errors (limits) surface verbatim as error text. Fire-and-forget — the tool never awaits child completion.
11. **`child.settled` reporting is host-owned and durable.** App table `child_watches` (`child_session_id` PK, `queue_item_id`, `parent_session_id`, `parent_thread_id`, `actor_user_id`, `org_id`, `settled` INTEGER default 0, `created_at`). The spawner inserts a row before returning; a `ChildWatcher` service arms `thread.awaitResult(queueItemId)` (no timeout) per unsettled row — on settle it admits a `SignalContent` to `(parent_session_id, parent_thread_id)`: `signalType: 'child.settled'`, body = result text (or error), attributes `{ child_session_id, outcome, title? }`, `dispatchId: 'settled:{childSessionId}:{queueItemId}'` (deterministic — replays dedupe), `internalSender: { sessionId: childSessionId, owner: childOwner }`, then marks the row settled. On boot, `ChildWatcher.rearm()` re-arms every unsettled row (awaitResult is resumable by construction). This is the restart-mid-child-run survival mechanism and gets a cross-process test.
12. **Memory v2 = clean-slate owner-tuple OKF core, right-sized.** IN this phase: `memory_files` table with owner tuple + OKF columns, FTS5 with the spec's BM25 weights, `okf.ts` serialization (canonical YAML via the `yaml` package document API, golden-file locked), tools `mem_write` / `mem_patch` / `mem_read` / `mem_search` / `mem_rm`, virtual directory `index.md`, journal spine + wake bootstrap, snapshot assembly, OKF bundle import (trusted + path map + collision skips) and export (`include=all`). OUT (deferred, do not build): `memory_links` graph / `mem_links` / `mem_move`, expiry sweeps (the `expires` column exists; `mem_search` excludes expired rows — that's all), relevance boosting, shareable-export filtering, reranker, tag-similarity hints. Record the deferral in the task report; the columns land now so the schema is stable.
13. **Memory schema (app DB, exact):**
    ```sql
    CREATE TABLE memory_files (
      owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]', resource TEXT NOT NULL DEFAULT '',
      extras TEXT NOT NULL DEFAULT '{}',
      sensitivity TEXT NOT NULL DEFAULT 'private', origin TEXT NOT NULL DEFAULT '',
      expires INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
      actor_user_id TEXT NOT NULL DEFAULT '', source_session_id TEXT NOT NULL DEFAULT '',
      org_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_type, owner_id, path)
    );
    CREATE VIRTUAL TABLE memory_files_fts USING fts5(path, title, description, tags, content);
    ```
    Timestamps ms-epoch integers (project convention beats the legacy spec's D1 datetime strings — note the deviation). `expires` ms-epoch nullable. `pinned` is an explicit `mem_write` param (`pinned?: boolean`) — **deviation from the legacy spec's path-derived pinning**, locked for explicitness. FTS rowid mapping via a `rowid` column relationship maintained by ONE sync helper (all mutations go through it); BM25 weights `path 5, title 10, description 8, tags 6, content 1`; FTS `description` = authored description or first body paragraph derived at index time; FTS `tags` = space-joined.
14. **Memory scoping (normative, from the orchestrator spec):** every service helper resolves through one `MemoryScope` chokepoint `{ owner: Principal; actorUserId: string }`. Writes only to own scope. Reads: user scope reads a union of `user:{id}` + every team the user belongs to (membership resolved per query); cross-scope results project under virtual `team:{teamId}/…` path prefixes (read-time only, never stored; reading a `team:{id}/…` path re-checks membership). Team/org scopes read only themselves. Wake snapshots cover only the owner's own scope.
15. **`mem_*` tools are engine ToolDefs in `packages/api/src/orchestrator/memory-tools.ts`** calling the memory HTTP routes via `fetch` against `toolConfig.apiBaseUrl` with header `x-valet-internal: {token}` where the token comes from `toolConfig.internalToken` — populated by the host from `VALET_INTERNAL_TOKEN` (generated at boot if unset, held in process memory). Internal-auth requests carry the owner tuple explicitly (`x-valet-owner: {type}:{id}`, `x-valet-actor: {userId}`) and the route trusts them after constant-time token comparison (`crypto.timingSafeEqual`). Browser/user requests to the same routes authenticate normally and derive scope from their session user + membership. Tools never import the service directly — the HTTP seam is the portability contract.
16. **Signal edge ACL is host code** in `packages/api/src/orchestrator/signals.ts`: `admitSignal({ from: { sessionId, owner }, to: sessionId, threadKey, content, dispatchId, hopCount })` authorizes the edge per the orchestrator spec — allowed: (a) parent↔child (session rows related by `parentSessionId`); (b) orchestrator→orchestrator within one org (org→user always; user→user only when org policy opts in — policy table deferred, hardcode DENY user→user for now with a comment); (c) same-org workflow/task dispatch (Phase 5 caller). Cross-org → reject + drop-log. Recipient thread key for cross-orchestrator signals: `signal:{senderSessionId}`; for child settlement: the spawning thread. Rejections write `event_drop_log`.
17. **Orchestrator wake path:** `EngineHost.orchestratorSessionFor(principal, actorUserId)` — id via `orchestratorSessionId`, `purpose: 'orchestrator'`, owner = principal, `queueMode`: `steer` for user-owned, `followup` for team/org, workspace `~/.valet/orchestrator/{type}-{id}` (mkdir'd), sandbox = `SandboxCreateOpts` template (NEVER a pre-created sandbox — cold attachment is the steady state; Phase 3 makes this free), tools = builtins + `mem_*` (+ `task` via `toolConfig.childSpawner`), `systemContext` = [`{ name: 'memory-snapshot', content, order: 10 }`] assembled at wake, `compactionHooks` = [journal-append hook], persona as the session `systemPrompt` (owner-kind-aware text in `packages/api/src/orchestrator/persona.ts`, including the memory-usage rules: search-before-create, `origin: user-stated` for explicit statements, journal today's work with links to touched files, people files under `people/`). Wake bootstrap: ensure today's journal (`journal/YYYY-MM-DD.md`, `type: 'journal-entry'`) exists before snapshot assembly. `orchestrator_identities` row upserted on first creation.
18. **Snapshot assembly** (`packages/api/src/orchestrator/snapshot.ts`): `assembleMemorySnapshot(scope, opts?: { budgetChars?: number })`, default budget 48_000 chars. Content: (1) header line with owner + date; (2) full rendered pinned files (path order), (3) the 3 most recent journal files, (4) the virtual root `index.md`. Sections truncate oldest-first to fit the budget; a truncation note is appended when anything is cut. Own-scope only.
19. **Attention router** (`packages/api/src/orchestrator/attention.ts`): `routeAttention(event: { kind: 'notification' | 'question' | 'escalation' | 'approval'; urgency?: 'low' | 'normal' | 'high'; owner: Principal; actorUserId?: string; sessionId?: string; title: string; body?: string; href?: string })`. Audience resolution is a pure function over pre-fetched membership: user owner → [userId]; team owner → team members (admins for `escalation`); org owner → org admins. Inserts `notifications` rows (per audience user). Web-only delivery this phase — no channel posting, no preferences gating (the `user_notification_preferences` table lands; the router reads it only to SKIP a kind a user disabled for web; default enabled). Wired producers: `submission_stuck` events from the shared EventStream (kind `escalation`), decision gates raised in child sessions (kind `approval`, routed to the parent session's owner audience with an href to the child session).
20. **App schema additions (Task 4, all in the app 0000, exact tables):** `teams` (id, org_id, name unique per org, created_at), `team_members` (team_id, user_id, role 'admin'|'member', PK (team_id,user_id); last-admin guards live in service code within a transaction), `orchestrator_identities` (id, org_id, owner_type, owner_id UNIQUE(org_id,owner_type,owner_id), session_id, handle nullable, created_at), `child_watches` (decision 11), `notifications` (id, user_id, kind, urgency, title, body, href, session_id, created_at, read_at nullable; index (user_id, read_at)), `user_notification_preferences` (user_id, kind, web INTEGER default 1, PK (user_id,kind)), `event_drop_log` (id, org_id, reason, conversation_key nullable, detail, created_at; reasons this phase: `hop_budget` | `edge_denied` | `pending_cap` | `child_cap` | `org_ceiling`), `channel_bindings` + `user_identity_links` (per orchestrator spec shapes, no logic), memory tables (decision 13). `agent_sessions` gains `owner_type`/`owner_id` columns (default user/user_id).
21. **Limits (defaults, constants in `packages/api/src/orchestrator/limits.ts`):** `MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR = 10` (unsettled `child_watches` per parent), `ORG_ACTIVE_SESSION_CEILING = 25` (unsettled child watches org-wide + live interactive sessions — approximate by unsettled child_watches + agent_sessions rows not deleted, documented), engine `MAX_PENDING_PER_THREAD = 20` (decision 5), `SIGNAL_HOP_BUDGET = 3` (decision 4). Spawner enforces child + org limits with structured errors naming the running children; violations drop-log.
22. **Web surface (minimal):** (a) nav item "Assistant" → route `/orchestrator`: calls `POST /api/orchestrator` (ensures the user orchestrator, returns `{ sessionId }`), then renders the existing session view for that id (session ids contain colons — `encodeURIComponent` them in EVERY client URL path segment; audit `client.ts` while there). (b) Notifications bell in the top nav: unread count badge, dropdown list (title, relative time, href link), mark-read on click + mark-all-read. Poll every 30s (no WS plumbing for notifications this phase).
23. **Existing web sessions API unchanged** for regular sessions; `POST /api/sessions` continues to work. Orchestrator sessions appear in the session list (they're sessions) — acceptable this phase.
24. **OKF import fixture is a real bundle:** Task 10's E2E imports `packages/api/test/fixtures/okf-bundle/` — a hand-authored miniature bundle in the export manifest format (≥6 files: `preferences/style.md` pinned, `people/alice.md`, `projects/valet/overview.md`, `journal/2026-07-10.md`, one file with unknown extras keys, root `index.md` with `okf_version: "0.1"`), exercising path-map, index-skip, and extras round-trip.

---

### Task 1: Engine — SignalContent admission, XML rendering, stamping, hop budget, pending cap

**Files:**
- Modify: `packages/engine/src/types.ts` (SignalContent in PromptContent, MessageEntry.signal, PromptOptions.internalSender, CreateSessionOptions.signalHopBudget/maxPendingPerThread)
- Modify: `packages/engine/src/errors.ts` (`PendingCapError`; reuse `ValidationError`)
- Modify: `packages/engine/src/submission.ts` + `packages/engine/src/thread.ts` (admission validation, stamping, dispatchId namespacing, pending cap)
- Modify: the entries→LLM-messages renderer (find `entriesToAgentMessages` in `thread.ts`) for the XML envelope
- Create: `packages/engine/src/principal.ts` (decision 1 helpers)
- Test: `packages/engine/test/signals.test.ts`, `packages/engine/test/principal.test.ts`

**Test plan (write first):** signal prompt persists user entry with signal metadata and renders as escaped XML envelope (attrs sorted; body with `<>&"'` escaped; custom tagName; default 'signal'); invalid tagName rejected; internalSender stamps sender/owner, sets hopCount, namespaces dispatchId (same external dispatchId from two senders → two admissions); hop budget: hopCount 3 admits (budget 3 = max allowed), hopCount 4 rejects; internal signal without dispatchId rejects; attributes cannot override stamped `sender_session` attr; pending cap: 21st unsettled admission on one thread throws PendingCapError, other threads unaffected, steer still admits by superseding; principal helpers round-trip + reject junk.

- [ ] Steps: failing suite → types → admission/rendering implementation → full engine suite green + typecheck → commit `feat(engine): SignalContent admission — XML envelopes, stamped senders, hop budget, pending cap`.

---

### Task 2: Engine — systemContext, toolConfig, owner, compaction hooks

**Files:**
- Modify: `packages/engine/src/types.ts` (CreateSessionOptions.systemContext/toolConfig/owner/compactionHooks; `ToolContext.config`; `CompactionHook` type)
- Modify: `packages/engine/src/session.ts` (owner default), `packages/engine/src/thread.ts` (agent prompt assembly per decision 6; `buildToolContext` config passthrough; compaction hook invocation in `compactThread`)
- Test: `packages/engine/test/session-service-hooks.test.ts`

**Test plan:** systemContext fragments appear in the agent's system prompt sorted by (order, name), AFTER the base prompt and BEFORE a role overlay's text on a role-bearing turn (capture via fake-LLM recorded systemPrompt — same idiom as the Phase 3 cold-hint test); toolConfig visible as `ctx.config` inside a tool execution; `owner` persisted via toData and defaulted to user:{userId} when absent; compaction hook fires with the summary after a manual compaction, a throwing hook logs and does not fail compaction, hooks run in order.

- [ ] Steps: failing suite → implement → engine suite green + typecheck → commit `feat(engine): systemContext fragments, toolConfig passthrough, session owner, compaction hooks`.

---

### Task 3: Engine — `task` built-in tool over ChildSpawner

**Files:**
- Modify: `packages/engine/src/types.ts` (SpawnChildRequest/SpawnChildResult/ChildSpawner per decision 10)
- Modify: `packages/engine/src/builtin-tools/index.ts` (`taskTool`)
- Test: `packages/engine/test/task-tool.test.ts`

**Test plan:** with a fake spawner in toolConfig, the tool passes prompt/title/model through and returns text naming the childSessionId and queueItemId and mentioning the child.settled signal; ctx fields (parentSessionId = ctx.sessionId, parentThreadId = ctx.threadId, actorUserId, owner) reach the spawner; without a spawner the tool returns the `[task_unavailable]` error text (no throw); spawner rejection (e.g. `[child_cap] …`) surfaces as the tool's error; params schema rejects empty prompt.

- [ ] Steps: failing suite → implement → green + typecheck → commit `feat(engine): task built-in — child spawning via host-injected ChildSpawner`.

---

### Task 4: API — clean-slate principal schema + teams service

**Files:**
- Modify: `packages/api/migrations/` 0000 app migration in place + `packages/api/src/schema/index.ts` (decision 20 tables + agent_sessions owner columns)
- Create: `packages/api/src/services/teams.ts` (createTeam, addMember, removeMember, setRole — last-admin guards in one transaction; creator auto-admin; listTeamsForUser)
- Create: `packages/api/src/routes/teams.ts` (CRUD, org-membership-gated; mounted in main)
- Test: `packages/api/test` or `src/` colocated per existing api test layout — teams service unit tests (last-admin guard on role-change AND removal; creator auto-admin; membership listing), schema smoke (fresh DB boots, all tables exist)

**Notes:** delete the dev DB in the test bootstrap the way existing api tests do; document `rm ~/.valet/app.db` in the commit body. No teams UI.

- [ ] Steps: failing tests → schema + service + routes → api suite green + typecheck → commit `feat(api): clean-slate principal schema — teams, identities, notifications, drop log, memory tables`.

---

### Task 5: API — OKF serialization + memory service + routes + import/export

**Files:**
- Create: `packages/api/src/lib/okf.ts` (renderConcept/parseConcept/sanitizeBody, canonical YAML per the OKF spec's emission policy — `yaml` package document API with `keepSourceTokens` for extras as-written preservation; key order `type, title, description, resource, tags, timestamp`, then `valet:` block (`sensitivity, origin, expires` when non-default), extras sorted; strings double-quoted; tags flow style)
- Create: `packages/api/src/services/memory.ts` (MemoryScope chokepoint per decision 14; write/patch/read/search/rm/list; ONE fts-sync helper; virtual index.md; path normalization + reserved rules: basename `index.md`/`log.md` rejected for agent writes with the spec's remediation strings, depth ≤ 5, `lib/` reserved)
- Create: `packages/api/src/routes/memory.ts` (GET/PUT file, GET search, DELETE, POST import, GET export; dual auth per decision 15)
- Add `yaml` dependency to `packages/api/package.json`
- Test: okf serialization suite (round-trip `parse(render(x))≡x`, render-twice byte identity, golden file, adversarial YAML: `title: Deploy: staging vs prod`, quotes/newlines/unicode, `NO`/`1.10` in extras, body starting with `---`), memory service suite (owner-tuple isolation: two owners same path don't collide; read-union: user sees own + team files under `team:{id}/` virtual prefix, loses them after removal from team; team scope never reads user scope; FTS search with weights returns expected ranking on a small corpus; expired rows excluded from search; agent round-trip law: `write(read(x))` no-op), import/export suite (export→import→export identity on the Task-10 fixture shape; collisions → skipped; index files skipped; unknown extras preserved)

- [ ] Steps: okf tests → okf.ts → service tests → service → routes + import/export tests → green + typecheck → commit `feat(api): owner-tuple OKF memory — serialization, service, FTS5, import/export`.

---

### Task 6: API — mem_* ToolDefs, snapshot assembly, wake bootstrap

**Files:**
- Create: `packages/api/src/orchestrator/memory-tools.ts` (mem_write/mem_patch/mem_read/mem_search/mem_rm per decision 15 — TypeBox params with the metadata-setting guidance in param descriptions; responses carry `⚠` warnings from the service)
- Create: `packages/api/src/orchestrator/snapshot.ts` (decision 18)
- Create: `packages/api/src/orchestrator/bootstrap.ts` (`ensureTodayJournal(scope)`)
- Test: tools suite driving the real HTTP surface (boot the api app in-process the way existing integration tests do, internal token auth) — each tool round-trips; snapshot suite (pinned + 3 recent journals + index within budget; truncation note when over; empty memory → minimal snapshot); journal bootstrap idempotent

- [ ] Steps: failing suites → implement → green + typecheck → commit `feat(api): mem_* engine tools, memory snapshot assembly, journal bootstrap`.

---

### Task 7: API + web — orchestrator lifecycle and entry point

**Files:**
- Create: `packages/api/src/orchestrator/persona.ts` (owner-kind-aware persona per decision 17)
- Modify: `packages/api/src/engine/host.ts` (`orchestratorSessionFor` per decision 17; internal token; apiBaseUrl in toolConfig)
- Create: `packages/api/src/routes/orchestrator.ts` (`POST /api/orchestrator` ensure+return `{ sessionId }`; `GET /api/orchestrator` same without create for probes; upsert `orchestrator_identities`)
- Create (in host.ts or a small module): the journal compaction hook — a `CompactionHook` that appends the compaction summary to today's journal via the memory service (decision 9 contract; wired into the orchestrator's `compactionHooks`)
- Modify: `packages/web/src/api/client.ts` (encodeURIComponent every path segment carrying an id — audit all routes; add orchestrator ensure call)
- Modify: web nav + route: `packages/web/src/routes/orchestrator.tsx` (ensure then render the session view), nav "Assistant" link
- Test: api — ensure is idempotent (two calls one session row + one identity row); orchestrator session answers a prompt with NO sandbox create (spy provider — proves sandbox-less wake); snapshot content present in the recorded system prompt; queueMode steer for user principal. Web — encoded-id URL unit test if the client has test idioms, else covered by dogfood.

- [ ] Steps: failing api tests → implement api → web route + nav → suites green + typecheck → commit `feat(api,web): orchestrator lifecycle — instant sandbox-less wake, persona, web entry`.

---

### Task 8: API — signal host plumbing, child spawner, durable ChildWatcher, limits

**Files:**
- Create: `packages/api/src/orchestrator/signals.ts` (admitSignal per decision 16 + drop-log writes)
- Create: `packages/api/src/orchestrator/children.ts` (ChildSpawner impl: creates a child session via EngineHost — purpose 'child', owner inherited, workspace under the parent's workspace dir or a fresh temp dir, Docker sandbox opts, prompts it with the request prompt, inserts child_watches, enforces decision-21 limits; ChildWatcher with `rearm()`)
- Modify: `packages/api/src/engine/host.ts` / `packages/api/src/main.ts` (inject spawner into orchestrator toolConfig; boot-time `ChildWatcher.rearm()` alongside the existing eager restore)
- Test: unit — edge ACL matrix (parent↔child ok both ways; org→user ok; user→user denied; cross-org denied + drop-logged); child cap: 11th spawn rejects with error naming running children + drop-log row; watcher: spawn (virtual sandbox child) → child completes → parent thread receives ONE child.settled signal with deterministic dispatchId even when the watcher double-fires (dedupe proves out); signal lands on the spawning thread; child has no spawner in its toolConfig (depth limit).

- [ ] Steps: failing suites → implement → green + typecheck → commit `feat(api): signal edge ACL, child spawner + durable settlement watcher, limits`.

---

### Task 9: API + web — attention router and notifications

**Files:**
- Create: `packages/api/src/orchestrator/attention.ts` (decision 19), `packages/api/src/routes/notifications.ts` (GET list w/ unread filter, POST :id/read, POST read-all)
- Modify: `packages/api/src/main.ts` (subscribe to the shared EventStream: `submission_stuck` → escalation; `decision_gate` events on purpose-'child' sessions → approval routed to parent audience)
- Web: notifications bell component + 30s polling hook + mark-read; mounted in the top nav
- Test: api — audience resolution matrix (user/team/team-escalation/org); notification insert + read flow; stuck → escalation row; child gate → approval row with href. Web — store/hook test per existing idioms.

- [ ] Steps: failing suites → implement → green + typecheck → commit `feat(api,web): attention router + web notifications`.

---

### Task 10: Exit-criteria E2E — the full loop, killed and restarted

**Files:**
- Create: `packages/api/test/fixtures/okf-bundle/` (decision 24)
- Test: `packages/api/src/integration/orchestrator-loop.test.ts` (or the package's integration layout): scripted/fake model where feasible; the child runs in DOCKER (docker-gated like Phase 3's suites)
- Test: cross-process restart: child-process harness in the style of `packages/engine/test/kill-child.ts` — parent process boots the api app, spawns orchestrator + child, SIGKILLs itself mid-child-run; a second process boots, `ChildWatcher.rearm()` runs, and the parent thread still receives exactly one `child.settled`

**Flow under test (mirrors the roadmap exit criteria):** import the OKF fixture for the user scope → ensure orchestrator → prompt it (scripted model, no tools) → assert answer streamed with zero sandbox creates AND the snapshot (pinned file content) was in the system prompt → prompt that invokes `task` (scripted tool call) → child session created in Docker, runs a real `bash echo`, settles → parent thread gains the `child.settled` signal entry (XML envelope in the transcript) → scripted follow-up turn calls `mem_patch` appending to today's journal → journal row updated → RESTART VARIANT: SIGKILL between child spawn and settlement; after reboot the signal still arrives once.

- [ ] Steps: fixture → happy-path E2E green (3× flake check on the docker case) → restart harness green (3×) → full repo gates (engine, store-sqlite, api, web, sandbox-local, sandbox-docker, typecheck) → commit `test(api): phase 4 exit criteria — orchestrator loop with restart-mid-child-run`.
- [ ] Coordinator (manual dogfood): `make dev-local`; visit /orchestrator; import bundle via curl; converse (instant response, no container until needed); ask it to spawn a child coding task; watch child.settled arrive; check the journal via mem_read; check notification bell on a child gate.

---

## Exit Criteria (phase gate)

- A local orchestrator with imported memory answers instantly sandbox-less (Task 7 test + Task 10 + dogfood).
- It spawns a child coding session in Docker and receives its `child.settled` signal (Tasks 8, 10).
- It journals via `mem_patch` (Tasks 5, 6, 10).
- It survives a process restart mid-child-run — settlement signal still delivered exactly once (Task 10 cross-process harness).
- Signals carry engine-stamped identity, namespaced dispatchIds, and die loudly past the hop budget; per-thread pending cap and child/org ceilings enforced with drop-log records (Tasks 1, 8).
- All prior suites stay green (engine 293+, store-sqlite 76, sandbox-local 42, sandbox-docker 38+, api 29+, web 11+).
