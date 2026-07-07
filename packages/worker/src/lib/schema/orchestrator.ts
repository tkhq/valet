import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orchestratorIdentities = sqliteTable('orchestrator_identities', {
  id: text().primaryKey(),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text().notNull().default('default'),
  ownerType: text().notNull().default('user'),
  ownerId: text().notNull().default(''),
  type: text().notNull().default('personal'),
  name: text().notNull().default('Agent'),
  handle: text().notNull(),
  avatar: text(),
  customInstructions: text(),
  personaId: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_orch_identity_handle').on(table.orgId, table.handle),
  uniqueIndex('idx_orch_identity_user').on(table.orgId, table.userId),
  // Partial in SQL (WHERE owner_id != ''): legacy rows without a user_id backfill to ''.
  uniqueIndex('idx_orch_identity_owner').on(table.orgId, table.ownerType, table.ownerId),
]);

// orchestrator_memories table removed — replaced by orchestrator_memory_files (see schema/memory-files.ts)
