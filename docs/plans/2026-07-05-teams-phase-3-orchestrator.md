# Teams Phase 3: Team Orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team gets its own orchestrator: admin-onboarded identity, `orchestrator:team:{teamId}` session with lifecycle/auto-restart, membership-gated access (done: team-aware `assertSessionAccess`, committed `d7762ed8`), team-owned child sessions, live-connection eviction on member removal, and a working Chat tab in the web UI.

**Architecture:** Generalize the orchestrator service by owner principal rather than forking it: `restartOrchestratorSessionForOwner(env, owner, actor, identity)` becomes the core; the existing user function is a thin wrapper. Identity CRUD gains owner-keyed variants reading the (already-written) `owner_type`/`owner_id` columns. A new colon-free session alias `team-orchestrator-{teamId}` mirrors the personal `orchestrator` alias in all three route resolvers and client-side. The web Chat tab embeds the existing `ChatContainer` (prop-driven sessionId) inside a local `DrawerCtx.Provider`.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §2 (team orchestrator, access control), §8 phase 3.

## Global Constraints

- Same env setup as phases 1–2 (Node 22 etc.). Baseline: all suites green (35 shared, 1259 worker).
- No `any`/double-casts; client `pnpm build` before frontend commits.
- **Phase-boundary guards, explicit not implicit:**
  - **Memory**: team orchestrators run without memory until phase 4. Skip journal/snapshot at restart; `mem-*` tool handlers in the DO return a clear error for team-owned sessions (they key on `sessionState.userId` and would otherwise silently write the *actor's personal* memory — a leak).
  - **Credentials**: `assembleCredentialEnv` is skipped for team owners (phase 7); team orchestrator gets provider vars only. Child sessions spawned by the team orchestrator keep the current actor-credential injection for now (the actor chose to spawn them); phase 7 replaces this with team-sourced resolution — noted in the spec.

## Decisions locked here

| Question | Decision |
|---|---|
| Service shape | Generalize by `owner: Principal`; user path wraps it. No parallel fork. |
| Team orchestrator queue mode | `'followup'` (queued) instead of `'steer'` — v1 of "queued between authors"; same-author steer refinement deferred, spec updated |
| Restart rights | Onboard/identity-edit = team admin. Restart of an existing identity = any member (it's recovery — the cron does it with no user at all) |
| Alias | `team-orchestrator-{teamId}` (colon-free, stable, pure string transform both sides) |
| Idle/model prefs | Team orchestrator: org model preferences, default idle timeout (900s), no TZ injection |
| `orchestrator_identities.type` | `'team'` for team identities; `userId` NULL; `owner_type='team'`, `owner_id=teamId` |
| Team avatar upload | Deferred (R2 avatar route is user-keyed); onboarding takes name/handle/instructions v1 |
| Eviction | `DELETE /:id/members/:userId` fans out `POST /evict-user` to non-terminal team-owned session DOs; DO closes `client:{userId}` sockets |

---

### Task 1: DB + service generalization (owner-keyed)

**Files:** `lib/db/orchestrator.ts`, `services/orchestrator.ts`, new `services/team-orchestrator.ts`, `packages/shared/src/types/index.ts` (OrchestratorIdentity owner fields, `OrchestratorType` gains `'team'`), tests `lib/db/orchestrator-owner.test.ts` (real DB).

- `rowToIdentity` maps `ownerType`/`ownerId`; `createOrchestratorIdentity` accepts `owner: Principal` and sets `ownerType/ownerId/type/userId` accordingly (user identities keep `userId`, team identities have `userId: null, type: 'team'`).
- New: `getOrchestratorIdentityByOwner(db, owner, orgId?)`, `getCurrentOrchestratorSessionByOwner(db, owner)`, `getNonTerminalOrchestratorSessionsByOwner(db, owner)` — reading owner columns.
- `restartOrchestratorSessionForOwner(env, owner, actor: {userId, email}, identity, requestUrl?)`: sessionId from `orchestratorSessionId(owner)`; upsert with owner columns and `userId = actor.userId`; user-owner branch keeps journal/snapshot/credentials/user-prefs/TZ/`queueMode:'steer'`; team-owner branch skips memory + credentials, uses org model prefs + `queueMode:'followup'`. Existing `restartOrchestratorSession(env, userId, ...)` delegates.
- `services/team-orchestrator.ts`: `onboardTeamOrchestrator(env, teamId, actor, params)` (already_exists / handle_taken / name_taken flow mirroring the personal one), `getTeamOrchestratorInfo(env, db, teamId)` (identity + session + needsRestart), `restartTeamOrchestrator(...)`.
- Tests: identity CRUD by owner (user + team), non-terminal lookup by owner, and a restart-shape test if mockable cheaply (else covered by route tests).

### Task 2: Routes + alias + eviction

**Files:** `routes/teams.ts` (+tests), `routes/sessions.ts`, `routes/threads.ts`, `routes/files.ts` (alias resolvers), `durable-objects/session-agent.ts` (evict handler).

- `GET /api/teams/:id/orchestrator` (member) → info; `POST /api/teams/:id/orchestrator` (team admin) → onboard, 409 mapping; `POST /api/teams/:id/orchestrator/restart` (member) → restart existing identity.
- All three `resolveRequestedSessionId`-style helpers learn the second alias: `team-orchestrator-{teamId}` → `orchestrator:team:{teamId}` (pure transform; access enforcement stays in `assertSessionAccess`).
- Eviction: after successful non-self member removal, list non-terminal team-owned sessions and POST each DO `/evict-user {userId}` (fire-and-forget with logging). DO handler closes `getWebSockets('client:'+userId)` with code 1000 and cleans `connected_users`.
- Route tests: onboard admin-only; restart member-allowed; info 404 for non-members; alias transform unit-tested.

### Task 3: Child ownership + DO guards + cron

**Files:** `lib/db/sessions.ts` (`createSession` owner params), `services/session-cross.ts` (inherit owner from parent), `services/sessions.ts` (inherit for user-initiated children of team sessions), `durable-objects/session-agent.ts` (mem-* team guard), `index.ts` (`reconcileOrchestrators` owner-join).

- `db.createSession` gains `ownerType`/`ownerId` (defaults preserved). `spawnChild` reads the parent session row and inherits its owner onto the child.
- DO `mem-read|write|patch|rm|search` handlers: if `parseOrchestratorSessionId(sessionId)?.type === 'team'` **or** the session row is team-owned (sessionState), return an error result: "Team memory is not available yet (phase 4)".
- `reconcileOrchestrators` queries join on `s.id = 'orchestrator:' || oi.owner_type || ':' || oi.owner_id` (canonical post-migration for both user and team identities).
- Tests: child inherits team owner (real-DB via spawn-path db function); reconcile query shape (SQL smoke against scratch DB).

### Task 4: Client — team Chat tab

**Files:** `api/teams.ts` (orchestrator hooks), `components/teams/team-detail.tsx` (Chat tab), new `components/teams/team-orchestrator-chat.tsx` + `team-orchestrator-setup.tsx`, `hooks/use-resolved-session-id.ts` (team alias), `components/chat/chat-container.tsx` (team-aware back button).

- Hooks: `useTeamOrchestrator(teamId)`, `useCreateTeamOrchestrator()`, `useRestartTeamOrchestrator()`.
- Chat tab states: no identity + admin → setup form (name/handle/instructions, 409s as toasts); no identity + member → "an admin needs to set this up"; identity + needsRestart → auto-restart (any member) with progress; else embed `ChatContainer` in a `DrawerCtx.Provider`, `sessionId = orchestrator:team:{teamId}`, `routeSessionId = team-orchestrator-{teamId}`.
- `useResolvedSessionId`: `team-orchestrator-{id}` → `orchestrator:team:{id}` (pure transform).
- Back button: team-owned session → `/teams/{ownerId}` instead of `/orchestrator`.

### Task 5: Specs + verification

- Spec updates: `orchestrator.md` (team lifecycle, alias, queue-mode note), `sessions.md` (child owner inheritance), teams design doc (v1 divergences: queue mode `followup`, member-restart, actor-credential interim, avatar deferred), `auth-access.md` (orchestrator routes on `/api/teams`).
- Full: typecheck, shared+worker suites, client build; push; PR comment.
