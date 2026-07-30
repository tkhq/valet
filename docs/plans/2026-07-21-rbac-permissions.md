# RBAC Fixed Roles + Permissions Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three org roles (admin/operator/member) enforced through a named-permission seam (`can(principal, permission)`), `org_members.role` as the single org-role source, and Keycloak-governed roles synced on every SSO login.

**Architecture:** A new `auth/permissions.ts` module owns the vocabulary and role bundles; the auth middleware stamps `orgRole` + `permissions` onto `AuthUser`; every org-admin gate migrates to `requirePermission(...)`; the `@better-auth/sso` plugin's `provisionUser` (+ `provisionUserOnEveryLogin: true`) syncs `org_members.role` from a configurable IdP claim map.

**Tech Stack:** Hono 4, Drizzle/PGlite, better-auth + `@better-auth/sso` 1.6.x, vitest, React 19 (packages/web).

Spec: `docs/specs/2026-07-21-rbac-permissions-design.md` — read it before starting any task. The "Compatibility" section is binding.

## Global Constraints

- Branch `feat/rbac-permissions` (already exists, has the spec commits), PR against `dev-v2`, title prefixed `v2:`. Never merge without user approval.
- Node 22 for all test runs: `source ~/.nvm/nvm.sh && nvm use 22`.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place; NO new numbered migrations. `rm -rf ~/.valet/pg` locally after schema edits.
- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety).
- No Co-Authored-By trailers. Terse commit subjects ≤72 chars.
- Permission strings are the OAuth scope vocabulary: exactly `org:manage`, `members:manage`, `providers:manage`, `infra:manage`, `credentials:org`. Never rename.
- Roles: exactly `admin`, `operator`, `member`. Routes must never match on role names — only permissions. (`/api/admin/*` global-operator gate on `users.role` is the sole exception and is untouched.)
- `users.role` is NEVER written by the IdP map.
- Error copy: existing pinned strings (`"org admin required"`, `LAST_ADMIN_ERROR`) must keep working where tests assert them; new permission gates use `{ error: "forbidden" }` unless a task says otherwise.

---

### Task 1: Permissions module (`auth/permissions.ts`)

**Files:**
- Create: `packages/api/src/auth/permissions.ts`
- Create: `packages/api/src/auth/permissions.test.ts`
- Modify: `packages/api/src/services/org.ts:14` (re-point `OrgRole`)

**Interfaces:**
- Produces (all later tasks import these exact names from `../auth/permissions.js`):

```ts
export const PERMISSIONS = ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const ORG_ROLES = ["admin", "operator", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]>;
export function isOrgRole(v: unknown): v is OrgRole;
export function permissionsForOrgRole(role: OrgRole): ReadonlySet<Permission>;
export function can(principal: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean;
```

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/auth/permissions.test.ts`:

```ts
/**
 * Permission vocabulary + role bundles (RBAC design,
 * docs/specs/2026-07-21-rbac-permissions-design.md). The bundle contents
 * are pinned exactly — a drive-by edit to a bundle is a security change
 * and must show up as a test diff.
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ORG_ROLES,
  ROLE_PERMISSIONS,
  isOrgRole,
  permissionsForOrgRole,
  can,
} from "./permissions.js";

describe("role bundles", () => {
  it("pins the exact bundle contents per role", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual([
      "org:manage",
      "members:manage",
      "providers:manage",
      "infra:manage",
      "credentials:org",
    ]);
    expect([...ROLE_PERMISSIONS.operator]).toEqual(["providers:manage", "infra:manage", "credentials:org"]);
    expect([...ROLE_PERMISSIONS.member]).toEqual([]);
  });

  it("admin holds every permission in the vocabulary", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual([...PERMISSIONS]);
  });
});

describe("isOrgRole", () => {
  it("accepts exactly the three roles", () => {
    for (const role of ORG_ROLES) expect(isOrgRole(role)).toBe(true);
    expect(isOrgRole("owner")).toBe(false);
    expect(isOrgRole(undefined)).toBe(false);
  });
});

describe("can", () => {
  it("checks membership of the principal's permission set", () => {
    const operator = { permissions: permissionsForOrgRole("operator") };
    expect(can(operator, "providers:manage")).toBe(true);
    expect(can(operator, "members:manage")).toBe(false);
    expect(can({ permissions: permissionsForOrgRole("member") }, "credentials:org")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/auth/permissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/api/src/auth/permissions.ts`:

```ts
/**
 * Permission vocabulary + fixed role bundles (RBAC design,
 * docs/specs/2026-07-21-rbac-permissions-design.md).
 *
 * BINDING: permission strings are the future OAuth scope vocabulary —
 * never rename a shipped permission, only add. `can()` is deliberately
 * typed against "anything carrying a permission set", not `AuthUser`, so
 * future principals (scoped API keys, OAuth access tokens, sandbox
 * principals) reuse the same seam without route changes. Custom roles
 * later = replace ROLE_PERMISSIONS with a DB-backed lookup; nothing else
 * moves, which is why routes must never match on role names.
 */
