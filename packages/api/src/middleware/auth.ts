import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { users } from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";
import type { AppEnv } from "../env.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { resolveOrgId } from "../lib/org.js";
import type { ValetAuth } from "../auth/index.js";
import { verifySandboxToken } from "../auth/sandbox-tokens.js";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  orgId: string;
}

/** Route prefixes that consume `c.var.sandbox` today. Must match the mount
 * points in `app.ts` — see rung 2 of the ladder below:
 *   - `/api/memory` — owner-tuple OKF memory surface (decision 15).
 *   - `/api/sandbox/` — in-sandbox git credential surface (GitHub/repo
 *     integration plan, Task 8).
 *   - `/api/sandbox-secrets/` — the secret broker `valet-secrets` calls.
 * Each prefix ends at a path separator so one mount cannot match another's
 * name. A valid sandbox token against any other path 403s rather than
 * reaching a handler that reads `c.var.user`. */
const SANDBOX_ALLOWED_PATH_PREFIXES = ["/api/memory", "/api/sandbox/", "/api/sandbox-secrets/"];

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
 * The AuthUser for a resolved better-auth session, or `undefined` when
 * none resolves. The try/catch is the "don't trust the auth provider not
 * to throw" rule — a malformed/oversized cookie must read as no-session,
 * not a 500. Shared by rung 3 of the ladder and `resolveOptionalUser`.
 */
async function userFromSession(auth: ValetAuth, db: AppDb, headers: Headers): Promise<AuthUser | undefined> {
  let sessionResult: Awaited<ReturnType<ValetAuth["api"]["getSession"]>> = null;
  try {
    sessionResult = await auth.api.getSession({ headers });
  } catch {
    sessionResult = null;
  }
  if (!sessionResult) return undefined;
  return {
    id: sessionResult.user.id,
    email: sessionResult.user.email,
    name: sessionResult.user.name,
    role: normalizeRole(sessionResult.user.role),
    orgId: await resolveOrgId(db),
  };
}

/** The AuthUser behind a valid api key, or `undefined` for an invalid,
 * malformed, or dangling one. Shared by rung 4 and `resolveOptionalUser`. */
async function userFromApiKey(auth: ValetAuth, db: AppDb, key: string): Promise<AuthUser | undefined> {
  let result: Awaited<ReturnType<ValetAuth["api"]["verifyApiKey"]>>;
  try {
    result = await auth.api.verifyApiKey({ body: { key } });
  } catch {
    return undefined;
  }
  if (!result.valid || !result.key) return undefined;
  const rows = await db.select().from(users).where(eq(users.id, result.key.referenceId)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
    role: row.role,
    orgId: await resolveOrgId(db),
  };
}

/** The seeded local-dev identity (an admin) — rung 5's stub default. */
function stubUser(): AuthUser {
  return {
    id: LOCAL_USER.id,
    email: LOCAL_USER.email,
    name: LOCAL_USER.name,
    role: LOCAL_USER.role,
    orgId: LOCAL_ORG.id,
  };
}

/**
 * Best-effort caller identity for routes mounted BEFORE the auth
 * middleware that still want to know who is asking (today: the public
 * artifact read, whose `org` visibility serves logged-in org members and
 * 401s everyone else). Resolves through the same identity builders the
 * ladder below uses (session, api key, stub), but never writes a
 * response: `undefined` means anonymous, and the route decides what that
 * means. Deliberately narrower than the middleware — no internal-token or
 * sandbox rungs, because those principals carry no user identity.
 */
export async function resolveOptionalUser(
  c: Context<AppEnv>,
  opts: BuildAuthMiddlewareOpts,
): Promise<AuthUser | undefined> {
  const { auth, db } = opts;
  if (auth) {
    const sessionUser = await userFromSession(auth, db, c.req.raw.headers);
    if (sessionUser) return sessionUser;
    const apiKeyHeader = c.req.header("x-api-key");
    if (apiKeyHeader) return userFromApiKey(auth, db, apiKeyHeader);
    return undefined;
  }

  // Stub identity — same gate as rung 5: only when NO real auth instance
  // exists. Anonymous access is untestable through HTTP in stub mode (the
  // stub answers for everyone); the artifact access matrix covers it in
  // unit tests instead (`services/artifacts.ts`'s `decideArtifactAccess`).
  if (process.env.VALET_LOCAL_AUTH === "1") return stubUser();

  return undefined;
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
 *   5. No `auth` instance AND `VALET_LOCAL_AUTH=1` → stub identity (+
 *      `VALET_TEST_AUTH_HEADER` impersonation). The stub and real auth are
 *      mutually exclusive: the stub identity is a seeded ADMIN, so a stub
 *      rung that fired next to a real auth instance would answer every
 *      credential-less request with admin access instead of 401. `main.ts`
 *      refuses to boot that pair; this rung's `auth` check keeps the
 *      escalation impossible for every other caller of the factory.
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
      // must fall through to the next rung, not 500 — `userFromSession`
      // absorbs the throw.
      const sessionUser = await userFromSession(auth, db, c.req.raw.headers);
      if (sessionUser) {
        c.set("user", sessionUser);
        await next();
        return;
      }

      // 4. API key — explicit credential, invalid always 401s (malformed,
      // unverified, and dangling keys all resolve to `undefined`).
      const apiKeyHeader = c.req.header("x-api-key");
      if (apiKeyHeader) {
        const apiKeyUser = await userFromApiKey(auth, db, apiKeyHeader);
        if (!apiKeyUser) {
          return c.json({ error: "invalid api key" }, 401);
        }
        c.set("user", apiKeyUser);
        await next();
        return;
      }
    }

    // 5. Stub auth. Gated on the ABSENCE of a real auth instance, not on the
    // env var alone: `LOCAL_USER` is an admin, so a stub rung that stayed
    // live under real auth would grant admin to any credential-less request.
    if (!auth && process.env.VALET_LOCAL_AUTH === "1") {
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

      c.set("user", stubUser());
      await next();
      return;
    }

    // 6. Nothing matched.
    return c.json({ error: "unauthorized" }, 401);
  };
}
