/**
 * How a deployment gets its first admin, decided at boot (real auth only).
 *
 * The first person to sign up is never an admin for being first: on a
 * reachable host that is anyone. Admins come from:
 *   1. `AUTH_ADMIN_EMAILS` (`AuthConfig.adminEmails`): each becomes an admin
 *      on SSO sign-in, or on Google/GitHub sign-in with a verified email
 *      (`provisioning.ts`). An existing user with a verified identity is
 *      promoted here at boot.
 *   2. Config-declared admins (`org.members` with `role: admin`), which the
 *      config reconciler turns into email invites.
 *   3. While no admin exists and SSO is off, a one-time admin invite whose
 *      sign-up link is printed to the server log only.
 *
 * With SSO on and no admin, an operator who declared nobody would have no
 * way in, so boot stops with the corrective action instead.
 */
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { account, invites, orgMembers, users } from "../schema/index.js";
import { findOrg, setOrgMemberRole } from "../services/org.js";
import type { AuthConfig } from "./config.js";
import { createInvite, revokeInvite } from "./invites.js";

/** `invites.created_by` of a bootstrap invite. Config invites use "config". */
export const BOOTSTRAP_INVITE_CREATOR = "bootstrap";

/** A bootstrap link stays valid for a day; a restart mints a new one sooner. */
const BOOTSTRAP_INVITE_TTL_MS = 24 * 3600_000;

/** Boot stops with this message: the deployment has no way to get an admin. */
export class AdminBootstrapError extends Error {}

interface BootLog {
  publicUrl?: string;
  log: (line: string) => void;
}

/** The boot step. Throws `AdminBootstrapError` when no admin could ever sign in. */
export async function ensureAdminAccess(db: AppDb, cfg: AuthConfig, opts: BootLog): Promise<void> {
  await promoteAdminEmails(db, cfg, opts.log);
  const [admin] = await db.select({ userId: orgMembers.userId }).from(orgMembers).where(eq(orgMembers.role, "admin")).limit(1);
  if (admin) {
    await deleteBootstrapInvites(db);
    return;
  }
  if (cfg.oidc) {
    await deleteBootstrapInvites(db);
    const declared = [...new Set([...(cfg.adminEmails ?? []), ...(await configAdminEmails(db))])];
    if (declared.length === 0) {
      throw new AdminBootstrapError(
        "No administrator can sign in: SSO is configured (AUTH_OIDC_ISSUER) and this deployment has no admin. " +
        "Set AUTH_ADMIN_EMAILS to the email of at least one administrator, then restart the api.",
      );
    }
    opts.log(`No admin yet. ${declared.join(", ")} become admin on their first ${cfg.oidc.name} sign-in.`);
    return;
  }
  await ensureBootstrapAdminInvite(db, opts);
}

/**
 * Mints the one-time admin invite, prints its sign-up link, and returns it.
 * Earlier unused bootstrap invites are deleted first: their codes were
 * printed once and cannot be printed again. The caller checks that no
 * admin exists.
 */
export async function ensureBootstrapAdminInvite(db: AppDb, opts: BootLog): Promise<string> {
  await deleteBootstrapInvites(db);
  const { code } = await createInvite(db, { role: "admin", createdBy: BOOTSTRAP_INVITE_CREATOR, ttlMs: BOOTSTRAP_INVITE_TTL_MS });
  const link = `${opts.publicUrl?.replace(/\/+$/, "") ?? ""}/signup?invite=${code}`;
  opts.log(
    `No admin yet. To create the first admin, open ${link} within 24 hours. ` +
    `This link is printed only here, works once, and changes on every restart until an admin exists. ` +
    `To name admins instead, set AUTH_ADMIN_EMAILS: they become admin when they sign in with SSO, Google, or GitHub.`,
  );
  return link;
}

async function deleteBootstrapInvites(db: AppDb): Promise<void> {
  const stale = await db.select({ id: invites.id }).from(invites)
    .where(and(eq(invites.createdBy, BOOTSTRAP_INVITE_CREATOR), isNull(invites.acceptedBy)));
  for (const { id } of stale) await revokeInvite(db, id);
}

/** Emails of pending admin invites that name a person (config-declared admins). */
async function configAdminEmails(db: AppDb): Promise<string[]> {
  const rows = await db.select({ email: invites.email }).from(invites).where(and(
    eq(invites.role, "admin"), isNotNull(invites.email), isNull(invites.acceptedBy), gt(invites.expiresAt, new Date())));
  return rows.flatMap(({ email }) => email ? [email.toLowerCase()] : []);
}

/**
 * Makes each existing `AUTH_ADMIN_EMAILS` user an org admin, when an identity
 * provider has vouched for the email: a verified email, or a linked SSO,
 * Google, or GitHub account. A password-only account with an unverified
 * email is skipped with a log line, because anyone could have registered it.
 */
async function promoteAdminEmails(db: AppDb, cfg: AuthConfig, log: (line: string) => void): Promise<void> {
  const emails = cfg.adminEmails ?? [];
  const org = emails.length ? await findOrg(db) : undefined;
  if (!org) return;
  for (const email of emails) {
    const [user] = await db.select({ id: users.id, emailVerified: users.emailVerified }).from(users)
      .where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (!user) continue;
    const [member] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id))).limit(1);
    if (member?.role === "admin") continue;
    const [linked] = await db.select({ id: account.id }).from(account)
      .where(and(eq(account.userId, user.id), ne(account.providerId, "credential"))).limit(1);
    if (!user.emailVerified && !linked) {
      log(
        `AUTH_ADMIN_EMAILS lists ${email}, but that account signed up with a password and its email is not verified, ` +
        `so it was not made admin. Sign in once with SSO, Google, or GitHub, or ask an admin to promote it in Settings.`,
      );
      continue;
    }
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    if (member) await setOrgMemberRole(db, org.id, user.id, "admin");
    else await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "admin", createdAt: Date.now() }).onConflictDoNothing();
    log(`Made ${email} an org admin (AUTH_ADMIN_EMAILS).`);
  }
}
