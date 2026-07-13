import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";
import { users } from "../schema/index.js";
import type { AppEnv } from "../env.js";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  orgId: string;
}

/**
 * Auth is intentionally stub-only in this package. Real OAuth lives in the
 * legacy worker; here, requests run as a single hardcoded local user by
 * default.
 *
 * Test-only escape hatch: an `x-valet-test-user-id` header swaps the identity
 * to any user row already seeded in the app db (looked up by id), so
 * integration tests can exercise role-gated routes (e.g. admin-only) without
 * a real auth provider. Ignored silently if the id doesn't resolve to a row.
 *
 * Set `VALET_LOCAL_AUTH=1` to opt in. Without it, every `/api/*` request 401s.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (process.env.VALET_LOCAL_AUTH !== "1") {
    return c.json({ error: "auth not configured (set VALET_LOCAL_AUTH=1)" }, 401);
  }

  const testUserId = c.req.header("x-valet-test-user-id");
  if (testUserId) {
    const row = await c.var.providers.db.select().from(users).where(eq(users.id, testUserId)).get();
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
};
