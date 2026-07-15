import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

/**
 * Minimal query surface shared by raw-SQL stores. Deliberately narrow: text
 * + positional params in, normalized rows/rowCount out. See decision 4 of
 * docs/specs/2026-07-15-postgres-backend-design.md.
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

/**
 * `transaction(fn)` is the only sanctioned way to run multi-statement,
 * fenced writes. Its two implementations deliberately diverge:
 *   - PGlite: the driver's own `transaction()`, which serializes against
 *     the single underlying connection.
 *   - node-postgres: a single checked-out client from the pool, with every
 *     statement `fn` issues bound to that one client, released in a
 *     `finally`.
 * Routing BEGIN/COMMIT/ROLLBACK through the shared `query()` is forbidden —
 * see the guardrail in `assertNotTransactionControl` below.
 */
export interface PgDb extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const TRANSACTION_CONTROL_PATTERN = /^(begin|commit|rollback|savepoint)\b/i;

/**
 * Guardrail, not a SQL parser: a prefix match is sufficient to catch callers
 * who reach for raw BEGIN/COMMIT/ROLLBACK/SAVEPOINT instead of the
 * `transaction(fn)` primitive. Adversarial review demonstrated that routing
 * transaction control through the shared `query()` loses updates on PGlite
 * (interleaved async callers share the connection) and is meaningless on
 * `pg.Pool` (statements land on different pooled connections).
 */
function assertNotTransactionControl(text: string): void {
  if (TRANSACTION_CONTROL_PATTERN.test(text.trim())) {
    throw new Error(
      `Transaction-control statements ("${text.trim().split(/\s+/)[0]}") must not be issued through query() — use transaction(fn) instead.`,
    );
  }
}

function normalizePgliteRowCount(affectedRows: number | undefined): number {
  return affectedRows ?? 0;
}

function normalizePoolRowCount(rowCount: number | null): number {
  return rowCount ?? 0;
}

export function pgDbFromPglite(pglite: PGlite): PgDb {
  return {
    async query(text, params = []) {
      assertNotTransactionControl(text);
      const result = await pglite.query<Record<string, unknown>>(text, params);
      return { rows: result.rows, rowCount: normalizePgliteRowCount(result.affectedRows) };
    },
    async transaction(fn) {
      return pglite.transaction(async (tx) => {
        const queryable: PgQueryable = {
          async query(text, params = []) {
            assertNotTransactionControl(text);
            const result = await tx.query<Record<string, unknown>>(text, params);
            return { rows: result.rows, rowCount: normalizePgliteRowCount(result.affectedRows) };
          },
        };
        return fn(queryable);
      });
    },
    async close() {
      await pglite.close();
    },
  };
}

export function pgDbFromPool(pool: Pool): PgDb {
  return {
    async query(text, params = []) {
      assertNotTransactionControl(text);
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: normalizePoolRowCount(result.rowCount) };
    },
    async transaction(fn) {
      const client: PoolClient = await pool.connect();
      const queryable: PgQueryable = {
        async query(text, params = []) {
          assertNotTransactionControl(text);
          const result = await client.query(text, params);
          return { rows: result.rows, rowCount: normalizePoolRowCount(result.rowCount) };
        },
      };
      try {
        await client.query("BEGIN");
        const result = await fn(queryable);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A failed ROLLBACK (e.g. connection drop) must not mask the
          // original error — the caller needs the real fencing/business
          // failure. The client is released below either way; node-postgres
          // discards broken connections on release(err-less) via pool checks.
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Narrows an unknown error to one carrying a string `code` property. */
function hasCode(value: unknown): value is { code: unknown } {
  return typeof value === "object" && value !== null && "code" in value;
}

function hasCause(value: unknown): value is { cause: unknown } {
  return typeof value === "object" && value !== null && "cause" in value;
}

/** True iff `err` (or its `.cause`) carries Postgres's unique_violation code. */
export function isPgUniqueViolation(err: unknown): boolean {
  if (hasCode(err) && err.code === "23505") return true;
  if (hasCause(err)) return isPgUniqueViolation(err.cause);
  return false;
}
