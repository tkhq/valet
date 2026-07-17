import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates an in-memory SQLite database with all migrations applied,
 * returning a Drizzle instance compatible with the schema tables.
 */
export function createTestDb(): { db: BetterSQLite3Database; sqlite: DatabaseType } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    sqlite.exec(sql);
  }

  const db = drizzle(sqlite, { casing: 'snake_case' });
  return { db, sqlite };
}

/**
 * Bridges a better-sqlite3 handle to the slice of D1Database the lib/db
 * helpers use: prepare().bind().first()/all()/run(). Implementing the full
 * D1PreparedStatement surface (raw(), column-name overloads, result meta)
 * isn't practical for a test bridge, so the double-cast below is the one
 * sanctioned exception to the no-`as unknown as` rule — keep it here
 * instead of re-deriving it per test file.
 */
export function createD1TestShim(sqlite: DatabaseType): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...args) ?? null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
            async run() {
              sqlite.prepare(sql).run(...args);
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