export const PERMISSIONS = [
  "org:manage", // rename org, feature toggles
  "members:manage", // roster view, role changes, invites
  "providers:manage", // LLM providers, provider API keys, org model preferences
  "infra:manage", // GitHub App setup, image catalog, prebuild configs/internals
  "credentials:org", // org-scoped credential CRUD
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ORG_ROLES = ["admin", "operator", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  admin: ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
  operator: ["providers:manage", "infra:manage", "credentials:org"],
  member: [],
};

export function isOrgRole(v: unknown): v is OrgRole {
  return typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);
}

const BUNDLES: Record<OrgRole, ReadonlySet<Permission>> = {
  admin: new Set(ROLE_PERMISSIONS.admin),
  operator: new Set(ROLE_PERMISSIONS.operator),
  member: new Set(ROLE_PERMISSIONS.member),
};

export function permissionsForOrgRole(role: OrgRole): ReadonlySet<Permission> {
  return BUNDLES[role];
}

export function can(principal: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean {
  return principal.permissions.has(permission);
}
```

In `packages/api/src/services/org.ts`, replace line 14's `export type OrgRole = "admin" | "member";` with a re-export so existing importers keep working:

```ts
export { type OrgRole, isOrgRole } from "../auth/permissions.js";
```

(Check `services/org.ts` for a local `isOrgRole`-style validator; if one exists, delete it in favor of the re-export. Also grep `from "../services/org.js"` importers of `OrgRole` — they now transparently get the widened type; compile errors here are Task 3's migration surface showing up early, fix only type-level fallout in this task, not gates.)

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/auth/permissions.test.ts && pnpm --filter @valet/api typecheck`
Expected: tests PASS. Typecheck may surface enum-widening fallout (e.g. `setOrgMemberRole` callers) — fix type-level only (no behavior changes; the `org.ts:171` last-admin guard condition is Task 3's job, but if the compiler forces it, change `role === "member"` to `role !== "admin"` here and note it in the commit).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/auth/permissions.ts packages/api/src/auth/permissions.test.ts packages/api/src/services/org.ts
git commit -m "feat(api): permission vocabulary + org role bundles"
```

---

### Task 2: AuthUser carries orgRole + permissions; schema widens

**Files:**
- Modify: `packages/api/src/middleware/auth.ts` (AuthUser at :12-18, ladder rungs at :137-210)
- Modify: `packages/api/src/schema/index.ts:289` (org_members enum)
- Modify: `packages/api/migrations/pg/0000_app.sql` (org_members role comment/constraint if any — check; text column likely needs no SQL change, verify with grep `org_members` in the migration and update any CHECK constraint)
- Modify: `packages/api/src/routes/_org-admin.ts` (add `requirePermission`)
- Test: `packages/api/src/middleware/auth.orgrole.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `OrgRole`, `Permission`, `permissionsForOrgRole`, `can`.
- Produces:

```ts
// middleware/auth.ts
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  /** Global operator flag (users.role) — gates /api/admin only. */
  role: "admin" | "member";
  /** Org role from org_members.role — the authorization source for org surfaces. */
  orgRole: OrgRole;
  permissions: ReadonlySet<Permission>;
  orgId: string;
}

// routes/_org-admin.ts
export function requirePermission(permission: Permission): (c: Context<AppEnv>) => Response | undefined
// usage: const gate = requirePermission("providers:manage")(c); if (gate) return gate;
// returns 403 { error: "forbidden" } when !can(c.var.user, permission)
```

- [ ] **Step 1: Widen the schema enum**

`packages/api/src/schema/index.ts:289`:

```ts
    role: text("role", { enum: ["admin", "operator", "member"] }).notNull(),
```

Grep `packages/api/migrations/pg/0000_app.sql` for `org_members` — the `role TEXT NOT NULL` column has no CHECK constraint to update (verify; if one exists, widen it). Run `rm -rf ~/.valet/pg` only if the SQL file changed.

- [ ] **Step 2: Write the failing middleware test**

Create `packages/api/src/middleware/auth.orgrole.test.ts`:

```ts
/**
 * AuthUser.orgRole/permissions stamping (RBAC design): the ladder resolves
 * org_members.role per request — the org role, not users.role, drives
 * permissions. Uses bootTestApi's seeded multi-user fixtures + the
 * x-valet-test-user-id impersonation seam (VALET_TEST_AUTH_HEADER).
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgMembers } from "../schema/index.js";
import type { GetOrgResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("orgRole resolution", () => {
  it("permissions follow org_members.role, not users.role", async () => {
    api = await bootTestApi();
    // test-member is seeded with org_members.role "member" (verify seed in
    // integration/_setup.ts; adjust the seeded id if names differ).
    // Promote them to operator directly in the db:
    await api.db.update(orgMembers).set({ role: "operator" }).where(eq(orgMembers.userId, "test-member"));

    const res = await fetch(`${api.baseUrl}/api/org`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const body = (await res.json()) as GetOrgResponse;
    expect(body.callerRole).toBe("operator");
    expect(body.permissions).toEqual(["providers:manage", "infra:manage", "credentials:org"]);
  });

  it("a user with no org_members row resolves to member (empty permissions)", async () => {
    api = await bootTestApi();
    await api.db.delete(orgMembers).where(eq(orgMembers.userId, "test-member"));
    const res = await fetch(`${api.baseUrl}/api/org`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const body = (await res.json()) as GetOrgResponse;
    expect(body.callerRole).toBe("member");
    expect(body.permissions).toEqual([]);
  });
});
```

Note: this test asserts through `GET /api/org`'s response, which gains `permissions` in Task 3 — write BOTH tests now, expect them to fail until Task 3 for the `permissions` field; the middleware half (this task) makes `callerRole` correct. If `TestApi` exposes no `db` handle, check `integration/_setup.ts` for the exported handle name and adapt (it exists for other suites; grep `api.db` usage).

- [ ] **Step 3: Implement the middleware stamping**

In `packages/api/src/middleware/auth.ts`:

```ts
import { orgMembers } from "../schema/index.js";
import { permissionsForOrgRole, isOrgRole, type OrgRole, type Permission } from "../auth/permissions.js";
```

Add a resolver next to `normalizeRole`:

```ts
/** Org role from org_members.role — "member" when no membership row exists
 * (defensive: a session for a user whose membership was removed must not
 * gain permissions). */
async function resolveOrgRole(db: AppDb, orgId: string, userId: string): Promise<OrgRole> {
  const rows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  const role = rows[0]?.role;
  return isOrgRole(role) ? role : "member";
}
```

(Import `and` from drizzle-orm alongside the existing `eq`.)

Update every `c.set("user", {...})` site (rungs 3, 4, 5-impersonation, 5-stub) to stamp the two new fields. Session rung example:

```ts
        const orgId = await resolveOrgId(db);
        const orgRole = await resolveOrgRole(db, orgId, sessionResult.user.id);
        c.set("user", {
          id: sessionResult.user.id,
          email: sessionResult.user.email,
          name: sessionResult.user.name,
          role: normalizeRole(sessionResult.user.role),
          orgRole,
          permissions: permissionsForOrgRole(orgRole),
          orgId,
        } satisfies AuthUser);
```

API-key rung and impersonation rung: same pattern with their own `row.id`. Stub rung (`LOCAL_USER`): stamp `orgRole: "admin"`, `permissions: permissionsForOrgRole("admin")` (dev keeps full access, per spec).

Update the `AuthUser` interface as shown in Interfaces. Add `requirePermission` to `routes/_org-admin.ts`:

```ts
import { can, type Permission } from "../auth/permissions.js";

/** 403 gate on the caller's permission set (RBAC design). Usage:
 * `const gate = requirePermission("providers:manage")(c); if (gate) return gate;`
 * Synchronous — permissions were resolved by the auth middleware. */
export function requirePermission(permission: Permission) {
  return (c: Context<AppEnv>): Response | undefined => {
    if (!can(c.var.user, permission)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return undefined;
  };
}
```

Keep `requireOrgAdmin` exported and working (Task 3 removes its callers; delete it there).

- [ ] **Step 4: Run tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/middleware && pnpm --filter @valet/api typecheck`
Expected: `auth.orgrole.test.ts` — first test's `callerRole` assertion may still fail on `permissions` (Task 3 adds the field); if so, split the assertion so this task's commit has the callerRole halves green and the permissions halves in a `it.todo`/follow-up marker replaced in Task 3. Existing middleware tests PASS. Typecheck clean (new AuthUser fields are additive; any `satisfies AuthUser` literal in tests/fixtures needs the fields — fix them: `orgRole: "admin", permissions: permissionsForOrgRole("admin")` or as appropriate).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/middleware/auth.ts packages/api/src/middleware/auth.orgrole.test.ts \
  packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql packages/api/src/routes/_org-admin.ts
git commit -m "feat(api): AuthUser orgRole + permissions; org_members enum widened"
```

---

### Task 3: Gate migration (all org surfaces → permissions)

**Files:**
- Modify: `packages/api/src/routes/org.ts` (local `requireOrgAdmin` + GET response)
- Modify: `packages/api/src/routes/org-invites.ts` (local copy + role validation copy string)
- Modify: `packages/api/src/routes/llm-providers.ts` (local copy)
- Modify: `packages/api/src/routes/github-app.ts`, `packages/api/src/routes/image-catalog.ts`, `packages/api/src/routes/prebuilds.ts` (shared `requireOrgAdmin` callers)
- Modify: `packages/api/src/routes/credentials.ts:64-68,110-114,148-152` (org-scope gates — the bug fix)
- Modify: `packages/api/src/services/org.ts` (last-admin guard for operator)
- Modify: `packages/api/src/wire/types.ts:919` (callerRole type + permissions field)
- Modify: `packages/api/src/routes/_org-admin.ts` (delete `requireOrgAdmin` once callers are gone)
- Tests: extend `packages/api/src/routes/org.test.ts`, `org-invites.test.ts`, `llm-providers.test.ts`, `credentials.test.ts` (+ the Task 2 test file's permissions assertions now go green)

**Interfaces:**
- Consumes: Task 2's `requirePermission`, `AuthUser.permissions`; Task 1's `Permission`.
- Produces: wire change — `GetOrgResponse.callerRole: OrgRole` and `GetOrgResponse.permissions: Permission[]` (web Task 6 consumes).

Gate map (spec, binding):

| Surface | Permission |
|---|---|
| `PATCH /api/org` | `org:manage` |
| org members roster/role, invites (all routes) | `members:manage` |
| llm-providers admin routes + model prefs | `providers:manage` |
| github-app setup/config, image-catalog, prebuilds admin routes | `infra:manage` |
| credentials org scope (GET/PUT/DELETE) | `credentials:org` |

- [ ] **Step 1: Write the failing tests**

Add to the relevant existing test files (match each file's boot/impersonation idiom; `_setup.ts` seeds `test-member` — promote to operator via direct db update as in Task 2's test):

```ts
// org.test.ts — operator must NOT manage the org:
it("operator gets 403 from PATCH /api/org and member management", async () => {
  api = await bootTestApi();
  await api.db.update(orgMembers).set({ role: "operator" }).where(eq(orgMembers.userId, "test-member"));
  const asOperator = { headers: { "x-valet-test-user-id": "test-member", "Content-Type": "application/json" } };

  const patch = await fetch(`${api.baseUrl}/api/org`, { method: "PATCH", body: JSON.stringify({ name: "x" }), ...asOperator });
  expect(patch.status).toBe(403);
  const members = await fetch(`${api.baseUrl}/api/org/members`, { headers: asOperator.headers });
  expect(members.status).toBe(403);
});

// org.test.ts — GET /api/org reports permissions:
it("GET /api/org returns the caller's permissions", async () => {
  api = await bootTestApi();
  const res = await fetch(`${api.baseUrl}/api/org`);
  const body = (await res.json()) as GetOrgResponse;
  expect(body.callerRole).toBe("admin"); // stub identity
  expect(body.permissions).toEqual(["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"]);
});

// llm-providers.test.ts — operator CAN manage providers:
it("operator can list/create llm providers", async () => {
  api = await bootTestApi();
  await api.db.update(orgMembers).set({ role: "operator" }).where(eq(orgMembers.userId, "test-member"));
  const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: { "x-valet-test-user-id": "test-member" } });
  expect(res.status).toBe(200);
});

// credentials.test.ts — THE regression test for the divergence bug:
it("org-scope credential access follows org_members.role, not users.role", async () => {
  api = await bootTestApi();
  // test-admin is seeded with users.role admin AND org_members.role admin
  // (verify seed); demote ONLY the org membership:
  await api.db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, "test-admin"));
  const res = await fetch(`${api.baseUrl}/api/credentials?scope=org`, {
    headers: { "x-valet-test-user-id": "test-admin" },
  });
  expect(res.status).toBe(403); // was 200 pre-fix — stale users.role honored
});

// org.test.ts — last-admin guard covers demote-to-operator:
it("demoting the sole admin to operator is rejected", async () => {
  api = await bootTestApi();
  // stub local-user... use the seeded admin path per this file's existing
  // last-admin test (copy its arrangement, change target role to "operator").
  // Assert the same LAST_ADMIN_ERROR copy.
});
```

Fill the last test from the file's existing last-admin test verbatim, changing `role: "member"` to `role: "operator"` in the PATCH body.

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test -- src/routes/org.test.ts src/routes/llm-providers.test.ts src/routes/credentials.test.ts`
Expected: new tests FAIL (operator currently 403s from providers since `isOrgAdmin` is admin-only; org-scope credential test gets 200; `permissions` field absent).

- [ ] **Step 3: Migrate the gates**

- `wire/types.ts:919`: `callerRole: "admin" | "operator" | "member";` and add `permissions: ("org:manage" | "members:manage" | "providers:manage" | "infra:manage" | "credentials:org")[];` to `GetOrgResponse` (wire types are hand-written string unions in this file — match its idiom; do NOT import from auth/permissions into wire/types if the file convention is self-contained unions — check neighboring types first).
- `routes/org.ts`: GET computes `orgRole` from `c.var.user.orgRole` (middleware already resolved it — delete the local `isOrgAdmin` call) and passes `permissions: [...c.var.user.permissions]`. PATCH → `requirePermission("org:manage")`. Members routes → `requirePermission("members:manage")`. Delete the local `requireOrgAdmin` copy. Role-change body validation switches to `isOrgRole` from Task 1 (error copy: update `"role must be 'admin' or 'member'"`-style strings to include operator, and update any test pinning them). `setOrgMemberRole` last-admin condition in `services/org.ts:171` becomes `member.role === "admin" && role !== "admin"`.
- `routes/org-invites.ts`: gates → `requirePermission("members:manage")`; invite role validation widens to `isOrgRole` (invites may now carry `operator`); update the `:52` copy string and its tests.
- `routes/llm-providers.ts`: delete local `requireOrgAdmin`, all admin gates → `requirePermission("providers:manage")`.
- `routes/github-app.ts`, `routes/image-catalog.ts`, `routes/prebuilds.ts`: replace `requireOrgAdmin(c)` calls with `requirePermission("infra:manage")(c)` (same `const gate = …; if (gate) return gate;` shape; note the extra call parens).
- `routes/credentials.ts`: replace all three `user.role !== "admin"` org-scope checks with `!can(user, "credentials:org")` (import `can` from `../auth/permissions.js`). Keep the response copy `{ error: "org admin required" }` IF existing tests pin it — check `credentials.test.ts`; if pinned, keep the string (copy is cosmetic; the gate is what changed). Update the file's header comment (it documents the JWT-role variant).
- Delete `requireOrgAdmin` from `routes/_org-admin.ts` and `services/org.ts`'s `isOrgAdmin` **only if** no callers remain (grep; `routes/teams.ts` uses org-admin checks for its recovery path — those calls migrate to `can(user, "members:manage")`-equivalent via `c.var.user.permissions.has("members:manage")` OR keep `isOrgAdmin` for teams' db-level check where no Hono context exists. Prefer: teams' `canMutateTeam` takes the caller's permission set as a param; smallest change wins — decide by reading `routes/teams.ts:93-131`, keep behavior identical).

- [ ] **Step 4: Run the full api suite**

Run: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/api test && pnpm --filter @valet/api typecheck`
Expected: all green, including Task 2's deferred `permissions` assertions. Fix pinned-copy fallout properly (update the pin AND the copy together only where the copy legitimately changed, e.g. invite role message).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): migrate org gates to permission checks"
```

---

### Task 4: OIDC role-map config

**Files:**
- Modify: `packages/api/src/auth/config.ts` (parse + validate)
- Modify: `packages/api/src/auth/config.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `isOrgRole`, `OrgRole`.
- Produces: `AuthConfig.oidc` gains (only when oidc is configured):

```ts
  roleMap?: { claimValue: string; role: OrgRole }[]; // order = precedence
  roleClaim: string; // dot-path, default "realm_access.roles"
```

- [ ] **Step 1: Write the failing tests** (extend `config.test.ts`, matching its env-fixture idiom):

```ts
it("parses AUTH_OIDC_ROLE_MAP preserving order and AUTH_OIDC_ROLE_CLAIM default", () => {
  const cfg = loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "valet-admin:admin, valet-operator:operator" });
  expect(cfg?.oidc?.roleMap).toEqual([
    { claimValue: "valet-admin", role: "admin" },
    { claimValue: "valet-operator", role: "operator" },
  ]);
  expect(cfg?.oidc?.roleClaim).toBe("realm_access.roles");
});

it("honors AUTH_OIDC_ROLE_CLAIM override", () => {
  const cfg = loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "x:member", AUTH_OIDC_ROLE_CLAIM: "resource_access.valet.roles" });
  expect(cfg?.oidc?.roleClaim).toBe("resource_access.valet.roles");
});

it("throws on an unknown role in the map", () => {
  expect(() => loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "x:owner" })).toThrow(/AUTH_OIDC_ROLE_MAP/);
});

it("throws on a malformed pair", () => {
  expect(() => loadAuthConfig({ ...baseOidcEnv, AUTH_OIDC_ROLE_MAP: "justoneword" })).toThrow(/AUTH_OIDC_ROLE_MAP/);
});

it("throws when ROLE_MAP is set without OIDC configured", () => {
  expect(() => loadAuthConfig({ BETTER_AUTH_SECRET: "s", AUTH_OIDC_ROLE_MAP: "x:admin" })).toThrow(/AUTH_OIDC_ROLE_MAP/);
});
```

(`baseOidcEnv` = whatever fixture the file already uses for a valid OIDC triple; reuse it.)

- [ ] **Step 2: Run to verify FAIL**, **Step 3: Implement** in `loadAuthConfig`'s oidc block (mirror the existing all-or-none validation style — throw `Error` with the env var name in the message):

```ts
  const roleClaim = env.AUTH_OIDC_ROLE_CLAIM?.trim() || "realm_access.roles";
  let roleMap: { claimValue: string; role: OrgRole }[] | undefined;
  if (env.AUTH_OIDC_ROLE_MAP) {
    if (!oidcConfigured) throw new Error("AUTH_OIDC_ROLE_MAP requires the AUTH_OIDC_* provider to be configured");
    roleMap = env.AUTH_OIDC_ROLE_MAP.split(",").map((pair) => {
      const idx = pair.indexOf(":");
      const claimValue = idx === -1 ? "" : pair.slice(0, idx).trim();
      const role = idx === -1 ? "" : pair.slice(idx + 1).trim();
      if (!claimValue || !isOrgRole(role)) {
        throw new Error(`AUTH_OIDC_ROLE_MAP entry "${pair.trim()}" must be "<claimValue>:<admin|operator|member>"`);
      }
      return { claimValue, role };
    });
  }
```

Attach `roleMap`/`roleClaim` to the returned oidc object. **Step 4: Run** config tests + typecheck → PASS. **Step 5: Commit** `feat(api): AUTH_OIDC_ROLE_MAP / AUTH_OIDC_ROLE_CLAIM config`.

---

### Task 5: SSO role sync on every login

**Files:**
- Create: `packages/api/src/auth/sso-role-sync.ts`
- Create: `packages/api/src/auth/sso-role-sync.test.ts`
- Modify: `packages/api/src/auth/index.ts` (sso plugin options, ~:207-224)

**Interfaces:**
- Consumes: Task 4's `roleMap`/`roleClaim`; Task 1's `OrgRole`; `ensureOrg` + `orgMembers` schema.
- Produces:

```ts
// sso-role-sync.ts
export function extractMappedRole(params: {
  roleMap: { claimValue: string; role: OrgRole }[];
  roleClaim: string; // dot-path
  userInfo: Record<string, unknown>;
  idTokenClaims?: Record<string, unknown>;
}): OrgRole; // first map entry whose claimValue appears in the claim values; "member" when none

export function decodeJwtClaims(jwt: string): Record<string, unknown> | null; // base64url payload decode, no verification (token came direct from the token endpoint over TLS)

export async function syncSsoOrgRole(db: AppDb, userId: string, role: OrgRole): Promise<void>;
// writes org_members.role when it differs; inserts nothing (membership row
// is created by provisioning's userCreateAfter — on first login the sync
// runs after it); NEVER touches users.role.
```

- [ ] **Step 1: Write the failing tests**

```ts
// sso-role-sync.test.ts
import { describe, it, expect } from "vitest";
import { extractMappedRole, decodeJwtClaims } from "./sso-role-sync.js";

const roleMap = [
  { claimValue: "valet-admin", role: "admin" as const },
  { claimValue: "valet-operator", role: "operator" as const },
];

describe("extractMappedRole", () => {
  it("maps from userInfo dot-path (Keycloak realm_access.roles)", () => {
    const userInfo = { realm_access: { roles: ["offline_access", "valet-operator"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo })).toBe("operator");
  });

  it("map order wins when multiple values match", () => {
    const userInfo = { realm_access: { roles: ["valet-operator", "valet-admin"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo })).toBe("admin");
  });

  it("falls back to idTokenClaims when userInfo lacks the path", () => {
    const idTokenClaims = { realm_access: { roles: ["valet-admin"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {}, idTokenClaims })).toBe("admin");
  });

  it("no match / absent claim → member", () => {
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {} })).toBe("member");
    expect(
      extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: { realm_access: { roles: ["other"] } } }),
    ).toBe("member");
  });

  it("accepts a bare string claim value (non-array)", () => {
    expect(extractMappedRole({ roleMap, roleClaim: "role", userInfo: { role: "valet-admin" } })).toBe("admin");
  });
});

describe("decodeJwtClaims", () => {
  it("decodes a base64url payload and rejects garbage", () => {
    const payload = Buffer.from(JSON.stringify({ realm_access: { roles: ["x"] } })).toString("base64url");
    expect(decodeJwtClaims(`h.${payload}.s`)).toEqual({ realm_access: { roles: ["x"] } });
    expect(decodeJwtClaims("nope")).toBeNull();
  });
});
```

Plus a `syncSsoOrgRole` db test using `freshTestPgDb` (seed an org + org_members row, sync to operator, assert row changed and `users` untouched; sync same role again → still correct (idempotent)).

- [ ] **Step 2: Run to verify FAIL.** **Step 3: Implement** `sso-role-sync.ts` (dot-path walk over `unknown` with `isRecord`-style narrowing — no `any`; claim value may be `string[]` or `string`), then wire in `auth/index.ts`'s sso options:

```ts
      sso({
        ...(cfg.oidc
          ? {
              defaultSSO: [ /* unchanged */ ],
              ...(cfg.oidc.roleMap
                ? {
                    provisionUser: async ({ user, userInfo, token }) => {
                      const idToken = token?.idToken;
                      const role = extractMappedRole({
                        roleMap: cfg.oidc.roleMap,
                        roleClaim: cfg.oidc.roleClaim,
                        userInfo,
                        idTokenClaims: idToken ? (decodeJwtClaims(idToken) ?? undefined) : undefined,
                      });
                      await syncSsoOrgRole(db, user.id, role);
                    },
                    provisionUserOnEveryLogin: true,
                  }
                : {}),
            }
          : {}),
      }),
```

Check `OAuth2Tokens`' actual property name for the ID token in `@better-auth/sso`'s types (`idToken` vs `id_token`) and the `userInfo` value shape before writing — adjust to reality; the pnpm dist path is `node_modules/.pnpm/@better-auth+sso@1.6.23_*/node_modules/@better-auth/sso/dist/index-D9brFUE1.d.mts`. Note the sync runs on first login too — `userCreateAfter` inserts the membership row earlier in the same flow, so `syncSsoOrgRole` finding no row is a no-op by design (verify hook ordering with a targeted test if `auth-instance.test.ts` has an SSO fixture; if it doesn't, the live Keycloak pass covers it and the unit tests cover the parts).

**Step 4: Run** `pnpm --filter @valet/api test -- src/auth && pnpm --filter @valet/api typecheck` → PASS. **Step 5: Commit** `feat(api): sync org role from IdP claims on every SSO login`.

---

### Task 6: Keycloak harness roles + Makefile

**Files:**
- Modify: `docker/keycloak/valet-realm.json`
- Modify: `Makefile` (`dev-keycloak` printed `.env` block)
- Modify: `docs/specs/2026-07-14-auth-v2-design.md` (Keycloak section: role-map paragraph)

**Steps:**

- [ ] **Step 1**: In `valet-realm.json`, add realm roles and grants:
  - A top-level `"roles": { "realm": [...] }` section (create if absent) gaining `{ "name": "valet-admin" }` and `{ "name": "valet-operator" }` (match the JSON structure Keycloak 26 export uses — if the file has no roles section, the minimal `{"roles": {"realm": [{"name": "valet-admin"}, {"name": "valet-operator"}]}}` import shape works).
  - alice's `"realmRoles"` becomes `["offline_access", "valet-admin"]`; bob's becomes `["offline_access", "valet-operator"]`.
- [ ] **Step 2**: Makefile `dev-keycloak` echo block gains `AUTH_OIDC_ROLE_MAP=valet-admin:admin,valet-operator:operator` (and mentions the default `AUTH_OIDC_ROLE_CLAIM`). Auth-v2 spec's Keycloak section gets one paragraph pointing at the RBAC spec's role-map contract.
- [ ] **Step 3**: Smoke: `make dev-keycloak-down && make dev-keycloak` (container recreation re-imports the realm ONLY when the realm doesn't exist — `docker compose --profile keycloak down` then up recreates; verify with `curl -s http://localhost:8081/realms/valet/.well-known/openid-configuration | head -c 100`). Verify roles exist via admin API (admin/admin token → `GET /admin/realms/valet/roles`).
- [ ] **Step 4**: Commit `chore(dev): keycloak realm roles for rbac mapping`.

---

### Task 7: Web — permission-driven settings UI

**Files:**
- Modify: `packages/web/src/api/settings.ts` (types flow from wire automatically; check for local copies)
- Modify: `packages/web/src/components/settings/settings-rail.tsx:42`
- Modify: `packages/web/src/routes/settings.organization.tsx:35` (+ sibling org pages' guards — grep `callerRole` under routes/)
- Modify: `packages/web/src/routes/settings.organization.members.tsx` (role picker + badges)
- Tests: extend the settings/org web test files (grep `-settings` / `callerRole` under `packages/web/src` for the existing suites)

**Interfaces:**
- Consumes: `GetOrgResponse.permissions` (Task 3), `callerRole: "admin" | "operator" | "member"`.

- [ ] **Step 1: Write failing tests** (match existing web test idioms — mocked `~/api/settings` returning org data):
  - operator fixture (`permissions: ["providers:manage", "infra:manage", "credentials:org"]`): rail shows Providers/Models/GitHub/Images/Prebuilds entries but NOT Members/Invites/General; member fixture (empty permissions): no org group at all; admin: everything.
  - members page: role select offers Admin/Operator/Member; a member row with role operator renders an "operator" badge.
- [ ] **Step 2**: Run → FAIL. **Step 3**: Implement:
  - `settings-rail.tsx`: replace `callerRole === "admin"` with permission checks per entry — map each org rail item to its permission (`General → org:manage`, `Members/Invites → members:manage`, `Providers/Models → providers:manage`, `GitHub/Images/Prebuilds → infra:manage`); show the group when any permission present. Keep the `features.organizations` gating exactly as-is for the member-management entries (spec: feature gate unchanged).
  - org route guards: block on the specific permission the page needs instead of `callerRole !== "admin"`.
  - members page: role `<select>`/picker gains `operator`; badge rendering handles the third value.
- [ ] **Step 4**: `source ~/.nvm/nvm.sh && nvm use 22 && pnpm --filter @valet/web test && pnpm --filter @valet/web typecheck` → PASS (fix fixture fallout from the widened `callerRole` type + new required `permissions` field across ALL web test fixtures — the compile errors are the checklist).
- [ ] **Step 5**: Commit `feat(web): permission-driven org settings surfaces`.

---

### Task 8: Sweep, spec status, PR

- [ ] **Step 1**: Full battery: `pnpm typecheck` (root; the known pre-existing undici-types failure is not ours), `pnpm --filter @valet/engine test`, `pnpm --filter @valet/api test`, `pnpm --filter @valet/web test`. All green or pre-existing-only failures.
- [ ] **Step 2**: `rm -rf ~/.valet/pg && make dev-local` smoke: stub identity still full-access; `/api/org` returns permissions.
- [ ] **Step 3**: Update `docs/specs/2026-07-21-rbac-permissions-design.md` → `Status: implemented (this branch)` + Deviations section for anything discovered; cross-link from auth-v2 spec if not already done in Task 6.
- [ ] **Step 4**: Commit docs; push; `gh pr create --base dev-v2 --title "v2: RBAC — fixed roles + permissions layer"` with body covering: three roles, permission vocabulary (OAuth-scope-shaped, binding), the org-credentials divergence bug fix, IdP role map + every-login sync, schema enum widening (`rm -rf ~/.valet/pg` locally), owed live Keycloak pass (alice=valet-admin sees all, bob=valet-operator sees Providers-not-Members, role flip in Keycloak takes effect on re-login). Do NOT merge.
