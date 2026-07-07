import { sqliteTable, text, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const teams = sqliteTable('teams', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  name: text().notNull(),
  description: text(),
  avatar: text(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_teams_org_name').on(table.orgId, table.name),
]);

export const teamMembers = sqliteTable('team_members', {
  teamId: text().notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text().notNull().default('member'),
  addedBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.userId] }),
  index('idx_team_members_user').on(table.userId),
]);
