import { sql } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';

/** Dashboard plans are too short to recover PostgreSQL's JIT compilation cost.
 * Keep settings local to this read transaction, never the shared connection. */
export function usageRead<Options, Result>(query: (db: AppDb, opts: Options) => Promise<Result>) {
  return (db: AppDb, opts: Options): Promise<Result> => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL work_mem = '16MB'`);
    return query(tx, opts);
  }, { accessMode: 'read only' });
}
