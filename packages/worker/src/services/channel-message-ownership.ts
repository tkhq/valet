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
  /** Worker-only secret material from the credential resolver; never exposed to plugins. */
  credentialScopeMaterial?: string;
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

  if (options.credentialScopeMaterial) {
    return `credential:${await credentialScopeFingerprint(options.credentialScopeMaterial)}`;
  }

  // Actions without a user credential (for example worker-internal tools)
  // still need an injected capability, but cannot correspond to an external
  // user-scoped channel connection.
  return `service:${options.channelType}:user:${options.userId}`;
}

async function credentialScopeFingerprint(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
