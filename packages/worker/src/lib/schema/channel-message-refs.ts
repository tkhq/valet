import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { actionInvocations } from './actions.js';
import { sessions } from './sessions.js';
import { users } from './users.js';

/**
 * An authorization index for Valet-created external channel messages.
 *
 * External identity and ownership/provenance are deliberately the only stored
 * data: message content remains owned by the provider and existing transcripts.
 */
export const channelMessageRefs = sqliteTable('channel_message_refs', {
  id: text().primaryKey(),
  orgId: text().notNull(),
  channelType: text().notNull(),
  connectionScope: text().notNull(),
  channelId: text().notNull(),
  messageId: text().notNull(),
  ownerUserId: text().references(() => users.id, { onDelete: 'set null' }),
  sessionId: text().references(() => sessions.id, { onDelete: 'set null' }),
  actionInvocationId: text().references(() => actionInvocations.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  deletedAt: text(),
}, (table) => [
  uniqueIndex('idx_channel_message_refs_external').on(
    table.orgId,
    table.channelType,
    table.connectionScope,
    table.channelId,
    table.messageId,
  ),
  index('idx_channel_message_refs_owner').on(table.ownerUserId, table.createdAt),
]);

export type ChannelMessageRefRow = typeof channelMessageRefs.$inferSelect;
