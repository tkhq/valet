import { beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1SessionBookmark,
  D1SessionConstraint,
} from '@cloudflare/workers-types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerChannelThread } from './channel-threads.js';
import { createThread, getThread, listThreads } from './threads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function d1Result<T>(results: T[]): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      duration: 0,
      last_row_id: 0,
      changes: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly sqlite: DatabaseType,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, this.sql, values);
  }

  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.sqlite.prepare<unknown[], Record<string, unknown>>(this.sql).get(...this.values);
    if (!row) return null;
    if (colName !== undefined) {
      return (row[colName] as T | undefined) ?? null;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.sqlite.prepare(this.sql).run(...this.values);
    return d1Result<T>([]);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.sqlite.prepare<unknown[], T>(this.sql).all(...this.values);
    return d1Result(results);
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.sqlite.prepare<unknown[], T>(this.sql).raw(true);
    const rows = statement.all(...this.values);
    if (options?.columnNames) {
      const columnNames = statement.columns().map((column) => column.name);
      return [columnNames, ...rows];
    }
    return rows;
  }
}

class SqliteD1DatabaseSession implements D1DatabaseSession {
  constructor(private readonly sqlite: DatabaseType) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  getBookmark(): D1SessionBookmark | null {
    return null;
  }
}

class SqliteD1Database implements D1Database {
  constructor(private readonly sqlite: DatabaseType) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return new SqliteD1DatabaseSession(this.sqlite);
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

function createD1Db(options: { skipMigrations?: string[] } = {}): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = OFF');

  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const skipMigrations = new Set(options.skipMigrations ?? []);
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !skipMigrations.has(file))
    .sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }

  return new SqliteD1Database(sqlite);
}

describe('threads db helpers', () => {
  let d1: D1Database;

  beforeEach(() => {
    d1 = createD1Db();
  });

  it('persists default web origin for newly-created threads', async () => {
    const thread = await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });

    expect(thread.originType).toBe('web');

    const stored = await getThread(d1, 'thread-web');
    expect(stored?.originType).toBe('web');
  });

  it('creates threads before origin metadata migration is applied', async () => {
    const legacyD1 = createD1Db({
      skipMigrations: ['0018_session_thread_origin_metadata.sql'],
    });

    const thread = await createThread(legacyD1, {
      id: 'thread-legacy',
      sessionId: 'orchestrator:user-1',
    });

    expect(thread).toMatchObject({
      id: 'thread-legacy',
      sessionId: 'orchestrator:user-1',
      originType: 'web',
    });
  });

  it('returns origin metadata separately from legacy routing channel metadata', async () => {
    await createThread(d1, {
      id: 'thread-automation',
      sessionId: 'orchestrator:user-1',
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
    });

    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-automation',
    });

    const result = await listThreads(d1, 'orchestrator:user-1');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      id: 'thread-automation',
      originType: 'automation',
      originTriggerId: 'trigger-1',
      originTriggerType: 'schedule',
      channelType: 'slack',
      channelId: 'D123',
    });
  });

  it('does not duplicate a thread with multiple legacy routing mappings', async () => {
    await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000002',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });

    const result = await listThreads(d1, 'orchestrator:user-1');
    expect(result.threads.map((thread) => thread.id)).toEqual(['thread-web']);
  });

  it('does not duplicate a thread with multiple legacy routing mappings in page mode', async () => {
    await createThread(d1, { id: 'thread-web', sessionId: 'orchestrator:user-1' });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'D123',
      externalThreadId: '1700000000.000002',
      userId: 'user-1',
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-web',
    });

    const result = await listThreads(d1, 'orchestrator:user-1', { page: 1, pageSize: 10 });
    expect(result.threads.map((thread) => thread.id)).toEqual(['thread-web']);
    expect(result).toMatchObject({
      hasMore: false,
      page: 1,
      pageSize: 10,
      totalCount: 1,
      totalPages: 1,
    });
  });
});

