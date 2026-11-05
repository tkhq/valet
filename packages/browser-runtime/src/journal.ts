import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  BrowserAuditEntry,
  BrowserCellReceipt,
  BrowserCellStatus,
  BrowserError,
  BrowserEvent,
  BrowserEventPayload,
  BrowserOperationReceipt,
  BrowserOperationStatus,
} from '@valet/shared';
import { BrowserFault } from './protocol.js';
interface CellRow {
  id: string;
  invocation: string;
  session: string;
  thread: string;
  actor: string;
  runtime: string;
  hash: string;
  status: BrowserCellStatus;
  error: string | null;
}
interface OperationRow {
  id: string;
  cell: string;
  method: string;
  hash: string;
  status: BrowserOperationStatus;
  result: string | null;
  error: string | null;
}
interface EventRow {
  id: number;
  cell: string | null;
  timestamp: number;
  payload: string;
}
/** SQLite owns receipts. No recovery path dispatches an operation. */
export class Journal {
  private readonly db: Database.Database;
  constructor(
    path: string,
    private readonly runtimeId: string,
    private readonly retention = 2048,
  ) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cells (id TEXT PRIMARY KEY, invocation TEXT UNIQUE NOT NULL, session TEXT NOT NULL, thread TEXT NOT NULL, actor TEXT NOT NULL, runtime TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, cell TEXT NOT NULL REFERENCES cells(id), method TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, cell TEXT, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // A process crash destroys continuations. Effects dispatched before the crash remain uncertain.
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE operations SET status='outcome_unknown', error=? WHERE status='in_flight'",
        )
        .run(
          JSON.stringify({
            code: 'OUTCOME_UNKNOWN',
            message: 'The runtime stopped during an operation.',
            correctiveAction:
              'Observe the page before starting a new operation.',
            effect: 'possible',
          }),
        );
      this.db
        .prepare(
          "UPDATE operations SET status='cancelled' WHERE status IN ('prepared','awaiting_approval')",
        )
        .run();
      this.db
        .prepare(
          "UPDATE cells SET status='lost', error=? WHERE status IN ('running','awaiting_approval')",
        )
        .run(
          JSON.stringify({
            code: 'CELL_LOST',
            message: 'The cell continuation was lost.',
            correctiveAction:
              'Observe the page and submit a new cell. Do not replay the old cell.',
            effect: 'possible',
          }),
        );
    })();
  }
  submit(
    session: string,
    thread: string,
    actor: string,
    invocation: string,
    hash: string,
  ): { created: boolean; cell: BrowserCellReceipt } {
    const old = this.db
      .prepare<[string], CellRow>('SELECT * FROM cells WHERE invocation=?')
      .get(invocation);
    if (old) {
      if (old.hash !== hash)
        throw new BrowserFault(
          'INVOCATION_CONFLICT',
          'This invocation has different code or policy context.',
          'Use a new invocation ID for intentional new execution.',
        );
      this.authorize(old, session, thread, actor);
      return { created: false, cell: this.receipt(old) };
    }
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const pageSize = Number(this.db.pragma('page_size', { simple: true }));
    if (pages * pageSize > 500 * 1024 * 1024)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'The browser journal quota was reached.',
        'Export the audit records and reset browser data under user authorization.',
      );
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO cells(id,invocation,session,thread,actor,runtime,hash,status) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        invocation,
        session,
        thread,
        actor,
        this.runtimeId,
        hash,
        'running',
      );
    return {
      created: true,
      cell: {
        cellId: id,
        invocationId: invocation,
        runtimeId: this.runtimeId,
        threadId: thread,
        status: 'running',
        operations: [],
      },
    };
  }
  cell(
    invocation: string,
    session: string,
    thread: string,
    actor: string,
  ): BrowserCellReceipt | undefined {
    const row = this.db
      .prepare<[string], CellRow>('SELECT * FROM cells WHERE invocation=?')
      .get(invocation);
    if (!row) return undefined;
    this.authorize(row, session, thread, actor);
    return this.receipt(row);
  }
  byId(id: string): BrowserCellReceipt {
    const row = this.db
      .prepare<[string], CellRow>('SELECT * FROM cells WHERE id=?')
      .get(id);
    if (!row)
      throw new BrowserFault(
        'CELL_LOST',
        'The cell receipt is missing.',
        'Read browser status and submit a new invocation.',
      );
    return this.receipt(row);
  }
  private authorize(
    row: CellRow,
    session: string,
    thread: string,
    actor: string,
  ) {
    if (row.session !== session || row.thread !== thread || row.actor !== actor)
      throw new BrowserFault(
        'IDENTITY_MISMATCH',
        'This cell belongs to another principal.',
        'Use the original session, thread, and actor.',
      );
  }
  private receipt(row: CellRow): BrowserCellReceipt {
    let remaining = 32000;
    const operations = this.db
      .prepare<[string], OperationRow>(
        'SELECT * FROM operations WHERE cell=? ORDER BY rowid',
      )
      .all(row.id)
      .map((row) => {
        const operation = this.operationReceipt(row);
        const size = row.result?.length ?? 0;
        if (size > remaining) {
          delete operation.result;
          operation.resultTruncated = true;
        } else remaining -= size;
        return operation;
      });
    return {
      cellId: row.id,
      invocationId: row.invocation,
      runtimeId: row.runtime,
      threadId: row.thread,
      status: row.status,
      operations,
      ...(row.error ? { error: JSON.parse(row.error) as BrowserError } : {}),
    };
  }
  private operationReceipt(row: OperationRow): BrowserOperationReceipt {
    return {
      operationId: row.id,
      cellId: row.cell,
      method: row.method,
      hash: row.hash,
      status: row.status,
      ...(row.result ? { result: JSON.parse(row.result) as unknown } : {}),
      ...(row.error ? { error: JSON.parse(row.error) as BrowserError } : {}),
    };
  }
  settle(id: string, status: BrowserCellStatus, error?: BrowserError) {
    this.db
      .prepare('UPDATE cells SET status=?,error=? WHERE id=?')
      .run(status, error ? JSON.stringify(error) : null, id);
  }
  prepare(
    cell: string,
    id: string,
    method: string,
    hash: string,
  ): BrowserOperationReceipt {
    const old = this.db
      .prepare<[string], OperationRow>('SELECT * FROM operations WHERE id=?')
      .get(id);
    if (old) {
      if (old.cell !== cell || old.hash !== hash || old.method !== method)
        throw new BrowserFault(
          'INVOCATION_CONFLICT',
          'The operation identity changed.',
          'Use a new invocation ID.',
        );
      return this.operationReceipt(old);
    }
    this.db
      .prepare(
        'INSERT INTO operations(id,cell,method,hash,status) VALUES(?,?,?,?,?)',
      )
      .run(id, cell, method, hash, 'prepared');
    return { operationId: id, cellId: cell, method, hash, status: 'prepared' };
  }
  operation(
    id: string,
    status: BrowserOperationStatus,
    result?: unknown,
    error?: BrowserError,
  ) {
    const serialized = result === undefined ? null : JSON.stringify(result);
    if (serialized && serialized.length > 128_000)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Operation output exceeds the receipt limit.',
        'Request a smaller observation.',
      );
    this.db
      .prepare('UPDATE operations SET status=?,result=?,error=? WHERE id=?')
      .run(status, serialized, error ? JSON.stringify(error) : null, id);
  }
  emit(payload: BrowserEventPayload, cellId?: string): BrowserEvent {
    const body = JSON.stringify(payload);
    if (body.length > 128_000)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Event output exceeds the limit.',
        'Emit smaller output batches.',
      );
    const timestamp = Date.now();
    const id = Number(
      this.db
        .prepare('INSERT INTO events(cell,timestamp,payload) VALUES(?,?,?)')
        .run(cellId ?? null, timestamp, body).lastInsertRowid,
    );
    this.db.prepare('DELETE FROM events WHERE id<=?').run(id - this.retention);
    return { ...payload, cursor: id, timestamp, ...(cellId ? { cellId } : {}) };
  }
  events(cell: string | undefined, after: number) {
    const rows = cell
      ? this.db
          .prepare<
            [string, number],
            EventRow
          >('SELECT * FROM events WHERE cell=? AND id>? ORDER BY id LIMIT 128')
          .all(cell, after)
      : this.db
          .prepare<
            [number],
            EventRow
          >('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 128')
          .all(after);
    const oldest = this.db
      .prepare<[], { id: number | null }>('SELECT MIN(id) AS id FROM events')
      .get()?.id;
    let bytes = 0;
    const events: BrowserEvent[] = [];
    for (const row of rows) {
      bytes += row.payload.length;
      if (bytes > 256_000) break;
      events.push({
        ...(JSON.parse(row.payload) as BrowserEventPayload),
        cursor: row.id,
        timestamp: row.timestamp,
        ...(row.cell ? { cellId: row.cell } : {}),
      });
    }
    return {
      events,
      cursor: events.at(-1)?.cursor ?? after,
      gap:
        after > 0 &&
        oldest !== undefined &&
        oldest !== null &&
        after < oldest - 1,
    };
  }
  metadata<T>(key: string): T | undefined {
    const row = this.db
      .prepare<
        [string],
        { value: string }
      >('SELECT value FROM metadata WHERE key=?')
      .get(key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setMetadata(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  auditTotal(): number {
    return (
      this.db
        .prepare<
          [],
          { count: number }
        >('SELECT COUNT(*) AS count FROM operations')
        .get()?.count ?? 0
    );
  }
  audit(offset = 0): BrowserAuditEntry[] {
    return this.db
      .prepare<
        [number],
        BrowserAuditEntry
      >('SELECT cells.invocation AS invocationId,cells.id AS cellId,operations.id AS operationId,cells.session AS sessionId,cells.thread AS threadId,cells.actor AS actorId,cells.runtime AS runtimeId,operations.method,operations.hash,operations.status FROM operations JOIN cells ON cells.id=operations.cell ORDER BY operations.rowid DESC LIMIT 500 OFFSET ?')
      .all(offset);
  }
  close() {
    this.db.close();
  }
}
