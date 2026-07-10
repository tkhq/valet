import type { ChannelMessageOwnership, ChannelMessageRefInput } from '@valet/sdk';
import type { AppDb } from '../lib/drizzle.js';
import {
  assertCanModifyChannelMessageRef,
  markChannelMessageRefDeleted,
  registerChannelMessageRef,
} from '../lib/db/channel-message-refs.js';
import { getActiveIntegrationConnectionId } from '../lib/db/integrations.js';
import { getOrgSlackInstallAny } from '../lib/db/slack.js';
import { getUserTelegramConfig } from '../lib/db/telegram.js';
import type { ChannelContext, ChannelTarget, ChannelTransport, OutboundMessage, SendResult } from '@valet/sdk';

export interface ChannelMessageOwnershipOptions {
  db: AppDb;
  actorUserId: string;
  orgId: string;
  channelType: string;
  connectionScope: string;
  sessionId?: string;
  actionInvocationId?: string;
}

export interface ConnectionScopeOptions {
  db: AppDb;
  encryptionKey: string;
  channelType: string;
  userId: string;
}

/** Resolve a stable credential namespace without exposing credential material. */
export async function resolveChannelMessageConnectionScope(
  options: ConnectionScopeOptions,
): Promise<string> {
  if (options.channelType === 'slack') {
    const install = await getOrgSlackInstallAny(options.db, options.encryptionKey);
    if (!install?.teamId) {
      throw new Error('Channel message ownership requires a configured Slack installation');
    }
    return install.teamId;
  }

  if (options.channelType === 'telegram') {
    const config = await getUserTelegramConfig(options.db, options.userId);
    if (config) return `config:${config.id}`;
  }

  const integrationId = await getActiveIntegrationConnectionId(
    options.db,
    options.userId,
    options.channelType,
  );
  if (integrationId) return `integration:${integrationId}`;

  // No-auth/internal actions still receive a capability, but this fallback
  // deliberately does not represent a user-scoped external connection.
  return `unconfigured:${options.channelType}`;
}

/** Create the narrow, worker-bound ownership capability exposed to plugins. */
export function createChannelMessageOwnership(
  options: ChannelMessageOwnershipOptions,
): ChannelMessageOwnership {
  const identity = (ref: ChannelMessageRefInput) => ({
    orgId: options.orgId,
    channelType: options.channelType,
    connectionScope: options.connectionScope,
    channelId: ref.channelId,
    messageId: ref.messageId,
  });

  return {
    async registerCreated(ref) {
      await registerChannelMessageRef(options.db, {
        ...identity(ref),
        ownerUserId: options.actorUserId || null,
        sessionId: options.sessionId,
        actionInvocationId: options.actionInvocationId,
      });
    },
    async assertCanModify(ref) {
      await assertCanModifyChannelMessageRef(options.db, {
        ...identity(ref),
        actorUserId: options.actorUserId,
      });
    },
    async markDeleted(ref) {
      await assertCanModifyChannelMessageRef(options.db, {
        ...identity(ref),
        actorUserId: options.actorUserId,
      });
      await markChannelMessageRefDeleted(options.db, identity(ref));
    },
  };
}

/** Send through a channel transport and persist the provider ref before reporting success. */
export async function sendManagedChannelMessage(options: {
  db: AppDb;
  encryptionKey: string;
  transport: ChannelTransport;
  target: ChannelTarget;
  message: OutboundMessage;
  ctx: ChannelContext;
  orgId?: string;
  sessionId?: string;
}): Promise<SendResult> {
  if (!options.orgId) {
    return { success: false, error: 'Message ownership context unavailable' };
  }
  let ownership: ChannelMessageOwnership;
  try {
    const scope = await resolveChannelMessageConnectionScope({
      db: options.db,
      encryptionKey: options.encryptionKey,
      channelType: options.transport.channelType,
      userId: options.ctx.userId,
    });
    ownership = createChannelMessageOwnership({
      db: options.db,
      actorUserId: options.ctx.userId,
      orgId: options.orgId,
      channelType: options.transport.channelType,
      connectionScope: scope,
      sessionId: options.sessionId,
    });
  } catch {
    return { success: false, error: 'Message ownership context unavailable' };
  }
  const ctx: ChannelContext = { ...options.ctx, channelMessageOwnership: ownership };
  const result = await options.transport.sendMessage(options.target, options.message, ctx);
  if (!result.success) return result;
  if (!result.messageId) {
    return { success: false, error: 'Message sent, but provider returned no message ID' };
  }
  try {
    await ownership.registerCreated({
      channelType: options.transport.channelType,
      channelId: options.target.channelId,
      messageId: result.messageId,
    });
  } catch {
    return { success: false, error: 'Message sent, but ownership could not be recorded' };
  }
  return result;
}
