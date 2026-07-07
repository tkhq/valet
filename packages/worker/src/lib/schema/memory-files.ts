import { sqliteTable, text, real, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// Note: orchestrator_memory_files_fts is an FTS5 virtual table and cannot be represented in Drizzle schema.
// FTS5 queries must use raw SQL via d1.prepare().
export const orchestratorMemoryFiles = sqliteTable('orchestrator_memory_files', {
  id: text().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().default('default'),
  ownerType: text('owner_type').notNull().default('user'),
  ownerId: text('owner_id').notNull().default(''),
  path: text().notNull(),
  content: text().notNull(),
  title: text().notNull().default(''),
  relevance: real().notNull().default(1.0),
  pinned: integer().notNull().default(0),
  version: integer().notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastAccessedAt: text('last_accessed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_memory_files_user').on(table.userId),
  index('idx_memory_files_pinned').on(table.userId, table.pinned),
  index('idx_memory_files_owner').on(table.ownerType, table.ownerId),
  uniqueIndex('idx_memory_files_owner_path').on(table.ownerType, table.ownerId, table.path),
]);
