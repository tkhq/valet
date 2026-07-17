/**
 * Shared org-admin gate (GitHub/repo integration plan, Task 5). Extracted
 * from the identical `requireOrgAdmin` copies in `routes/llm-providers.ts`
 * and `routes/org-invites.ts` — same DB-backed check against
 * `org_members.role` (NOT the JWT-role variant `routes/credentials.ts`
 * uses). New admin-gated routers should import this instead of adding a
 * fourth copy; the two pre-existing copies are left as-is (not worth the
 * churn of retrofitting routes that already work).
 */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { isOrgAdmin } from "../services/org.js";

/** Returns a 403 `Response` when the caller isn't an admin of their own
 * org; `undefined` otherwise. Callers do:
 * `const gate = await requireOrgAdmin(c); if (gate) return gate;` */
export async function requireOrgAdmin(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}
