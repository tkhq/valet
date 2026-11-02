import type { AppDb } from "../lib/drizzle.js";
import { ensureBootstrapAdminInvite } from "../auth/bootstrap-admin.js";

/**
 * The invite code a fresh deployment's operator reads from the boot log
 * (`auth/bootstrap-admin.ts`). Pass it as `inviteCode` to the first
 * `/sign-up/email` call to create the first admin.
 */
export async function bootstrapAdminInviteCode(db: AppDb): Promise<string> {
  const link = await ensureBootstrapAdminInvite(db, { log: () => {} });
  const code = link ? new URL(link, "http://valet.test").searchParams.get("invite") : null;
  if (!code) throw new Error("expected a bootstrap admin invite on a deployment with no users");
  return code;
}
