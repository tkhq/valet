import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const credentials = sqliteTable('credentials', {
  id: text().primaryKey(),
  ownerType: text().notNull().default('user'),
  ownerId: text().notNull(),
  provider: text().notNull(),
  credentialType: text().notNull().default('oauth2'),
  encryptedData: text().notNull(),
  metadata: text(),
  scopes: text(),
  expiresAt: text(),
  // Last known failure state (NULL = healthy). Written only on state
  // transitions so getCredential can log edges instead of every attempt.
  lastFailureReason: text(),
  lastFailureAt: text(),
  /** Zapier-style sourced connections: the member whose tokens back a team credential. */
  sourcedFromUserId: text().references(() => users.id, { onDelete: 'set null' }),
  /** 'active' | 'broken' — broken when the sourcing member revokes or leaves the team. */
  status: text().notNull().default('active'),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('credentials_owner_unique').on(table.ownerType, table.ownerId, table.provider, table.credentialType),
  index('credentials_owner_lookup').on(table.ownerType, table.ownerId),
  index('credentials_provider').on(table.provider),
]);
