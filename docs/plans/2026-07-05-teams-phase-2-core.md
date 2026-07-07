# Teams Phase 2: Teams Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teams exist as first-class entities: tables, CRUD + membership API with role enforcement, and the Teams UI shell (list, create, team page with Members + Settings live and later-phase tabs stubbed).

**Architecture:** Standard new-entity pattern (CLAUDE.md "Adding a new D1 table"): migration → Drizzle schema → shared types → db helpers → Hono router → client query hooks → routes/UI. Authorization is enforced in the route layer from two inputs: the caller's `team_members` row and the global `users.role` ('admin' = org admin). Non-members receive 404s, mirroring `assertSessionAccess` semantics.

**Tech Stack:** D1/Drizzle, Hono + zod, React 19 + TanStack Router/Query, Radix UI.

**Spec:** `docs/specs/2026-07-05-teams-design.md` §2 (schema, enforcement), §7 (UI). Builds on phase 1 (merged into this same PR branch).

## Global Constraints

- Same test-environment setup as phase 1 (Node 22, built shared/sdk, generated registries, rebuilt better-sqlite3). Baseline: all tests green.
- No `any` / no double-casts (CLAUDE.md Type Safety).
- Client: `cd packages/client && pnpm build` must pass before committing frontend changes (stricter than typecheck).
- Migration number `0025` (0024 is phase 1).
- Later-phase tabs (Chat, Board, Memory, Channels, Integrations) render as disabled/"coming soon" stubs — phase 2 ships Members + Settings only.

---

### Task 1: Migration 0025, Drizzle schema, shared types

**Files:**
- Create: `packages/worker/migrations/0025_teams.sql`
- Create: `packages/worker/src/lib/schema/teams.ts`; re-export from `schema/index.ts`
- Modify: `packages/shared/src/types/index.ts` (Team types near `OrchestratorIdentity`)

**Interfaces (produced):**

