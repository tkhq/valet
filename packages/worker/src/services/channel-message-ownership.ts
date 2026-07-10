import type { ChannelMessageOwnership, ChannelMessageRefInput } from '@valet/sdk';
import type { AppDb } from '../lib/drizzle.js';
import {
  assertCanModifyChannelMessageRef,
  markChannelMessageRefDeleted,
  registerChannelMessageRef,
} from '../lib/db/channel-message-refs.js';
import { getOrgSlackInstallAny } from '../lib/db/slack.js';

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

  return `user:${options.userId}`;
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
        ownerUserId: options.actorUserId,
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
