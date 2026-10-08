import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { identityLinkCodes, userIdentityLinks } from "../schema/index.js";

/** Enforced link-code lifetime. The single source: the routes derive the
 * advertised `expiresInSeconds` from it, and the Slack plugin's DM copy is
 * asserted against it in identity-links.test.ts. */
export const CODE_TTL_MS = 10 * 60_000;

/** The exact shape `mintLinkCode` returns: 16 random bytes as base64url.
 * The channel host uses it to recognize a link code that a person pasted
 * without the provider's command, such as Slack's `link`. */
export const LINK_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function uid(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

/** One pending code per user and provider: a new mint replaces the last. */
async function insertLinkCode(
  db: AppDb,
  userId: string,
  provider: string,
  externalId: string | null,
  now: number,
): Promise<string> {
  const code = randomBytes(16).toString("base64url");
  await db
    .delete(identityLinkCodes)
    .where(and(eq(identityLinkCodes.userId, userId), eq(identityLinkCodes.provider, provider)));
  await db.insert(identityLinkCodes).values({
    id: uid("ilc"),
    userId,
    provider,
    codeHash: hashCode(code),
    expiresAt: now + CODE_TTL_MS,
    createdAt: now,
    externalId,
  });
  return code;
}

/** A code the web app shows. The person sends it to the bot from the
 * provider account to link (`link <code>`, Telegram `/start <code>`). */
export async function mintLinkCode(
  db: AppDb,
  userId: string,
  provider: string,
  now = Date.now(),
): Promise<string> {
  return insertLinkCode(db, userId, provider, null, now);
}

/** A code the bot DMs to one provider account ("DM me", "Find me by name").
 * Reading the DM proves control of that account, and typing the code into
 * the signed-in web app proves the Valet user, so only
 * `consumeDeliveredLinkCode` redeems it. */
export async function mintDeliveredLinkCode(
  db: AppDb,
  userId: string,
  provider: string,
  externalId: string,
  now = Date.now(),
): Promise<string> {
  return insertLinkCode(db, userId, provider, externalId, now);
}

/**
 * Redeems a shown code sent from the provider. A delivered code never
 * redeems here: the person it was DMed to holds it, and a reply from their
 * account would link THEIR account to the requester's Valet user.
 */
export async function consumeLinkCode(
  db: AppDb,
  provider: string,
  code: string,
  now = Date.now(),
): Promise<{ userId: string } | null> {
  const rows = await db
    .delete(identityLinkCodes)
    .where(
      and(
        eq(identityLinkCodes.provider, provider),
        eq(identityLinkCodes.codeHash, hashCode(code)),
        isNull(identityLinkCodes.externalId),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt < now) return null;
  return { userId: row.userId };
}

/** True when `code` is a live code the bot DMed (the "DM me" flow). Chat
 * never redeems one, but the host uses this to tell a person who pasted it
 * into the bot DM to enter it in Valet instead. Reads only. */
export async function isDeliveredLinkCode(
  db: AppDb,
  provider: string,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .select({ expiresAt: identityLinkCodes.expiresAt })
    .from(identityLinkCodes)
    .where(
      and(
        eq(identityLinkCodes.provider, provider),
        eq(identityLinkCodes.codeHash, hashCode(code)),
        isNotNull(identityLinkCodes.externalId),
      ),
    )
    .limit(1);
  return rows.length > 0 && (rows[0]?.expiresAt ?? 0) >= now;
}

/** Redeems a delivered code typed into the web app by the user who
 * requested it. Returns the provider account the code was DMed to. */
export async function consumeDeliveredLinkCode(
  db: AppDb,
  userId: string,
  provider: string,
  code: string,
  now = Date.now(),
): Promise<{ externalId: string } | null> {
  const rows = await db
    .delete(identityLinkCodes)
    .where(
      and(
        eq(identityLinkCodes.userId, userId),
        eq(identityLinkCodes.provider, provider),
        eq(identityLinkCodes.codeHash, hashCode(code)),
        isNotNull(identityLinkCodes.externalId),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row?.externalId || row.expiresAt < now) return null;
  return { externalId: row.externalId };
}

export async function linkIdentity(
  db: AppDb,
  args: { provider: string; externalId: string; userId: string; notifyAttention?: boolean },
  now = Date.now(),
): Promise<void> {
  await db.delete(userIdentityLinks).where(
    and(
      eq(userIdentityLinks.provider, args.provider),
      or(eq(userIdentityLinks.externalId, args.externalId), eq(userIdentityLinks.userId, args.userId)),
    ),
  );
  await db.insert(userIdentityLinks).values({
    id: uid("uil"),
    provider: args.provider,
    externalId: args.externalId,
    userId: args.userId,
    createdAt: now,
    notifyAttention: args.notifyAttention ?? true,
  });
}

export async function unlinkIdentity(db: AppDb, provider: string, userId: string): Promise<void> {
  await db
    .delete(userIdentityLinks)
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)));
}

export async function identityForExternal(
  db: AppDb,
  provider: string,
  externalId: string,
): Promise<{ userId: string; notifyAttention: boolean } | null> {
  const rows = await db
    .select()
    .from(userIdentityLinks)
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.externalId, externalId)));
  const row = rows[0];
  return row ? { userId: row.userId, notifyAttention: row.notifyAttention } : null;
}

export async function identityForUser(
  db: AppDb,
  provider: string,
  userId: string,
): Promise<{ externalId: string; notifyAttention: boolean; createdAt: number } | null> {
  const rows = await db
    .select()
    .from(userIdentityLinks)
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)));
  const row = rows[0];
  return row
    ? { externalId: row.externalId, notifyAttention: row.notifyAttention, createdAt: row.createdAt }
    : null;
}

/**
 * Merge the user's linked Slack id into a resolved slack credential's
 * metadata as `owner_slack_user_id` — the field plugin-slack's
 * private-channel guard and `slack.dm_owner` read. Both credential
 * resolution paths call this — the session resolver (`engine/host.ts`)
 * and the workflow action invoker (`plugins/action-invoker.ts`) — so the
 * enrichment semantics live in one place. No link → the credential is
 * returned unchanged and the plugin's guards fail closed.
 */
export async function withSlackOwnerMetadata<T extends { metadata?: Record<string, unknown> }>(
  db: AppDb,
  userId: string,
  credential: T,
): Promise<T> {
  const identity = await identityForUser(db, "slack", userId);
  if (!identity) return credential;
  return { ...credential, metadata: { ...credential.metadata, owner_slack_user_id: identity.externalId } };
}

export async function setNotifyAttention(
  db: AppDb,
  provider: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(userIdentityLinks)
    .set({ notifyAttention: enabled })
    .where(and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)));
}
