import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { channelMessageRefs, users, type ChannelMessageRefRow } from '../schema/index.js';

export interface ChannelMessageExternalIdentity {
  orgId: string;
  channelType: string;
  connectionScope: string;
  channelId: string;
  messageId: string;
}

export interface RegisterChannelMessageRefInput extends ChannelMessageExternalIdentity {
  ownerUserId: string | null;
  sessionId?: string | null;
  actionInvocationId?: string | null;
}

export interface ChannelMessageAuthorizationInput extends ChannelMessageExternalIdentity {
  actorUserId: string;
}

export type ChannelMessageRefErrorCode =
  | 'message_not_managed'
  | 'message_not_owned'
  | 'message_deleted'
  | 'message_owner_conflict';

/** A stable error for worker-owned channel-message authorization decisions. */
export class ChannelMessageRefError extends Error {
  constructor(public readonly code: ChannelMessageRefErrorCode) {
    super(code);
    this.name = 'ChannelMessageRefError';
  }
}

function externalIdentityWhere(identity: ChannelMessageExternalIdentity) {
  return and(
    eq(channelMessageRefs.orgId, identity.orgId),
    eq(channelMessageRefs.channelType, identity.channelType),
    eq(channelMessageRefs.connectionScope, identity.connectionScope),
    eq(channelMessageRefs.channelId, identity.channelId),
    eq(channelMessageRefs.messageId, identity.messageId),
  );
}

/** Look up one managed external message using its complete scoped identity. */
export async function getChannelMessageRef(
  db: AppDb,
  identity: ChannelMessageExternalIdentity,
): Promise<ChannelMessageRefRow | null> {
  return (await db
    .select()
    .from(channelMessageRefs)
    .where(externalIdentityWhere(identity))
    .get()) ?? null;
}

/**
 * Register an externally-created message without ever transferring ownership.
 * Repeated registration by the original owner is a no-op, including if its
 * original provenance has since been nulled by a foreign-key action.
 */
export async function registerChannelMessageRef(
  db: AppDb,
  input: RegisterChannelMessageRefInput,
): Promise<void> {
  await db
    .insert(channelMessageRefs)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      channelType: input.channelType,
      connectionScope: input.connectionScope,
      channelId: input.channelId,
      messageId: input.messageId,
      ownerUserId: input.ownerUserId,
      sessionId: input.sessionId ?? null,
      actionInvocationId: input.actionInvocationId ?? null,
    })
    .onConflictDoNothing({
      target: [
        channelMessageRefs.orgId,
        channelMessageRefs.channelType,
        channelMessageRefs.connectionScope,
        channelMessageRefs.channelId,
        channelMessageRefs.messageId,
      ],
    });

  const canonical = await getChannelMessageRef(db, input);
  if (!canonical || canonical.ownerUserId !== input.ownerUserId) {
    throw new ChannelMessageRefError('message_owner_conflict');
  }
}

/**
 * Require that the current actor owns the message or is currently an admin.
 * A non-owner receives `message_not_owned` before tombstone state is checked.
 */
export async function assertCanModifyChannelMessageRef(
  db: AppDb,
  input: ChannelMessageAuthorizationInput,
): Promise<void> {
  const ref = await getChannelMessageRef(db, input);
  if (!ref) throw new ChannelMessageRefError('message_not_managed');

  const actor = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .get();
  const isOwner = ref.ownerUserId === input.actorUserId;
  const isAdmin = actor?.role === 'admin';

  if (!isOwner && !isAdmin) throw new ChannelMessageRefError('message_not_owned');
  if (ref.deletedAt !== null) throw new ChannelMessageRefError('message_deleted');
}

/** Preserve a successful external deletion as an immutable authorization tombstone. */
export async function markChannelMessageRefDeleted(
  db: AppDb,
  identity: ChannelMessageExternalIdentity,
): Promise<void> {
  const ref = await getChannelMessageRef(db, identity);
  if (!ref) throw new ChannelMessageRefError('message_not_managed');

  await db
    .update(channelMessageRefs)
    .set({ deletedAt: sql`datetime('now')` })
    .where(and(externalIdentityWhere(identity), isNull(channelMessageRefs.deletedAt)));
}
