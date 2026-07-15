import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { users } from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";
import type { AppEnv } from "../env.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { ensureOrg } from "../services/org.js";
import type { ValetAuth } from "../auth/index.js";
import { verifySandboxToken } from "../auth/sandbox-tokens.js";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  orgId: string;
}

/**
 * Single-org id memo (auth-v2 design assumes exactly one org, same as
 * `services/org.ts`'s `ensureOrg`). Keyed by `AppDb` instance rather than a
 * bare module-level value — the API integration suite boots many independent
 * in-memory dbs in one process (`bootTestApi` per test), and a single shared
 * memo would leak the first test's org id into every later test's requests.
 * A `WeakMap` lets each db's entry be garbage-collected with it.
 */
const orgIdMemo = new WeakMap<AppDb, string>();

/** The only route prefix that consumes `c.var.sandbox` today. Must match
 * the mount point in `app.ts` (`app.route("/api/memory", memoryRouter)`) —
 * see rung 2 of the ladder below. */
const SANDBOX_ALLOWED_PATH_PREFIX = "/api/memory";

async function resolveOrgId(db: AppDb): Promise<string> {
  const cached = orgIdMemo.get(db);
  if (cached) return cached;
  const { id } = await ensureOrg(db);
  orgIdMemo.set(db, id);
  return id;
}

/** Narrows better-auth's loosely-typed (`type: "string"`) `role`
 * additional field down to our real enum. The db column is declared
 * `enum: ["admin", "member"]` so this should always take the first branch;
 * the fallback exists only so a malformed/legacy row can't produce a value
 * outside `AuthUser["role"]`'s type. */
function normalizeRole(role: string): "admin" | "member" {
  return role === "admin" ? "admin" : "member";
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
 *      starts with `SANDBOX_ALLOWED_PATH_PREFIX` (memory routes, the only
 *      consumer of `c.var.sandbox`); every other path 403s instead of
 *      falling through, so a valid sandbox token against e.g. `/api/me`
 *      never reaches a handler that unconditionally reads `c.var.user`.
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
    // sandbox principals are only accepted on the memory routes today —
    // every other route reads `c.var.user`, not `c.var.sandbox`, so letting
    // a sandbox token through elsewhere would crash the route handler with
    // an unguarded TypeError instead of failing cleanly here.
    const sandboxHeader = c.req.header("x-valet-sandbox");
    if (sandboxHeader !== undefined) {
      const principal = await verifySandboxToken(db, sandboxHeader);
      if (!principal) {
        return c.json({ error: "invalid sandbox token" }, 401);
      }
      if (!c.req.path.startsWith(SANDBOX_ALLOWED_PATH_PREFIX)) {
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
        c.set("user", {
          id: sessionResult.user.id,
          email: sessionResult.user.email,
          name: sessionResult.user.name,
          role: normalizeRole(sessionResult.user.role),
          orgId: await resolveOrgId(db),
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
        c.set("user", {
          id: row.id,
          email: row.email,
          name: row.name ?? undefined,
          role: row.role,
          orgId: await resolveOrgId(db),
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
          c.set("user", {
            id: row.id,
            email: row.email,
            name: row.name ?? undefined,
            role: row.role,
            orgId: LOCAL_ORG.id,
          } satisfies AuthUser);
          await next();
          return;
        }
      }

      c.set("user", {
        id: LOCAL_USER.id,
        email: LOCAL_USER.email,
        name: LOCAL_USER.name,
        role: LOCAL_USER.role,
        orgId: LOCAL_ORG.id,
      } satisfies AuthUser);
      await next();
      return;
    }

    // 6. Nothing matched.
    return c.json({ error: "unauthorized" }, 401);
  };
}
