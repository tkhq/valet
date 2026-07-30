/**
 * Shared permission gate (RBAC design; GitHub/repo integration plan, Task
 * 5). Every org surface's admin/operator gate now routes through
 * `requirePermission` — the DB-backed `requireOrgAdmin` this file used to
 * export was retired once its last caller migrated (gate-migration task).
 */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
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