```ts
// shared
export type TeamRole = 'admin' | 'member';
export interface Team {
  id: string; orgId: string; name: string; description?: string; avatar?: string;
  createdBy?: string; createdAt: string; updatedAt: string;
  memberCount?: number;   // populated by list/get helpers
  myRole?: TeamRole;      // populated for the requesting user; absent for org-admin spectators
}
export interface TeamMember {
  teamId: string; userId: string; role: TeamRole; addedBy?: string; createdAt: string;
  name?: string; email?: string; avatarUrl?: string;  // joined from users
}
```

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  avatar TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_teams_org_name ON teams(org_id, name);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);
```

Team names are unique per org (case-sensitive; a duplicate create/rename returns 409). Steps: write SQL + schema + types → `pnpm --filter @valet/shared build && pnpm typecheck` → verify migration applies to the scratch DB (same sqlite3 harness as phase 1) → commit.

---

### Task 2: DB helpers with real-database tests

**Files:**
- Create: `packages/worker/src/lib/db/teams.ts`; re-export from `lib/db.ts`
- Create: `packages/worker/src/lib/db/teams.test.ts` (uses `createTestDb()` — real migrations, no mocks)

**Interfaces (produced):**

```ts
createTeam(db, p: { name; description?; avatar?; createdBy; orgId? }): Promise<Team>   // + creator admin row, atomically
getTeam(db, teamId): Promise<Team | null>                                              // with memberCount
listTeamsForUser(db, userId): Promise<Team[]>                                          // membership join; myRole + memberCount
listAllTeams(db, orgId?): Promise<Team[]>                                              // org-admin view
updateTeam(db, teamId, p: { name?; description?; avatar? }): Promise<Team>
deleteTeam(db, teamId): Promise<void>                                                  // throws ValidationError if team-owned workflows exist
listTeamMembers(db, teamId): Promise<TeamMember[]>                                     // users join
getTeamMembership(db, teamId, userId): Promise<TeamMember | null>
addTeamMember(db, teamId, userId, role, addedBy): Promise<TeamMember>
updateTeamMemberRole(db, teamId, userId, role): Promise<void>                          // ValidationError on demoting last admin
removeTeamMember(db, teamId, userId): Promise<void>                                    // ValidationError on removing last admin
```

The **last-admin guard** lives in the db layer (both role change and removal) so no future route can bypass it. `deleteTeam` checks `workflows WHERE owner_type='team' AND owner_id=?` (spec: deletion blocked while team-owned workflows exist) — trivially satisfiable today, structurally correct for phase 7.

Tests (TDD, `createTestDb`): create → creator is admin + memberCount 1; duplicate name 409-shape error; list for member vs non-member; add/remove/update-role; last-admin guards (demote and remove); self-leave allowed when another admin exists; cascade on team delete removes members; delete blocked by seeded team-owned workflow row.

---

### Task 3: Routes + authz tests

**Files:**
- Create: `packages/worker/src/routes/teams.ts`; mount `app.route('/api/teams', teamsRouter)` in `index.ts`
- Create: `packages/worker/src/routes/teams.test.ts` (mocked `lib/db.js`, triggers.test.ts pattern)

**Authorization matrix (route layer; `orgAdmin = c.get('user').role === 'admin'`):**

| Route | Rule |
|---|---|
| `POST /api/teams` | any authed user; creator becomes team admin |
| `GET /api/teams` | own teams; `?all=true` + org admin → all teams |
| `GET /api/teams/:id` | member or org admin; else **404** |
| `PATCH /api/teams/:id` | team admin or org admin |
| `DELETE /api/teams/:id` | team admin or org admin; 409 while team-owned workflows exist |
| `GET /api/teams/:id/members` | member or org admin |
| `POST /api/teams/:id/members` | team admin or org admin; body `{ userId?, email?, role? }` (email resolved via existing user lookup; unknown → 404, invites out of scope) |
| `PATCH /api/teams/:id/members/:userId` | team admin or org admin (role change) |
| `DELETE /api/teams/:id/members/:userId` | team admin, org admin, **or self** (leave) |
| `GET /api/teams/directory` | any authed user; minimal `{id, name, email, avatarUrl}` list for the member picker (single-tenant org — all users are org members) |

zod-validated bodies (`name` 1–100 chars, `role` enum). Route tests cover the matrix: non-member 404 on GET/:id, member cannot PATCH, team admin can, org admin can without membership, self-leave, add-by-email unknown user 404.

---

### Task 4: Client — API hooks + Teams UI shell

**Files:**
- Create: `packages/client/src/api/teams.ts` (query-key factory + hooks, per existing api/* conventions)
- Create: `packages/client/src/routes/teams.index.tsx` (list + create dialog)
- Create: `packages/client/src/routes/teams.$teamId.tsx` (team page: tab shell)
- Create: `packages/client/src/components/teams/*` as needed (member list, add-member dialog, settings form)
- Modify: `packages/client/src/components/layout/sidebar.tsx` (Teams nav item)

Behavior:
- **List**: skeleton loader, empty state with create CTA, card/row per team (name, member count, your role). Create dialog: name + description.
- **Team page tabs**: Members (list with avatars/roles; add member via directory picker; role dropdown + remove, guards surfaced as toasts), Settings (rename/description/avatar; danger zone: delete with typed confirmation, disabled while… nothing yet — 409 handled as toast). Chat/Board/Memory/Channels/Integrations render disabled "arrives in a later phase" placeholders.
- Mutations invalidate `teamKeys.*`. Follow the conventions the sidebar/list/detail exploration documents (PageContainer/PageHeader, Radix dialog/tabs).

Verify: `pnpm typecheck` + `cd packages/client && pnpm build`.

---

### Task 5: Spec upkeep + full verification

- Update `docs/specs/auth-access.md`: teams tables, roles, authz matrix (same-commit rule).
- Update `docs/specs/2026-07-05-teams-design.md` if implementation diverged.
- Full: `pnpm typecheck`; shared + worker vitest suites; client build. Commit per task throughout.
