import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

export function migrationSql(file: string): string {
  return fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
}

/**
 * Creates an in-memory SQLite database with all migrations applied,
 * returning a Drizzle instance compatible with the schema tables.
 */
export function createTestDb(): { db: BetterSQLite3Database; sqlite: DatabaseType } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

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

/** Create the D1 subset used by raw-query tests on top of better-sqlite3. */
export function createD1TestShim(sqlite: DatabaseType): D1Database {
  const prepare = (query: string): D1PreparedStatement => {
    const statement = sqlite.prepare(query);
    let bindings: unknown[] = [];
    const prepared = {
      bind(...values: unknown[]) {
        bindings = values;
        return prepared;
      },
      async first<T>(column?: string): Promise<T | null> {
        const row = statement.get(...bindings) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        return { results: statement.all(...bindings) as T[], success: true, meta: {} };
      },
      async run() {
        statement.run(...bindings);
        return { success: true, meta: {} };
      },
      async raw<T>() {
        return statement.raw(true).all(...bindings) as T[];
      },
    };
    return prepared as D1PreparedStatement;
  };

  return {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results as T[];
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as D1Database;
}
