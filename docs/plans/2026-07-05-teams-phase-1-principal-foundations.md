# Teams Phase 1: Principal Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the principal ownership model (`user` | `team` | `org`) across shared types, session IDs, scope keys, D1 schema, and sandbox volume naming — behavior-identical after landing except orchestrator workspaces start fresh (accepted hard cutover).

**Architecture:** A new `Principal` type in `@valet/shared` becomes the single way to express resource ownership. Orchestrator session IDs move from `orchestrator:{userId}` to `orchestrator:user:{userId}` via a full D1 data migration (no dual-format code). Owned tables gain `owner_type`/`owner_id` columns backfilled from `user_id`. Workspace volumes are a **hard cutover**: names stay derived from the session ID (the backend's legacy rotation-stripping is removed so canonical IDs derive unique names), which means renamed orchestrator sessions come up with fresh volumes — accepted; durable state (memory, identity, tasks) lives in D1, and old volumes are simply orphaned in Modal.

**Tech Stack:** TypeScript (Cloudflare Worker, Hono, Drizzle/D1), Python 3.12 (Modal backend), vitest.

**Spec:** `docs/specs/2026-07-05-teams-design.md` (§1 and §8 phase 1). Phases 2–7 get their own plans after this lands.

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md Type Safety rules).
- Behavior must be identical after this phase, with one accepted exception: orchestrator sandboxes start with fresh (empty) workspace volumes after the ID migration.
- Migration file is `packages/worker/migrations/0024_principal_ownership.sql` (0023 is the current latest **on `main`**; renumber if another migration lands first).
- **Test environment:** vitest 4 requires Node ≥ 20.19; use Node 22 (`nvm use 22.22.2` or similar). Before the first test run: `pnpm install && pnpm --filter @valet/shared build && pnpm --filter @valet/sdk build && make generate-registries && pnpm rebuild better-sqlite3`. Without these, dozens of pre-existing tests fail with module-resolution errors unrelated to your changes. Record the pre-change failure count and compare against it, rather than assuming zero baseline failures.
- **Dependency note:** branch `conner/okf-memory-spec` (unmerged, ~49 commits) adds `memory_links` and FTS columns (`description`, `tags`). If it merges before this plan executes: add `owner_type`/`owner_id` to `memory_links` (backfill from `user_id`). Nothing else in this plan changes.
- **Deploy ordering (both dev and prod):** apply the migration BEFORE deploying the worker — new worker code looks up `orchestrator:user:{id}` rows which only exist post-migration. Sequence: `ENVIRONMENT=<env> make deploy-migrate`, then `deploy-worker`, then `make deploy-modal`. Do not use plain `make deploy` for this release (it deploys the worker first).

---

### Task 1: Principal module in `@valet/shared`

**Files:**
- Create: `packages/shared/src/principal.ts`
- Create: `packages/shared/src/principal.test.ts`
- Modify: `packages/shared/src/index.ts` (add export)

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `type PrincipalType = 'user' | 'team' | 'org'`
  - `interface Principal { type: PrincipalType; id: string }`
  - `formatPrincipal(p: Principal): string` → `"user:abc"`
  - `parsePrincipal(s: string): Principal` (throws `Error` on malformed input)
  - `userPrincipal(userId: string): Principal`
  - `orchestratorSessionId(owner: Principal): string` → `"orchestrator:user:abc"`
  - `isOrchestratorSessionId(sessionId: string | null | undefined): boolean`
  - `parseOrchestratorSessionId(sessionId: string): Principal | null`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/principal.test.ts
import { describe, expect, it } from 'vitest';
import {
  formatPrincipal,
  isOrchestratorSessionId,
  orchestratorSessionId,
  parseOrchestratorSessionId,
  parsePrincipal,
  userPrincipal,
} from './principal.js';