describe('listThreads per-origin bucket filter + counts', () => {
  let d1: D1Database;
  const sessionId = 'orchestrator:user-1';

  beforeEach(async () => {
    d1 = createD1Db();
    // Seed a heterogeneous set that mirrors what Conner sees in production:
    //   3 UI threads, 2 Slack threads (one via origin_type, one via legacy
    //   channel_thread_mappings), 4 Automation threads, 1 other (telegram).
    await createThread(d1, { id: 'ui-1', sessionId, originType: 'web' });
    await createThread(d1, { id: 'ui-2', sessionId, originType: 'web' });
    await createThread(d1, { id: 'ui-3', sessionId, originType: 'web' });

    await createThread(d1, {
      id: 'slack-1',
      sessionId,
      originType: 'slack',
      originChannelType: 'slack',
      originChannelId: 'C1',
    });
    // Legacy: no origin_* metadata, only a channel_thread_mappings row.
    await createThread(d1, { id: 'slack-legacy', sessionId, originType: undefined });
    await registerChannelThread(d1, {
      channelType: 'slack',
      channelId: 'C2',
      externalThreadId: '1700000000.000001',
      userId: 'user-1',
      sessionId,
      threadId: 'slack-legacy',
    });
    // Clear origin_type so the legacy fallback branch of the CASE fires.
    await d1
      .prepare("UPDATE session_threads SET origin_type = NULL, origin_channel_type = NULL WHERE id = 'slack-legacy'")
      .run();

    for (const id of ['auto-1', 'auto-2', 'auto-3', 'auto-4']) {
      await createThread(d1, { id, sessionId, originType: 'automation' });
    }

    await createThread(d1, { id: 'telegram-1', sessionId, originType: 'telegram' });
  });

  it('returns TRUE per-bucket totals in originCounts (independent of the bucket filter)', async () => {
    // Viewing the UI bucket — but originCounts must still show totals for
    // every bucket, including the non-viewed ones (this is the whole point).
    const result = await listThreads(d1, sessionId, {
      originBucket: 'ui',
    });
    expect(result.originCounts).toEqual({
      ui: 3,
      slack: 2, // 1 origin_type=slack + 1 legacy channel_thread_mappings=slack
      automation: 4,
      other: 1,
    });
    // Filtered list has exactly the 3 UI threads.
    expect(result.threads.map((t) => t.id).sort()).toEqual(['ui-1', 'ui-2', 'ui-3']);
  });

  it('applies each bucket filter independently — busy Automation does not starve Slack', async () => {
    // Fetch with a tiny limit. Under the OLD design, a single flat page with
    // limit=3 would return 3 threads across ALL buckets — a busy Automation
    // bucket (4 threads) could evict every Slack thread. Per-bucket filtering
    // means each bucket fills its own page cap independently.
    const uiResult = await listThreads(d1, sessionId, { originBucket: 'ui', limit: 3 });
    const slackResult = await listThreads(d1, sessionId, { originBucket: 'slack', limit: 3 });
    const autoResult = await listThreads(d1, sessionId, { originBucket: 'automation', limit: 3 });
    const otherResult = await listThreads(d1, sessionId, { originBucket: 'other', limit: 3 });

    expect(uiResult.threads.length).toBe(3);
    expect(slackResult.threads.length).toBe(2);
    expect(slackResult.threads.map((t) => t.id).sort()).toEqual(['slack-1', 'slack-legacy']);
    // Automation has 4 total but limit=3 so we get 3 + hasMore=true.
    expect(autoResult.threads.length).toBe(3);
    expect(autoResult.hasMore).toBe(true);
    expect(otherResult.threads.map((t) => t.id)).toEqual(['telegram-1']);
  });

  it('paginates within a single bucket via limit and returns hasMore', async () => {
    const first = await listThreads(d1, sessionId, { originBucket: 'automation', limit: 2 });
    expect(first.threads.length).toBe(2);
    expect(first.hasMore).toBe(true);

    // Load more by expanding the limit (matches the sidebar's Load-more UX
    // where `pagesForActiveBucket` grows the requested pageSize).
    const bigger = await listThreads(d1, sessionId, { originBucket: 'automation', limit: 10 });
    expect(bigger.threads.length).toBe(4);
    expect(bigger.hasMore).toBe(false);
  });

  it('page-mode: totalCount reflects the bucket-filtered set and originCounts stay global', async () => {
    const result = await listThreads(d1, sessionId, {
      originBucket: 'automation',
      page: 1,
      pageSize: 2,
    });
    // Filtered page: 2 automation threads out of a bucket-total of 4.
    expect(result.threads.length).toBe(2);
    expect(result.totalCount).toBe(4);
    expect(result.totalPages).toBe(2);
    expect(result.hasMore).toBe(true);
    // originCounts still show ALL buckets — unaffected by the filter.
    expect(result.originCounts).toEqual({
      ui: 3,
      slack: 2,
      automation: 4,
      other: 1,
    });
  });

  it('includeOriginCounts=true without a bucket filter returns global totals', async () => {
    const result = await listThreads(d1, sessionId, {
      includeOriginCounts: true,
      limit: 100,
    });
    expect(result.threads.length).toBe(10);
    expect(result.originCounts).toEqual({
      ui: 3,
      slack: 2,
      automation: 4,
      other: 1,
    });
  });

  it('omits originCounts when neither bucket nor includeOriginCounts is requested (backward compat)', async () => {
    const result = await listThreads(d1, sessionId, { limit: 100 });
    expect(result.threads.length).toBe(10);
    expect(result.originCounts).toBeUndefined();
  });

  it('classifies legacy threads via channel_thread_mappings.channel_type when origin_* is NULL', async () => {
    // The Slack legacy thread has no origin_* metadata — the SQL CASE must
    // fall back to `ctm.channel_type='slack'` to bucket it as slack, matching
    // the client's `getThreadOriginBucket` fallback in
    // components/chat/thread-origin-buckets.ts.
    const result = await listThreads(d1, sessionId, { originBucket: 'slack', limit: 10 });
    expect(result.threads.map((t) => t.id).sort()).toContain('slack-legacy');
  });
});
