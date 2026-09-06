/**
 * Shared org-admin gate (GitHub/repo integration plan, Task 5). Extracted
 * from the identical `requireOrgAdmin` copies in `routes/llm-providers.ts`
 * and `routes/org-invites.ts` — same DB-backed check against
 * `org_members.role` (NOT `users.role`, the global operator flag).
 * `routes/credentials.ts` and `routes/onepassword.ts` import this helper
 * for org-scoped writes. New admin-gated routers should import this
 * instead of adding another copy; the two pre-existing local copies are
 * left as-is.
 */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { isOrgAdmin } from "../services/org.js";
import { requirePrincipal } from "../middleware/auth.js";

/** Returns a 403 `Response` when the caller isn't an admin of their own
 * org; `undefined` otherwise. Callers do:
 * `const gate = await requireOrgAdmin(c); if (gate) return gate;` */
export async function requireOrgAdmin(c: Context<AppEnv>) {
  if (requirePrincipal(c)?.type === "team") {
    return c.json(
      { error: "A team API key cannot change organization settings. Sign in as an organization admin." },
      403,
    );
  }
  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}

/**
 * Boolean-returning variant of the same check, for a caller that needs the
 * admin flag itself rather than a 403 (e.g. `assertModelSelectable`'s
 * admin-bypass parameter). Reuses `isOrgAdmin` so the two never drift.
 */
export async function isOrgAdminUser(c: Context<AppEnv>): Promise<boolean> {
  if (requirePrincipal(c)?.type === "team") return false;
  const { db } = c.var.providers;
  const user = c.var.user;
  return isOrgAdmin(db, user.orgId, user.id);
}
