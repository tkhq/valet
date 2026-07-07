import { sqliteTable, text, real, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// Note: orchestrator_memory_files_fts is an FTS5 virtual table and cannot be represented in Drizzle schema.
// FTS5 queries must use raw SQL via d1.prepare().
export const orchestratorMemoryFiles = sqliteTable('orchestrator_memory_files', {
  id: text().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().default('default'),
  path: text().notNull(),
  content: text().notNull(),
  title: text().notNull().default(''),
  type: text().notNull().default(''),
  description: text().notNull().default(''),
  tags: text().notNull().default('[]'),
  resource: text().notNull().default(''),
  extras: text().notNull().default('{}'),
  sensitivity: text().notNull().default('private'),
  origin: text().notNull().default(''),
  sourceSessionId: text('source_session_id').notNull().default(''),
  expires: text(),
  relevance: real().notNull().default(1.0),
  pinned: integer().notNull().default(0),
  version: integer().notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastAccessedAt: text('last_accessed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_memory_files_user_path').on(table.userId, table.path),
  index('idx_memory_files_user').on(table.userId),
  index('idx_memory_files_pinned').on(table.userId, table.pinned),
  index('idx_memory_files_resource').on(table.userId, table.resource),
]);

export const memoryLinks = sqliteTable('memory_links', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fromPath: text('from_path').notNull(),
  toPath: text('to_path').notNull(),
  context: text().notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.fromPath, table.toPath] }),
  index('idx_memory_links_to').on(table.userId, table.toPath),
]);
