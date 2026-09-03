/**
 * Flagged-session export for the eval CLI's `--pull-flagged` (TKAI-334).
 *
 * The eval CLI runs OUTSIDE the api server and reads the database directly:
 * rating rows + session titles from the app schema, thread entries from the
 * engine schema. This module owns that access so the eval package never
 * touches drizzle or the schema itself.
 *
 * PGlite caveat: the embedded dev database allows exactly one owning
 * process. Stop the api (`make dev-stop`) before pulling from a PGlite data
 * dir, or point at DATABASE_URL.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { and, desc, eq } from "drizzle-orm";
import type { SessionEntry } from "@valet/engine";
import { PgSessionStore, pgDbFromPglite, pgDbFromPool } from "@valet/store-postgres";
import { buildAppDb, type AppDb } from "./drizzle.js";
import { agentSessions, childWatches, ratings } from "../schema/index.js";
import type { RatingValue } from "../wire/types.js";

export interface EvalDataSource {
  appDb: AppDb;
  engineStore: PgSessionStore;
  close: () => Promise<void>;
}

/**
 * Open the database for an eval pull: `databaseUrl` when set, otherwise the
 * embedded PGlite dir. No migrations run — this is a read path against an
 * existing database.
 */
export async function openEvalDataSource(opts: {
  databaseUrl?: string;
  pgDataDir?: string;
}): Promise<EvalDataSource> {
  if (opts.databaseUrl !== undefined && opts.databaseUrl.length > 0) {
    const pool = new Pool({ connectionString: opts.databaseUrl });
    return {
      appDb: buildAppDb(pool),
      engineStore: new PgSessionStore(pgDbFromPool(pool)),
      close: () => pool.end(),
    };
  }
  if (opts.pgDataDir === undefined || opts.pgDataDir.length === 0) {
    throw new Error(
      "no database configured. Set DATABASE_URL, or pass the PGlite data dir (VALET_DATA_DIR/pg).",
    );
  }
  const { existsSync } = await import("node:fs");
  if (!existsSync(opts.pgDataDir)) {
    throw new Error(
      `PGlite data dir not found: ${opts.pgDataDir}. ` +
        "Set VALET_DATA_DIR to the stack that holds your sessions, or set DATABASE_URL.",
    );
  }
  let pglite: PGlite;
  try {
    pglite = await PGlite.create(opts.pgDataDir);
  } catch (err) {
    // The single most common failure: a running api owns the data dir.
    throw new Error(
      `could not open PGlite at ${opts.pgDataDir} (${err instanceof Error ? err.message : String(err)}). ` +
        "Stop the api first (make dev-stop), or point DATABASE_URL at a server database.",
    );
  }
  return {
    appDb: buildAppDb(pglite),
    engineStore: new PgSessionStore(pgDbFromPglite(pglite)),
    close: () => pglite.close(),
  };
}

/**
 * The children a session spawned, with settlement state — the product-drive
 * eval harness polls this for quiescence and child-trajectory capture.
 * Schema access stays in this module (the api owns the app schema).
 */
export async function listChildSessions(
  db: AppDb,
  parentSessionId: string,
): Promise<Array<{ childSessionId: string; queueItemId: string; settled: boolean }>> {
  const rows = await db
    .select({
      childSessionId: childWatches.childSessionId,
      queueItemId: childWatches.queueItemId,
      settled: childWatches.settled,
    })
    .from(childWatches)
    .where(eq(childWatches.parentSessionId, parentSessionId));
  return rows;
}

export interface FlaggedSessionExport {
  sessionId: string;
  rating: RatingValue;
  title: string | null;
  /** The rating's updatedAt (ms epoch). */
  ratedAt: number;
  /** Rating owner. */
  userId: string;
  threads: Array<{ threadId: string; entries: SessionEntry[] }>;
}

/**
 * Read every session-level rating row with the given value (across all
 * users — the pull harvests the whole instance's feedback) and attach each
 * session's full thread entries.
 */
export async function readFlaggedSessions(
  src: EvalDataSource,
  opts: { rating: RatingValue },
): Promise<FlaggedSessionExport[]> {
  const rows = await src.appDb
    .select({
      sessionId: ratings.sessionId,
      rating: ratings.rating,
      updatedAt: ratings.updatedAt,
      userId: ratings.userId,
      title: agentSessions.title,
    })
    .from(ratings)
    .leftJoin(agentSessions, eq(agentSessions.id, ratings.sessionId))
    .where(and(eq(ratings.targetType, "session"), eq(ratings.rating, opts.rating)))
    .orderBy(desc(ratings.updatedAt));

  const out: FlaggedSessionExport[] = [];
  for (const row of rows) {
    const threads = await src.engineStore.listThreads(row.sessionId);
    const withEntries: FlaggedSessionExport["threads"] = [];
    for (const thread of threads) {
      const entries = await src.engineStore.getEntries(row.sessionId, thread.id);
      if (entries.length > 0) withEntries.push({ threadId: thread.id, entries });
    }
    out.push({
      sessionId: row.sessionId,
      rating: row.rating,
      title: row.title ?? null,
      ratedAt: row.updatedAt,
      userId: row.userId,
      threads: withEntries,
    });
  }
  return out;
}
