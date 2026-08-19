import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { identityLinkCodes, userIdentityLinks } from "../schema/index.js";

/** Enforced link-code lifetime. The single source: the routes derive the
 * advertised `expiresInSeconds` from it, and the Slack plugin's DM copy is
 * asserted against it in identity-links.test.ts. */
export const CODE_TTL_MS = 10 * 60_000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function uid(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

export async function mintLinkCode(
  db: AppDb,
  userId: string,
  provider: string,
  now = Date.now(),
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
  });
  return code;
}

export async function consumeLinkCode(
  db: AppDb,
  provider: string,
  code: string,
  now = Date.now(),
): Promise<{ userId: string } | null> {
  const rows = await db
    .delete(identityLinkCodes)
    .where(
      and(eq(identityLinkCodes.provider, provider), eq(identityLinkCodes.codeHash, hashCode(code))),
    )
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt < now) return null;
  return { userId: row.userId };
}

/** Opportunistic GC — callers may invoke on mint; not required for correctness. */
export async function pruneExpiredLinkCodes(db: AppDb, now = Date.now()): Promise<void> {
  await db.delete(identityLinkCodes).where(lt(identityLinkCodes.expiresAt, now));
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
