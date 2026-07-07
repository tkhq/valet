# Teams Phase 4: Team Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memory becomes owner-scoped: the team orchestrator reads/writes its own team memory (unblocking the phase 3 DO guard), personal orchestrators get a read-only union over their teams' memory, and the team page gets a Memory tab (members read, admins edit).

**Architecture:** Approach-B generalization of `lib/db/memory-files.ts` + `memory-snapshot.ts`: every helper's `userId: string` param becomes `owner: Principal`; every `user_id = ?` filter becomes `owner_type = ? AND owner_id = ?`. `user_id` stays as *creator/actor* provenance (NOT NULL FK — team rows carry the acting user), mirroring the sessions convention. FTS needs no changes — search already joins the base table, so owner filtering is a WHERE-clause swap. Cross-scope reads use a scope-union (`(owner_type, owner_id) IN (…)`) and a virtual `team:{teamId}/` path prefix for addressing team files from a personal orchestrator.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §3, §8 phase 4.

## Global Constraints

- Same env setup as prior phases; baseline all green (36 shared, 1267 worker).
- **Migration `0026`**: `DROP INDEX idx_memory_files_user_path`. Team rows reuse `user_id` as created-by, so `(user_id, path)` uniqueness is wrong (Alice creating `MEMORY.md` in two teams would collide); `idx_memory_files_owner_path` (0024) is the real constraint. All `ON CONFLICT(user_id, path)` targets switch to `(owner_type, owner_id, path)`.
- **Writes never cross scopes**: a personal orchestrator cannot write `team:{id}/…` paths; the team orchestrator writes only its own scope; the `team:` path prefix is reserved (rejected by path validation for writes, parsed only on reads/search listings).
- **Membership at query time**: the personal read-union resolves the user's team IDs per query (`listTeamsForUser`), never cached in the snapshot.
- The DO's `teamMemoryGuardError` from phase 3 is **removed** and replaced with real owner-scoped wiring.

## Decisions locked here

| Question | Decision |
|---|---|
| Helper signatures | `owner: Principal` replaces `userId` (approach B, no parallel fork); writes take `actorUserId` for provenance (defaults to `owner.id` for user owners) |
| Cross-scope addressing | Virtual prefix `team:{teamId}/<path>` in search/list results and read addressing from personal orchestrators; membership verified on read |
| Team orchestrator reads | Own team scope only (no personal, no other teams) |
| Snapshot/journal | Owner-scoped; team orchestrator restart now loads its team snapshot + journal (phase 3 skip removed); journal rows' `user_id` = actor |
| Team memory API | `GET /api/teams/:id/memory[?path=]` + `GET …/memory/search` (member); `PUT`/`DELETE …/memory` (team admin, per spec UI rule) |
| Team Memory tab | Lean file browser (list/read for members; edit/delete for admins); the full explorer/graph parity can follow the okf-memory branch merge |
| Export/import, relevance boost, prune | Generalized mechanically with the same owner param; team export UI deferred (deletion flow already offers it via API) |

---

### Task 1: Migration 0026 + owner-scoped memory helpers + tests
`packages/worker/migrations/0026_memory_owner_scope.sql` (drop the stale unique index); `lib/db/memory-files.ts` and `lib/memory-snapshot.ts` generalized (`owner: Principal`, conflict targets, filters); `searchMemoryFilesScoped`/`listMemoryFilesScoped` scope-union variants returning each row's owner; Drizzle schema note for the dropped index. Update existing memory tests to the new signatures; add: team-scope isolation (same path, two teams, same creator), scope-union search returns tagged owners, write rejects `team:`-prefixed paths.

### Task 2: Call-site wiring (routes, DO, restart)
`routes/orchestrator.ts` `/me/memory*` passes `userPrincipal(user.id)`; DO `mem-*` handlers derive the session owner from `parseOrchestratorSessionId` — team orchestrator: own-scope reads/writes with actor provenance; personal orchestrator: writes personal, reads/search union over `[user, …memberTeams]` with `team:{id}/` prefixes, `mem-read` parses the prefix and re-verifies membership; `teamMemoryGuardError` removed. `restartOrchestratorSessionForOwner` loads journal+snapshot for team owners too.

### Task 3: Team memory routes + Memory tab
Routes on `teamsRouter` per the decisions table (member read / admin write, `assertTeamAccess`); client hooks (`useTeamMemoryFiles`, `useTeamMemoryFile`, `useWriteTeamMemoryFile`, `useDeleteTeamMemoryFile`, `useSearchTeamMemory`); Memory tab replaces its stub with the lean browser. Route authz tests.

### Task 4: Specs + full verification + push
`orchestrator.md` memory section (owner scoping, union, prefix addressing — replace the phase-3 "no memory" notes), teams design doc §3 implementation notes, `auth-access.md` team memory routes. Full suites + client build; push; PR comment.
