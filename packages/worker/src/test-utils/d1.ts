import type { Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * A better-sqlite3-backed fake of the async D1 surface (prepare→bind→run/all/first
 * plus batch() as one atomic sequential transaction). The single bridging cast to
 * D1Database is confined to this helper so every call site stays fully typed.
 */
export function makeD1Adapter(sqlite: DatabaseType): D1Database {
  const bound = (sql: string, args: unknown[]) => ({
    sql,
    args,
    async run() { return sqlite.prepare(sql).run(...args); },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  });
  const adapter = {
    prepare(sql: string) {
      // Real D1 statements expose bind() AND run/all/first directly (no-param
      // queries skip bind()); mirror that so both call styles work.
      return { bind: (...args: unknown[]) => bound(sql, args), ...bound(sql, []) };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      const runResults = sqlite.transaction(
        () => stmts.map((s) => sqlite.prepare(s.sql).run(...s.args)),
      )();
      return runResults.map((r) => ({
        results: [],
        success: true,
        meta: {
          changed_db: r.changes > 0,
          changes: r.changes,
          duration: 0,
          last_row_id: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
          rows_read: 0,
          rows_written: r.changes,
          served_by: '',
          size_after: 0,
        },
      }));
    },
  };
  return adapter as unknown as D1Database;
}
