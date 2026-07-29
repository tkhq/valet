import type { Context, MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { orgMembers, users } from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";
import type { AppEnv } from "../env.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { resolveOrgId } from "../lib/org.js";
import type { ValetAuth } from "../auth/index.js";
import { verifySandboxToken } from "../auth/sandbox-tokens.js";
import {
  effectiveApiKeyPermissions,
  isOrgRole,
  permissionsForOrgRole,
  type OrgRole,
  type Permission,
} from "../auth/permissions.js";

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

/** Route prefixes that consume `c.var.sandbox` today. Must match the mount
 * points in `app.ts` — see rung 2 of the ladder below:
 *   - `/api/memory` — owner-tuple OKF memory surface (decision 15).
 *   - `/api/sandbox` — in-sandbox git credential surface (GitHub/repo
 *     integration plan, Task 8).
 * A valid sandbox token against any other path 403s rather than reaching a
 * handler that unconditionally reads `c.var.user`. */
const SANDBOX_ALLOWED_PATH_PREFIXES = ["/api/memory", "/api/sandbox"];

/** Narrows better-auth's loosely-typed (`type: "string"`) `role`
 * additional field down to our real enum. The db column is declared
 * `enum: ["admin", "member"]` so this should always take the first branch;
 * the fallback exists only so a malformed/legacy row can't produce a value
 * outside `AuthUser["role"]`'s type. */
function normalizeRole(role: string): "admin" | "member" {
  return role === "admin" ? "admin" : "member";
}

/** Reads an api-key row's optional `scopes` (a string[] under `metadata.scopes`)
 * into a plain array the scope-intersection helper can consume. Any other
 * shape (non-array, non-string entries) collapses to `null` — treated as
 * "no scopes declared, use the owner's full bundle." Isolated here so the
 * auth middleware doesn't do its own JSON walking. */
export function extractApiKeyScopes(metadata: Record<string, unknown> | null | undefined): readonly string[] | null {
  if (!metadata) return null;
  const raw = metadata.scopes;
  if (!Array.isArray(raw)) return null;
  const scopes = raw.filter((v): v is string => typeof v === "string");
  return scopes.length > 0 ? scopes : null;
}

/** Org role from org_members.role — "member" when no membership row exists
 * (defensive: a session for a user whose membership was removed must not
 * gain permissions). */
export async function resolveOrgRole(db: AppDb, orgId: string, userId: string): Promise<OrgRole> {
  const rows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  const role = rows[0]?.role;
  return isOrgRole(role) ? role : "member";
}

/**
 * Guards a route body that reads `c.var.user`. `AppVariables.user` is typed
 * as always-present (`AuthUser`, not `AuthUser | undefined`) so the ~50
 * existing call sites across routers don't all need an existence check —
 * but the auth ladder below only actually sets it on the session/api-key/
 * stub rungs, never on the internal-token or sandbox rungs. This reads the
 * variable through its true runtime type and returns `undefined` instead of
 * letting an unguarded `c.var.user.id` throw a raw `TypeError` into the
 * global 500 handler when a sandbox-only (or internal-token) request hits a
 * user-scoped route.
 */
export function requireUser(c: Context<AppEnv>): AuthUser | undefined {
  // Bridging Hono's context typing gap described above — see doc comment.
  return c.var.user as AuthUser | undefined;
}

export interface BuildAuthMiddlewareOpts {
  /** The real better-auth instance, or `null` when `BETTER_AUTH_SECRET`
   * isn't configured (stub-only mode). */
  auth: ValetAuth | null;
  db: AppDb;
}

/**
 * Auth middleware ladder (auth-v2 design). First match wins:
 *
 *   1. `x-valet-internal` valid → `next()`, no `c.var.user`/`c.var.sandbox`.
 *   2. `x-valet-sandbox` present → `verifySandboxToken`; invalid 401s even
 *      in stub mode — an explicit credential beats every fallback below it.
 *      Valid tokens only set `c.var.sandbox` and `next()` when the path
 *      starts with one of `SANDBOX_ALLOWED_PATH_PREFIXES` (memory routes and
 *      the Task 8 git-credential route — the only consumers of
 *      `c.var.sandbox`); every other path 403s instead of falling through,
 *      so a valid sandbox token against e.g. `/api/me` never reaches a
 *      handler that unconditionally reads `c.var.user`.
 *   3. `auth` configured and a valid session (cookie or session header)
 *      resolves → `c.var.user`.
 *   4. `auth` configured and `x-api-key` present → `verifyApiKey`; invalid
 *      401s (same "explicit credential beats fallback" rule as #2).
 *   5. `VALET_LOCAL_AUTH=1` → stub identity (+ `VALET_TEST_AUTH_HEADER`
 *      impersonation), verbatim from the pre-ladder implementation.
 *   6. 401 `{ error: "unauthorized" }`.
 *
 * Test-only escape hatch: an `x-valet-test-user-id` header (rung 5) swaps
 * the identity to any user row already seeded in the app db (looked up by
 * id), so integration tests can exercise role-gated routes (e.g. admin-only)
 * without a real auth provider. Ignored silently if the id doesn't resolve
 * to a row. Gated behind `VALET_TEST_AUTH_HEADER=1`, separate from
 * `VALET_LOCAL_AUTH`, so flipping on stub auth alone never also grants
 * any-user impersonation. Only the API test bootstrap sets this var; it
 * must never be added to the Makefile, `.env`, or any dev target.
 *
 * Internal-token bypass (decision 15): a request carrying a valid
 * `x-valet-internal` token (constant-time compared — see
 * `lib/internal-auth.ts`) skips every rung below it and falls straight
 * through to the route without `c.var.user`/`c.var.sandbox` set — only the
 * memory routes accept this header this phase, and they derive their owner
 * tuple from `x-valet-owner`/`x-valet-actor` headers instead.
 */
export function buildAuthMiddleware(opts: BuildAuthMiddlewareOpts): MiddlewareHandler<AppEnv> {
  const { auth, db } = opts;

  return async (c, next) => {
    // 1. Internal token — unconditional bypass.
    if (isValidInternalToken(c.req.header("x-valet-internal"))) {
      await next();
      return;
    }

    // 2. Sandbox token — explicit credential, invalid always 401s. Valid
    // sandbox principals are only accepted on the allow-listed prefixes
    // (memory + git-credential routes) — every other route reads
    // `c.var.user`, not `c.var.sandbox`, so letting a sandbox token through
    // elsewhere would crash the route handler with an unguarded TypeError
    // instead of failing cleanly here.
    const sandboxHeader = c.req.header("x-valet-sandbox");
    if (sandboxHeader !== undefined) {
      const principal = await verifySandboxToken(db, sandboxHeader);
      if (!principal) {
        return c.json({ error: "invalid sandbox token" }, 401);
      }
      if (!SANDBOX_ALLOWED_PATH_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
        return c.json({ error: "sandbox token not accepted here" }, 403);
      }
      c.set("sandbox", principal);
      await next();
      return;
    }

    if (auth) {
      // 3. Session (cookie or session header). A malformed/oversized cookie
      // must fall through to the next rung, not 500 — better-auth doesn't
      // guarantee it returns null instead of throwing on garbage input.
      let sessionResult: Awaited<ReturnType<ValetAuth["api"]["getSession"]>> = null;
      try {
        sessionResult = await auth.api.getSession({ headers: c.req.raw.headers });
      } catch {
        sessionResult = null;
      }
      if (sessionResult) {
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
        await next();
        return;
      }

      // 4. API key — explicit credential, invalid always 401s. A
      // malformed/oversized key must 401 cleanly rather than 500 — same
      // "don't trust the auth provider not to throw" rule as rung 3.
      const apiKeyHeader = c.req.header("x-api-key");
      if (apiKeyHeader) {
        let result: Awaited<ReturnType<ValetAuth["api"]["verifyApiKey"]>>;
        try {
          result = await auth.api.verifyApiKey({ body: { key: apiKeyHeader } });
        } catch {
          return c.json({ error: "invalid api key" }, 401);
        }
        if (!result.valid || !result.key) {
          return c.json({ error: "invalid api key" }, 401);
        }
        const apiKeyRows = await db.select().from(users).where(eq(users.id, result.key.referenceId)).limit(1);
        const row = apiKeyRows[0];
        if (!row) {
          return c.json({ error: "invalid api key" }, 401);
        }
        const orgId = await resolveOrgId(db);
        const orgRole = await resolveOrgRole(db, orgId, row.id);
        // RBAC design's binding compatibility rule: a scoped API key gets
        // the intersection of its owner's bundle and its declared scopes.
        // No scopes column exists on the api-key row yet, so today the
        // scopes list is always the optional `metadata.scopes` array —
        // when creation UI arrives it'll populate this field. Unset =
        // owner's full bundle (back-compat with every existing key).
        const scopes = extractApiKeyScopes(result.key.metadata);
        c.set("user", {
          id: row.id,
          email: row.email,
          name: row.name ?? undefined,
          role: row.role,
          orgRole,
          permissions: effectiveApiKeyPermissions(permissionsForOrgRole(orgRole), scopes),
          orgId,
        } satisfies AuthUser);
        await next();
        return;
      }
    }

    // 5. Stub auth.
    if (process.env.VALET_LOCAL_AUTH === "1") {
      const testUserId = process.env.VALET_TEST_AUTH_HEADER === "1" ? c.req.header("x-valet-test-user-id") : undefined;
      if (testUserId) {
        const testRows = await db.select().from(users).where(eq(users.id, testUserId)).limit(1);
        const row = testRows[0];
        if (row) {
          const orgRole = await resolveOrgRole(db, LOCAL_ORG.id, row.id);
          c.set("user", {
            id: row.id,
            email: row.email,
            name: row.name ?? undefined,
            role: row.role,
            orgRole,
            permissions: permissionsForOrgRole(orgRole),
            orgId: LOCAL_ORG.id,
          } satisfies AuthUser);
          await next();
          return;
        }
      }

      // Stub identity keeps full org access in dev (per RBAC design).
      c.set("user", {
        id: LOCAL_USER.id,
        email: LOCAL_USER.email,
        name: LOCAL_USER.name,
        role: LOCAL_USER.role,
        orgRole: "admin",
        permissions: permissionsForOrgRole("admin"),
        orgId: LOCAL_ORG.id,
      } satisfies AuthUser);
      await next();
      return;
    }

    // 6. Nothing matched.
    return c.json({ error: "unauthorized" }, 401);
  };
}
