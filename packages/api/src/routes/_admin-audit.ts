/**
 * Route-side wrapper for `services/admin-audit.ts`: fills the actor, org,
 * request IP, and user agent from the Hono context, so each mutation passes
 * only what changed.
 *
 * The IP is the socket peer address. `x-forwarded-for` is client-supplied,
 * so it is used only when `VALET_TRUST_PROXY=1` says a proxy that rewrites
 * it fronts this process (the same rule as `routes/artifacts.ts`).
 */
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { recordAdminAudit, type AdminAuditActor, type AdminAuditEntry } from "../services/admin-audit.js";
import { peerAddress } from "./cli-device.js";

export function requestIp(c: Context<AppEnv>): string | null {
  if (process.env.VALET_TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return peerAddress(c) ?? null;
}

export function requestActor(c: Context<AppEnv>): AdminAuditActor {
  const user = c.var.user;
  return {
    userId: user.id,
    email: user.email,
    ip: requestIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/** Records one audit row for the signed-in caller's org. Never throws. */
export async function auditRequest(
  c: Context<AppEnv>,
  entry: Omit<AdminAuditEntry, "orgId" | "actor">,
): Promise<void> {
  await recordAdminAudit(c.var.providers.db, { ...entry, orgId: c.var.user.orgId, actor: requestActor(c) });
}