describe('principal', () => {
  it('formats and parses round-trip', () => {
    expect(formatPrincipal({ type: 'user', id: 'u1' })).toBe('user:u1');
    expect(formatPrincipal({ type: 'team', id: 't1' })).toBe('team:t1');
    expect(parsePrincipal('user:u1')).toEqual({ type: 'user', id: 'u1' });
    expect(parsePrincipal('org:default')).toEqual({ type: 'org', id: 'default' });
  });

  it('parses ids containing colons (opaque id tail)', () => {
    expect(parsePrincipal('user:a:b')).toEqual({ type: 'user', id: 'a:b' });
  });

  it('throws on malformed principals', () => {
    expect(() => parsePrincipal('user:')).toThrow();
    expect(() => parsePrincipal('robot:u1')).toThrow();
    expect(() => parsePrincipal('u1')).toThrow();
    expect(() => parsePrincipal('')).toThrow();
  });

  it('builds userPrincipal', () => {
    expect(userPrincipal('u1')).toEqual({ type: 'user', id: 'u1' });
  });

  it('builds orchestrator session ids', () => {
    expect(orchestratorSessionId({ type: 'user', id: 'u1' })).toBe('orchestrator:user:u1');
    expect(orchestratorSessionId({ type: 'team', id: 't1' })).toBe('orchestrator:team:t1');
  });

  it('detects orchestrator session ids (any format, prefix-based)', () => {
    expect(isOrchestratorSessionId('orchestrator:user:u1')).toBe(true);
    expect(isOrchestratorSessionId('orchestrator:u1')).toBe(true); // pre-migration legacy
    expect(isOrchestratorSessionId('sess-123')).toBe(false);
    expect(isOrchestratorSessionId(null)).toBe(false);
    expect(isOrchestratorSessionId(undefined)).toBe(false);
  });

  it('parses canonical orchestrator session ids', () => {
    expect(parseOrchestratorSessionId('orchestrator:user:u1')).toEqual({ type: 'user', id: 'u1' });
    expect(parseOrchestratorSessionId('orchestrator:team:t1')).toEqual({ type: 'team', id: 't1' });
    expect(parseOrchestratorSessionId('orchestrator:u1')).toBeNull(); // legacy → not parseable
    expect(parseOrchestratorSessionId('sess-123')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/shared exec vitest run src/principal.test.ts`
Expected: FAIL — `Cannot find module './principal.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/principal.ts
/**
 * A principal is anything that can own resources: a user, a team, or (future) an org.
 * Canonical string form: `${type}:${id}`, e.g. "user:abc", "team:xyz".
 */
export type PrincipalType = 'user' | 'team' | 'org';

export interface Principal {
  type: PrincipalType;
  id: string;
}

const PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'team', 'org'];

export function formatPrincipal(p: Principal): string {
  return `${p.type}:${p.id}`;
}

export function parsePrincipal(s: string): Principal {
  const idx = s.indexOf(':');
  const type = idx === -1 ? '' : s.slice(0, idx);
  const id = idx === -1 ? '' : s.slice(idx + 1);
  if (!(PRINCIPAL_TYPES as readonly string[]).includes(type) || id.length === 0) {
    throw new Error(`Invalid principal: ${s}`);
  }
  return { type: type as PrincipalType, id };
}

export function userPrincipal(userId: string): Principal {
  return { type: 'user', id: userId };
}

// ─── Orchestrator session IDs ────────────────────────────────────────────────
// Canonical form: `orchestrator:${type}:${id}`, e.g. "orchestrator:user:abc".

const ORCHESTRATOR_PREFIX = 'orchestrator:';

export function orchestratorSessionId(owner: Principal): string {
  return `${ORCHESTRATOR_PREFIX}${formatPrincipal(owner)}`;
}

/** Prefix check only — matches legacy pre-migration IDs too, on purpose. */
export function isOrchestratorSessionId(sessionId: string | null | undefined): boolean {
  return sessionId?.startsWith(ORCHESTRATOR_PREFIX) ?? false;
}

/** Returns the owning principal of a canonical orchestrator session ID, or null. */
export function parseOrchestratorSessionId(sessionId: string): Principal | null {
  if (!sessionId.startsWith(ORCHESTRATOR_PREFIX)) return null;
  try {
    return parsePrincipal(sessionId.slice(ORCHESTRATOR_PREFIX.length));
  } catch {
    return null;
  }
}
```

Add to `packages/shared/src/index.ts`, next to the existing `export * from './scope-key.js';` line:

```ts
export * from './principal.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/shared exec vitest run src/principal.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Rebuild shared and typecheck**

Run: `pnpm --filter @valet/shared build && pnpm typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/principal.ts packages/shared/src/principal.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): principal model and orchestrator session ID helpers"
```

---

### Task 2: Generalize scope keys to principals

**Files:**
- Modify: `packages/shared/src/scope-key.ts` (full rewrite below)
- Create: `packages/shared/src/scope-key.test.ts`
- Modify (callers, `userId` → `userPrincipal(userId)`): `packages/worker/src/durable-objects/session-agent.ts`, `packages/worker/src/lib/db/channels.ts`, `packages/worker/src/routes/channel-webhooks.ts`, `packages/worker/src/routes/channels.ts`, `packages/worker/src/routes/slack-events.ts`, `packages/worker/src/services/orchestrator.ts`, `packages/worker/src/services/sessions.ts`

**Interfaces:**
- Consumes: `Principal`, `formatPrincipal`, `userPrincipal` from Task 1.
- Produces: same six builder functions, first parameter now `owner: Principal` instead of `userId: string`. **Output strings for user principals are byte-identical to today** (`user:{id}:...`), so no scope-key data migration exists anywhere in this plan.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/scope-key.test.ts
import { describe, expect, it } from 'vitest';
import {
  apiScopeKey,
  channelScopeKey,
  githubPrScopeKey,
  slackScopeKey,
  telegramScopeKey,
  webManualScopeKey,
} from './scope-key.js';
import { userPrincipal } from './principal.js';

describe('scope keys', () => {
  const u = userPrincipal('u1');

  it('produces byte-identical legacy strings for user principals', () => {
    expect(webManualScopeKey(u, 's1')).toBe('user:u1:manual:s1');
    expect(slackScopeKey(u, 'T1', 'C1', '123.45')).toBe('user:u1:slack:T1:C1:123.45');
    expect(githubPrScopeKey(u, 'org/repo', 7)).toBe('user:u1:github:org/repo:pr:7');
    expect(apiScopeKey(u, 'idem-1')).toBe('user:u1:api:idem-1');
    expect(channelScopeKey(u, 'slack', 'C1')).toBe('user:u1:slack:C1');
    expect(telegramScopeKey(u, '42')).toBe('user:u1:telegram:42');
  });

  it('produces team-prefixed keys for team principals', () => {
    expect(channelScopeKey({ type: 'team', id: 't1' }, 'slack', 'C1')).toBe('team:t1:slack:C1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/shared exec vitest run src/scope-key.test.ts`
Expected: FAIL — type errors / wrong output (current builders take `userId: string`)

- [ ] **Step 3: Rewrite scope-key.ts**

```ts
// packages/shared/src/scope-key.ts
import { formatPrincipal, type Principal } from './principal.js';

export function webManualScopeKey(owner: Principal, sessionId: string): string {
  return `${formatPrincipal(owner)}:manual:${sessionId}`;
}

export function slackScopeKey(owner: Principal, teamId: string, channelId: string, threadTs: string): string {
  return `${formatPrincipal(owner)}:slack:${teamId}:${channelId}:${threadTs}`;
}

export function githubPrScopeKey(owner: Principal, repoFullName: string, prNumber: number): string {
  return `${formatPrincipal(owner)}:github:${repoFullName}:pr:${prNumber}`;
}

export function apiScopeKey(owner: Principal, idempotencyKey: string): string {
  return `${formatPrincipal(owner)}:api:${idempotencyKey}`;
}

export function channelScopeKey(owner: Principal, channelType: string, channelId: string): string {
  return `${formatPrincipal(owner)}:${channelType}:${channelId}`;
}

export function telegramScopeKey(owner: Principal, chatId: string): string {
  return channelScopeKey(owner, 'telegram', chatId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/shared exec vitest run src/scope-key.test.ts`
Expected: PASS

- [ ] **Step 5: Update the seven worker callers**

Rebuild shared first so the worker sees the new types: `pnpm --filter @valet/shared build`

Find every call site: `grep -rn "ScopeKey(" packages/worker/src --include='*.ts' | grep -v test`

At each site, wrap the existing userId argument: `channelScopeKey(userId, ...)` → `channelScopeKey(userPrincipal(userId), ...)`, importing `userPrincipal` from `@valet/shared`. Do not change any other argument. Example (from `routes/slack-events.ts`):

```ts
// before
const scopeKey = channelScopeKey(userId, parts.channelType, parts.channelId);
// after
const scopeKey = channelScopeKey(userPrincipal(userId), parts.channelType, parts.channelId);
```

- [ ] **Step 6: Typecheck catches any missed caller**

Run: `pnpm typecheck`
Expected: clean. (Signature change makes missed callers a compile error — that is the point of not adding an overload.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/scope-key.ts packages/shared/src/scope-key.test.ts packages/worker/src
git commit -m "feat(shared): scope keys take a principal owner"
```

---

### Task 3: Migration 0024 + Drizzle schema

**Files:**
- Create: `packages/worker/migrations/0024_principal_ownership.sql`
- Modify: `packages/worker/src/lib/schema/sessions.ts` (sessions table)
- Modify: `packages/worker/src/lib/schema/orchestrator.ts`
- Modify: `packages/worker/src/lib/schema/memory-files.ts`
- Modify: `packages/worker/src/lib/schema/channels.ts` (channelBindings)
- Modify: `packages/worker/src/lib/schema/channel-threads.ts`
- Modify: `packages/worker/src/lib/schema/workflows.ts` (workflows table)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure SQL + schema).
- Produces: columns `owner_type TEXT NOT NULL DEFAULT 'user'`, `owner_id TEXT NOT NULL DEFAULT ''` on the six tables above; canonical orchestrator session IDs in all data. Drizzle fields are named `ownerType`, `ownerId`.

- [ ] **Step 1: Write the migration**

```sql
-- 0024_principal_ownership.sql
-- Teams phase 1: principal ownership columns, canonical orchestrator session IDs.
-- See docs/specs/2026-07-05-teams-design.md §1.

PRAGMA defer_foreign_keys = on;

-- ── 1. Owner columns (backfilled as user-owned) ─────────────────────────────
ALTER TABLE sessions ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE sessions SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE orchestrator_identities ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE orchestrator_identities ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE orchestrator_identities SET owner_id = user_id WHERE owner_id = '' AND user_id IS NOT NULL;

ALTER TABLE orchestrator_memory_files ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE orchestrator_memory_files ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE orchestrator_memory_files SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE channel_bindings ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE channel_bindings ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE channel_bindings SET owner_id = user_id WHERE owner_id = '' AND user_id IS NOT NULL;

ALTER TABLE channel_thread_mappings ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE channel_thread_mappings ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE channel_thread_mappings SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE workflows ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE workflows ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE workflows SET owner_id = created_by WHERE owner_id = '' AND created_by IS NOT NULL;

-- ── 2. Canonical orchestrator session IDs ───────────────────────────────────
-- NOTE: this is a hard cutover for orchestrator workspace volumes — the volume
-- name is derived from the session ID, so renamed sessions get fresh volumes.
-- Durable state (memory, identity, tasks) lives in D1; old volumes are orphaned.
-- orchestrator:<rest> → orchestrator:user:<rest>  ('orchestrator:' is 13 chars)
UPDATE sessions SET id = 'orchestrator:user:' || substr(id, 14)
  WHERE id LIKE 'orchestrator:%' AND id NOT LIKE 'orchestrator:user:%';
UPDATE sessions SET parent_session_id = 'orchestrator:user:' || substr(parent_session_id, 14)
  WHERE parent_session_id LIKE 'orchestrator:%' AND parent_session_id NOT LIKE 'orchestrator:user:%';
UPDATE messages SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE screenshots SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_git_state SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_files_changed SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_participants SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_share_links SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_threads SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE channel_bindings SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE channel_thread_mappings SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE analytics_events SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE runtime_grants SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE action_invocations SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_tasks SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_tasks SET orchestrator_session_id = 'orchestrator:user:' || substr(orchestrator_session_id, 14)
  WHERE orchestrator_session_id LIKE 'orchestrator:%' AND orchestrator_session_id NOT LIKE 'orchestrator:user:%';
UPDATE workflow_spawned_sessions SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE agent_memories SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET from_session_id = 'orchestrator:user:' || substr(from_session_id, 14)
  WHERE from_session_id LIKE 'orchestrator:%' AND from_session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET to_session_id = 'orchestrator:user:' || substr(to_session_id, 14)
  WHERE to_session_id LIKE 'orchestrator:%' AND to_session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET context_session_id = 'orchestrator:user:' || substr(context_session_id, 14)
  WHERE context_session_id LIKE 'orchestrator:%' AND context_session_id NOT LIKE 'orchestrator:user:%';

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX idx_sessions_owner ON sessions(owner_type, owner_id);
-- Partial: user_id is nullable, so legacy rows without one backfill to owner_id=''.
CREATE UNIQUE INDEX idx_orch_identity_owner ON orchestrator_identities(org_id, owner_type, owner_id) WHERE owner_id != '';
CREATE INDEX idx_memory_files_owner ON orchestrator_memory_files(owner_type, owner_id);
CREATE UNIQUE INDEX idx_memory_files_owner_path ON orchestrator_memory_files(owner_type, owner_id, path);
CREATE INDEX idx_channel_bindings_owner ON channel_bindings(owner_type, owner_id);
```

Before committing, verify the rewrite list is complete — every table carrying session IDs must appear in section 2 above:

Run: `grep -rn "references(() => sessions.id" packages/worker/src/lib/schema/*.ts | wc -l`
Expected: `12` (messages, screenshots, session_git_state, session_files_changed, session_participants, session_share_links, session_threads, channel_bindings, channel_thread_mappings, analytics_events, runtime_grants, action_invocations). Plus the non-FK carriers already listed: `sessions.parent_session_id`, `session_tasks.session_id` **and** `session_tasks.orchestrator_session_id` (NOT NULL — the board key), `workflow_spawned_sessions.session_id`, `agent_memories.session_id`, and `mailbox_messages` (`from_session_id`, `to_session_id`, `context_session_id` — in `schema/notifications.ts`). The authoritative check is against a migrated database, not the Drizzle files: `SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND p.name LIKE '%session_id%'` (exclude the `opencode_session_id` columns — those are OpenCode's IDs, not Valet session IDs).

- [ ] **Step 2: Update Drizzle schemas**

Add to each table's column list (Drizzle camelCase maps to snake_case automatically only when explicit — follow each file's existing convention; `memory-files.ts` uses explicit names like `text('user_id')`, `sessions.ts` uses implicit casing — check each file and match it):

```ts
// sessions table (packages/worker/src/lib/schema/sessions.ts) — implicit casing style
ownerType: text().notNull().default('user'),
ownerId: text().notNull().default(''),
// and in the index list:
index('idx_sessions_owner').on(table.ownerType, table.ownerId),
```

```ts
// orchestrator_identities (schema/orchestrator.ts)
ownerType: text().notNull().default('user'),
ownerId: text().notNull().default(''),
// index list:
uniqueIndex('idx_orch_identity_owner').on(table.orgId, table.ownerType, table.ownerId),
```

```ts
// orchestrator_memory_files (schema/memory-files.ts) — explicit-name style
ownerType: text('owner_type').notNull().default('user'),
ownerId: text('owner_id').notNull().default(''),
// index list:
index('idx_memory_files_owner').on(table.ownerType, table.ownerId),
uniqueIndex('idx_memory_files_owner_path').on(table.ownerType, table.ownerId, table.path),
```

```ts
// channel_bindings (schema/channels.ts) and channel_thread_mappings (schema/channel-threads.ts)
// and workflows (schema/workflows.ts) — match each file's casing convention
ownerType: text().notNull().default('user'),
ownerId: text().notNull().default(''),
```

For `channel_bindings` also add `index('idx_channel_bindings_owner').on(table.ownerType, table.ownerId)`.

Note for `workflows`: confirm the creator column is `created_by` (`grep -n "createdBy\|created_by" packages/worker/src/lib/schema/workflows.ts`). If it is named differently, fix the backfill UPDATE in the migration to match.

- [ ] **Step 3: Apply locally and verify**

```bash
make db-migrate
cd packages/worker
npx wrangler d1 execute DB --local --command \
  "SELECT id, owner_type, owner_id FROM sessions WHERE is_orchestrator = 1 LIMIT 5"
```

Expected: IDs shaped `orchestrator:user:<userId>`; `owner_type='user'`; `owner_id=<userId>`. (If local DB is empty, run `make db-seed` first.)

```bash
npx wrangler d1 execute DB --local --command \
  "SELECT count(*) AS stale FROM sessions WHERE id LIKE 'orchestrator:%' AND id NOT LIKE 'orchestrator:user:%'"
```

Expected: `stale = 0`.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/migrations/0024_principal_ownership.sql packages/worker/src/lib/schema
git commit -m "feat(worker): principal ownership columns + canonical orchestrator session IDs"
```

---

### Task 4: Worker code swap — session ID construction, prefix checks, owner columns

**Files:**
- Modify: `packages/worker/src/services/orchestrator.ts` (ID construction at lines ~116, ~317, ~410, ~418, ~421; spawnRequest)
- Modify: `packages/worker/src/routes/channel-webhooks.ts:406`
- Modify: `packages/worker/src/routes/admin.ts:443`
- Modify: `packages/worker/src/lib/db/orchestrator.ts:135`
- Modify: `packages/worker/src/lib/db/sessions.ts` (`upsertOrchestratorSession`, line ~179)
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (prefix checks at lines ~634, ~1606, ~4464, ~4690, ~5748)
- Modify: `packages/worker/src/services/session-cross.ts:275`
- Modify: `packages/worker/src/services/sessions.ts:231`

**Interfaces:**
- Consumes: `orchestratorSessionId`, `isOrchestratorSessionId`, `userPrincipal` from Task 1; owner columns from Task 3.
- Produces: `upsertOrchestratorSession` accepts `ownerType`, `ownerId` fields. Session IDs sent to the backend are canonical (`orchestrator:user:{id}`), which Task 5's volume-derivation fix depends on.

- [ ] **Step 1: Replace every ID construction site**

Find them: `grep -rn '\`orchestrator:\${' packages/worker/src --include='*.ts'`

At each site (services/orchestrator.ts ×5, routes/channel-webhooks.ts, routes/admin.ts, lib/db/orchestrator.ts):

```ts
// before
const sessionId = `orchestrator:${userId}`;
// after
import { orchestratorSessionId, userPrincipal } from '@valet/shared';
const sessionId = orchestratorSessionId(userPrincipal(userId));
```

- [ ] **Step 2: Replace every prefix check with the shared helper**

Find them: `grep -rn "startsWith('orchestrator:')" packages/worker/src --include='*.ts'`

At each site (session-agent.ts ×5, session-cross.ts, services/sessions.ts):

```ts
// before
const isOrchestrator = this.sessionState.sessionId?.startsWith('orchestrator:') ?? false;
// after
import { isOrchestratorSessionId } from '@valet/shared';
const isOrchestrator = isOrchestratorSessionId(this.sessionState.sessionId);
```

Semantics are identical (prefix check) — this step centralizes the knowledge so phase 3 can add owner-aware behavior in one place.

- [ ] **Step 3: Persist owner columns on orchestrator upsert**

In `packages/worker/src/lib/db/sessions.ts`, extend `upsertOrchestratorSession`:

```ts
export async function upsertOrchestratorSession(
  db: AppDb,
  data: {
    id: string; userId: string; workspace: string; title?: string; personaId?: string;
    isOrchestrator?: boolean; purpose?: SessionPurpose;
    ownerType?: 'user' | 'team' | 'org'; ownerId?: string;
  }
): Promise<AgentSession> {
  const purpose = data.purpose || 'orchestrator';
  await db.insert(sessions).values({
    id: data.id,
    userId: data.userId,
    workspace: data.workspace,
    status: 'initializing',
    title: data.title || null,
    personaId: data.personaId || null,
    isOrchestrator: data.isOrchestrator ?? true,
    purpose,
    ownerType: data.ownerType ?? 'user',
    ownerId: data.ownerId ?? data.userId,
  }).onConflictDoNothing({ target: sessions.id });
  // ... rest of the function unchanged
```

In `services/orchestrator.ts` `restartOrchestratorSession`, pass the new fields:

```ts
await db.upsertOrchestratorSession(appDb, {
  id: sessionId,
  userId,
  workspace: 'orchestrator',
  title: `${identity.name} (Orchestrator)`,
  isOrchestrator: true,
  purpose: 'orchestrator',
  personaId: identity.personaId ?? undefined,
  ownerType: 'user',
  ownerId: userId,
});
```

The spawn request is unchanged — volume naming stays derived from the session ID on the backend (fixed in Task 5). Regular (non-orchestrator) session creation is untouched in this phase: their IDs don't change format.

- [ ] **Step 4: Verify nothing constructs or parses the legacy format**

```bash
grep -rn 'orchestrator:\${' packages/worker/src --include='*.ts' | grep -v test
grep -rn "startsWith('orchestrator:')" packages/worker/src --include='*.ts' | grep -v test
```

Expected: no matches from either command (all sites now use the shared helpers).

- [ ] **Step 5: Typecheck and run worker tests**

Run: `pnpm typecheck && pnpm --filter @valet/worker exec vitest run src/services/orchestrator.test.ts`
Expected: typecheck clean; orchestrator service tests pass (update any test fixture that asserts the literal `orchestrator:<userId>` format to expect `orchestrator:user:<userId>`).

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): construct and detect orchestrator sessions via principal helpers"
```

---

### Task 5: Backend — fix workspace volume derivation for canonical IDs

**Files:**
- Modify: `backend/sandboxes.py` (`workspace_volume_name` at line ~99)

**Interfaces:**
- Consumes: canonical session IDs (`orchestrator:user:{id}`) from Task 4.
- Produces: per-session-unique volume names derived from the full session ID. **Hard cutover:** orchestrator sessions get fresh volumes after the migration (old `workspace-orchestrator-<userId>` volumes are orphaned in Modal — acceptable; durable state lives in D1).

- [ ] **Step 1: Remove the legacy rotation-stripping**

The current derivation strips everything after the second colon (`orchestrator:<userId>:<uuid>` → `orchestrator:<userId>`, a relic of the old rotating-ID scheme). Under canonical IDs that logic maps `orchestrator:user:u1` to `workspace-orchestrator-user` — one shared volume for **every** user. Replace the whole method:

```python
@staticmethod
def workspace_volume_name(session_id: str) -> str:
    """Return the Modal volume name for a session workspace, derived from the
    full session ID (canonical orchestrator IDs are orchestrator:<type>:<id>)."""
    return f"workspace-{session_id.replace(':', '-')}"
```

`orchestrator:user:u1` → `workspace-orchestrator-user-u1`; a future `orchestrator:team:t1` → `workspace-orchestrator-team-t1` with no further backend change. Regular session IDs contain no colons, so their names are unchanged.

- [ ] **Step 2: Verify no other backend code depends on the stripping**

Run: `grep -rn "workspace_volume_name" backend/*.py`
Expected: the definition in `sandboxes.py`, its use in `create_sandbox`/`restore_sandbox` volume mounts, and `delete_workspace_volume`. All of these want the same full-ID derivation — no further changes.

- [ ] **Step 3: Deploy note (do not deploy yet)**

Backend change ships with `make deploy-modal` at release time. No `IMAGE_BUILD_VERSION` bump needed — nothing under `docker/` or `packages/runner/` changed. Old orchestrator volumes (`workspace-orchestrator-<userId>`) can be garbage-collected later via `modal volume list`/`delete` — optional, not part of this plan.

- [ ] **Step 4: Commit**

```bash
git add backend/sandboxes.py
git commit -m "fix(backend): derive workspace volumes from full session ID"
```

---

### Task 6: Spec updates + full verification

**Files:**
- Modify: `docs/specs/orchestrator.md` (session ID format, identity owner columns; correct the stale `orchestrator:{userId}:{uuid}` rotation prose and the org-orchestrator-exists claim)
- Modify: `docs/specs/sessions.md` (ownership vs actor distinction)
- Modify: `docs/specs/sandbox-runtime.md` (workspace volume derivation from full session ID)

**Interfaces:**
- Consumes: everything above.
- Produces: specs match the code, per CLAUDE.md's same-commit rule.

- [ ] **Step 1: Update the three specs**

In each spec, update the affected sections to describe: canonical `orchestrator:{type}:{id}` session IDs, `owner_type`/`owner_id` columns (backfilled `'user'`), volume names derived from the full session ID (no rotation-stripping), and the note that `team`/`org` owners arrive in later phases. Keep edits surgical — don't rewrite unrelated sections.

- [ ] **Step 2: Full verification suite**

```bash
pnpm typecheck
pnpm --filter @valet/shared exec vitest run
pnpm --filter @valet/worker exec vitest run
cd packages/client && pnpm build   # required by CLAUDE.md before any frontend-adjacent commit
```

Expected: typecheck clean; shared tests pass; worker tests match or beat the pre-change baseline count (record it in Task 1); client build clean (no client changes, so this is a regression check).

- [ ] **Step 3: Commit**

```bash
git add docs/specs
git commit -m "docs: update subsystem specs for principal ownership"
```

---

## Release checklist (when this branch ships)

1. `ENVIRONMENT=dev make deploy-migrate` — migration first, always.
2. `ENVIRONMENT=dev make deploy-worker`
3. `make deploy-modal`
4. Verify: restart an orchestrator from the web UI; confirm it comes up with session ID `orchestrator:user:<id>` and a **fresh, empty workspace** (expected — hard volume cutover; memory/identity/tasks from D1 are intact), and Slack DM routing still reaching it.
5. Repeat 1–4 for prod (`ENVIRONMENT=prod`, tag-triggered release). The dev soak validates the migration against real data shapes first.

Rollback caution: the ID rewrite is one-way (old workers can't find `orchestrator:user:` rows). If the worker must be rolled back after the migration, orchestrator sessions will appear missing until users restart them — data is not lost, but don't roll back casually.
