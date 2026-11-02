/**
 * First-admin bootstrap for a deployment with no users.
 *
 * A fresh deployment must not make whoever signs up first an admin: on a
 * reachable host, that is anyone who finds the sign-up page first. Instead,
 * on each boot with no users, the api mints a one-time admin invite and
 * prints its sign-up link only to the server log, which only the operator
 * can read. An operator who declares admins in the instance config
 * (`org.members` with `role: admin`) gets email invites from the config
 * reconciler instead, and no code is minted.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { invites, users } from "../schema/index.js";
import { createInvite, revokeInvite } from "./invites.js";

/** `invites.created_by` of a bootstrap invite. Config invites use "config". */
export const BOOTSTRAP_INVITE_CREATOR = "bootstrap";

/** A bootstrap link stays valid for a day; a restart mints a new one sooner. */
const BOOTSTRAP_INVITE_TTL_MS = 24 * 3600_000;

/**
 * Mints the one-time admin invite when the deployment has no users and no
 * pending admin invite from the config, and returns its sign-up link.
 * Returns null otherwise. Earlier bootstrap invites are deleted first: their
 * codes were printed once and cannot be printed again.
 */
export async function ensureBootstrapAdminInvite(
  db: AppDb,
  opts: { publicUrl?: string; log: (line: string) => void },
): Promise<string | null> {
  const stale = await db.select({ id: invites.id }).from(invites)
    .where(and(eq(invites.createdBy, BOOTSTRAP_INVITE_CREATOR), isNull(invites.acceptedBy)));
  for (const { id } of stale) await revokeInvite(db, id);

  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser) return null;
  const [configAdmin] = await db.select({ id: invites.id }).from(invites).where(and(
    eq(invites.role, "admin"), isNull(invites.acceptedBy), gt(invites.expiresAt, new Date())));
  if (configAdmin) return null;

  const { code } = await createInvite(db, { role: "admin", createdBy: BOOTSTRAP_INVITE_CREATOR, ttlMs: BOOTSTRAP_INVITE_TTL_MS });
  const link = `${opts.publicUrl?.replace(/\/+$/, "") ?? ""}/signup?invite=${code}`;
  opts.log(
    `No users yet. To create the first admin, open ${link} within 24 hours. ` +
    `This link is printed only here, works once, and changes on every restart until someone uses it. ` +
    `To name admins instead, set org.members with role: admin in the instance config.`,
  );
  return link;
}
