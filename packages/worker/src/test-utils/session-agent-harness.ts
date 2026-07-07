// Shared SessionAgentDO test harness — mock DO ctx/SQL/D1 plus a
// fully-stubbed agent factory. Extracted verbatim from
// session-agent.test.ts so sibling test files can construct the DO the
// same way instead of duplicating the mock storage layer.
import { vi, type Mock } from 'vitest';
import { SessionAgentDO } from '../durable-objects/session-agent.js';


export interface QueueRow {
  id: string;
  content: string;
  attachments: string | null;
  model: string | null;
  queue_type: string;
  workflow_execution_id: string | null;
  workflow_payload: string | null;
  status: string;
  author_id: string | null;
  author_email: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
  channel_type: string | null;
  channel_id: string | null;
  channel_key: string | null;
  thread_id: string | null;
  continuation_context: string | null;
  context_prefix: string | null;
  reply_channel_type: string | null;
  reply_channel_id: string | null;
  child_session_id: string | null;
  child_status: string | null;
  priority: number;
  replaceable: number;
  received_at: number | null;
  dispatched_at: number | null;
  created_at: number;
}

export interface InteractivePromptRow {
  id: string;
  type: string;
  request_id: string | null;
  title: string;
  body?: string | null;
  actions: string;
  context: string;
  status: string;
  expires_at: number | null;
  channel_refs?: string | null;
}

function cursor<T>(rows: T[]): { toArray(): T[]; one(): T } {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length === 0) throw new Error('Expected exactly one row');
      return rows[0];
    },
  };
}

let insertCounter = 0;

export function createMockSql(): SqlStorage & {
  queue: Map<string, QueueRow>;
  state: Map<string, string>;
  interactivePrompts: Map<string, InteractivePromptRow>;
  messages: Map<string, Record<string, unknown>>;
  channelState: Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>;
} {
  const queue = new Map<string, QueueRow>();
  const state = new Map<string, string>();
  const interactivePrompts = new Map<string, InteractivePromptRow>();
  const messages = new Map<string, Record<string, unknown>>();
  const channelState = new Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>();
  insertCounter = 0;

  return {
    queue,
    state,
    interactivePrompts,
    messages,
    channelState,
    exec(query: string, ...params: unknown[]) {
      const q = query.trim();

      if (q.startsWith('CREATE') || q.startsWith('ALTER TABLE')) {
        return cursor([]);
      }

      if (q.startsWith('INSERT INTO channel_state')) {
        const channelKey = String(params[0]);
        const existing = channelState.get(channelKey) ?? {
          busy: 0,
          opencode_session_id: null,
          idle_queued_since: null,
          error_safety_net_at: null,
        };
        // Distinguish between the four INSERT patterns by checking the column list.
        if (q.includes('opencode_session_id')) {
          const opencodeSessionId = params[1] === undefined || params[1] === null
            ? null
            : String(params[1]);
          channelState.set(channelKey, { ...existing, opencode_session_id: opencodeSessionId });
        } else if (q.includes('idle_queued_since')) {
          const ms = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, idle_queued_since: ms });
        } else if (q.includes('error_safety_net_at')) {
          const ms = params[1] === undefined || params[1] === null ? null : Number(params[1]);
          channelState.set(channelKey, { ...existing, error_safety_net_at: ms });
        } else {
          // Default: (channel_key, busy) — setChannelBusy
          const busy = Number(params[1]) || 0;
          channelState.set(channelKey, { ...existing, busy });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET busy')) {
        // clearAllChannelBusy — reset all channels to idle
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, busy: 0 });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET idle_queued_since')) {
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, idle_queued_since: null });
        }
        return cursor([]);
      }

      if (q.startsWith('UPDATE channel_state SET error_safety_net_at')) {
        for (const [key, val] of channelState) {
          channelState.set(key, { ...val, error_safety_net_at: null });
        }
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM channel_state')) {
        if (q.includes('WHERE busy = 1')) {
          const busy = Array.from(channelState.entries()).find(([, row]) => row.busy === 1);
          return busy === undefined ? cursor([]) : cursor([{ channel_key: busy[0] }]);
        }
        if (q.includes('error_safety_net_at IS NOT NULL')) {
          const rows = Array.from(channelState.entries())
            .filter(([, r]) => r.error_safety_net_at !== null)
            .map(([k, r]) => ({ channel_key: k, error_safety_net_at: r.error_safety_net_at }));
          rows.sort((a, b) => (a.error_safety_net_at ?? 0) - (b.error_safety_net_at ?? 0));
          return cursor(rows.slice(0, 1));
        }
        if (q.includes('idle_queued_since IS NOT NULL')) {
          const rows = Array.from(channelState.entries())
            .filter(([, r]) => r.idle_queued_since !== null)
            .map(([k, r]) => ({ channel_key: k, idle_queued_since: r.idle_queued_since }));
          rows.sort((a, b) => (a.idle_queued_since ?? 0) - (b.idle_queued_since ?? 0));
          return cursor(rows.slice(0, 1));
        }
        // Reverse lookup by opencode_session_id — used by getChannelKeyByOcSessionId
        // to route call-tool approvals back to the originating thread.
        if (q.includes('opencode_session_id = ?')) {
          const ocSessionId = String(params[0]);
          const found = Array.from(channelState.entries())
            .find(([, r]) => r.opencode_session_id === ocSessionId);
          return found
            ? cursor([{ channel_key: found[0] }])
            : cursor([]);
        }
        const channelKey = String(params[0]);
        const row = channelState.get(channelKey);
        return row === undefined ? cursor([]) : cursor([row]);
      }
      if (q.startsWith("UPDATE prompt_queue SET queue_type = 'prompt'")) {
        return cursor([]);
      }
      if (q.startsWith('CREATE INDEX')) {
        return cursor([]);
      }

      if (q.startsWith('INSERT OR REPLACE INTO state')) {
        state.set(String(params[0]), String(params[1]));
        return cursor([]);
      }

      if (q.includes('SELECT MAX(seq) as max_seq FROM messages')) {
        return cursor([{ max_seq: null }]);
      }

      if (q.includes('SELECT 1 FROM messages WHERE id = ?')) {
        return cursor(messages.has(String(params[0])) ? [{ 1: 1 }] : []);
      }

      if (q.startsWith('INSERT OR IGNORE INTO messages')) {
        const id = String(params[0]);
        if (!messages.has(id)) {
          messages.set(id, { id, seq: params[1], role: params[2], content: params[3] });
        }
        return cursor([]);
      }

      if (q.includes("SELECT value FROM replication_state WHERE key = 'last_replicated_seq'")) {
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM state')) {
        const value = state.get(String(params[0]));
        return value === undefined ? cursor([]) : cursor([{ value }]);
      }

      if (q.startsWith('INSERT INTO prompt_queue')) {
        insertCounter += 1;
        let row: QueueRow;
        if (q.includes("'workflow_execute'")) {
          // Workflow-execute insert: (id, content, queue_type, workflow_execution_id, workflow_payload, status)
          // params: [id, workflowExecutionId, workflowPayload, status]
          row = {
            id: String(params[0] ?? ''),
            content: '',
            attachments: null,
            model: null,
            queue_type: 'workflow_execute',
            workflow_execution_id: (params[1] as string) || null,
            workflow_payload: (params[2] as string) || null,
            status: String(params[3] ?? 'queued'),
            author_id: null,
            author_email: null,
            author_name: null,
            author_avatar_url: null,
            channel_type: null,
            channel_id: null,
            channel_key: null,
            thread_id: null,
            continuation_context: null,
            context_prefix: null,
            reply_channel_type: null,
            reply_channel_id: null,
            child_session_id: null,
            child_status: null,
            priority: 0,
            replaceable: 1,
            received_at: typeof params[4] === 'number' ? params[4] : Date.now(),
            dispatched_at: null,
            created_at: insertCounter,
          };
        } else {
          row = {
            id: String(params[0] ?? ''),
            content: String(params[1] ?? ''),
            attachments: (params[2] as string) || null,
            model: (params[3] as string) || null,
            queue_type: 'prompt',
            workflow_execution_id: null,
            workflow_payload: null,
            status: String(params[4] ?? 'queued'),
            author_id: (params[5] as string) || null,
            author_email: (params[6] as string) || null,
            author_name: (params[7] as string) || null,
            author_avatar_url: (params[8] as string) || null,
            channel_type: (params[9] as string) || null,
            channel_id: (params[10] as string) || null,
            channel_key: (params[11] as string) || null,
            thread_id: (params[12] as string) || null,
            continuation_context: (params[13] as string) || null,
            context_prefix: (params[14] as string) || null,
            reply_channel_type: (params[15] as string) || null,
            reply_channel_id: (params[16] as string) || null,
            child_session_id: (params[17] as string) || null,
            child_status: (params[18] as string) || null,
            priority: typeof params[19] === 'number' ? params[19] : 0,
            replaceable: typeof params[20] === 'number' ? params[20] : 1,
            received_at: typeof params[21] === 'number' ? params[21] : Date.now(),
            dispatched_at: null,
            created_at: insertCounter,
          };
        }
        queue.set(row.id, row);
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM prompt_queue')) {
        let rows = Array.from(queue.values());
        // Honor `WHERE id = ?` for single-row lookups (getChannelKeyById,
        // getReceivedAtById, getModelById, etc.). The bind param is the
        // first one in these queries. Without this filter the mock returned
        // the FIRST inserted row for every getXxxById call, silently masking
        // bugs in any code that resolves state by messageId.
        if (q.includes('WHERE id = ?') || q.includes(' AND id = ?')) {
          const targetId = String(params[0]);
          rows = rows.filter((row) => row.id === targetId);
        }
        if (q.includes("status = 'queued'")) {
          rows = rows.filter((row) => row.status === 'queued');
        } else if (q.includes("status = 'processing'")) {
          rows = rows.filter((row) => row.status === 'processing');
        } else if (q.includes("status = 'completed'")) {
          rows = rows.filter((row) => row.status === 'completed');
        }

        if (q.includes("queue_type = 'prompt'")) {
          rows = rows.filter((row) => row.queue_type === 'prompt');
        }

        if (q.includes('child_session_id IS NULL')) {
          rows = rows.filter((row) => row.child_session_id === null);
        }

        if (q.includes('replaceable = 1')) {
          rows = rows.filter((row) => row.replaceable === 1);
        }

        // Honor `channel_key = ?` in SELECTs (used by /clear-queue thread scoping
        // and other channel-scoped lookups). The bind param appears at the end.
        if (q.includes('channel_key = ?') && !q.includes('FROM channel_state')) {
          const ck = String(params[params.length - 1]);
          rows = rows.filter((row) => row.channel_key === ck);
        }

        // Honor `id NOT IN (?, ?, ...)` used by dequeueNext's exclude path.
        const notInMatch = q.match(/id NOT IN \(([?,\s]+)\)/);
        if (notInMatch) {
          const placeholderCount = (notInMatch[1].match(/\?/g) ?? []).length;
          const excluded = new Set(
            params.slice(0, placeholderCount).map((p) => String(p)),
          );
          rows = rows.filter((row) => !excluded.has(String(row.id)));
        }

        if (q.includes('COUNT(*)')) {
          return cursor([{ count: rows.length, c: rows.length }]);
        }

        // Aggregates over dispatched_at — used by lastPromptDispatchedAt
        // (MAX) and getOldestProcessingDispatchedAt (MIN).
        if (q.includes('MAX(dispatched_at)')) {
          const ts = rows
            .filter((r) => r.dispatched_at !== null)
            .reduce<number | null>((max, r) => Math.max(max ?? 0, r.dispatched_at as number), null);
          return cursor([{ ts }]);
        }
        if (q.includes('MIN(dispatched_at)')) {
          const filtered = rows.filter((r) => r.dispatched_at !== null);
          const ts = filtered.length === 0
            ? null
            : filtered.reduce<number>((min, r) => Math.min(min, r.dispatched_at as number), Infinity);
          return cursor([{ ts: ts === Infinity ? null : ts }]);
        }

        // SELECT id ... ORDER BY dispatched_at ASC — getStuckProcessingMessageId.
        if (q.includes('ORDER BY dispatched_at ASC')) {
          let filtered = rows.filter((r) => r.dispatched_at !== null);
          if (q.includes('dispatched_at <= ?')) {
            const cutoff = Number(params[params.length - 1]);
            filtered = filtered.filter((r) => (r.dispatched_at as number) <= cutoff);
          }
          filtered.sort((a, b) => (a.dispatched_at as number) - (b.dispatched_at as number));
          return cursor(filtered.slice(0, 1));
        }

        // SELECT DISTINCT channel_key — armIdleQueuedSinceForAllQueuedChannels.
        if (q.includes('SELECT DISTINCT channel_key')) {
          const seen = new Set<string>();
          const out: Array<{ channel_key: string }> = [];
          for (const r of rows) {
            if (r.channel_key && !seen.has(r.channel_key)) {
              seen.add(r.channel_key);
              out.push({ channel_key: r.channel_key });
            }
          }
          return cursor(out);
        }

        // SELECT DISTINCT thread_id — handleAbort's per-thread fan-out.
        if (q.includes('SELECT DISTINCT thread_id')) {
          const seen = new Set<string | null>();
          const out: Array<{ thread_id: string | null }> = [];
          for (const r of rows) {
            const key = r.thread_id ?? null;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ thread_id: r.thread_id ?? null });
            }
          }
          return cursor(out);
        }

        if (q.includes('ORDER BY created_at DESC')) {
          rows.sort((a, b) => b.created_at - a.created_at);
        } else if (q.includes('ORDER BY priority DESC, created_at ASC')) {
          rows.sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
        } else if (q.includes('ORDER BY created_at ASC')) {
          rows.sort((a, b) => a.created_at - b.created_at);
        }

        if (q.includes('LIMIT 2') && rows.length > 2) {
          rows = rows.slice(0, 2);
        } else if (q.includes('LIMIT 1') && rows.length > 1) {
          rows = [rows[0]];
        }

        return cursor(rows);
      }

      if (q.startsWith('UPDATE prompt_queue')) {
        if (q.includes('SET dispatched_at = ?')) {
          const ts = Number(params[0]);
          const row = queue.get(String(params[1]));
          if (row) row.dispatched_at = ts;
        } else if (q.includes("SET status = 'completed' WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') row.status = 'completed';
          }
        } else if (q.includes("SET status = 'queued'") && q.includes("WHERE status = 'processing'")) {
          for (const row of queue.values()) {
            if (row.status === 'processing') {
              row.status = 'queued';
              if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
            }
          }
        } else if (q.includes("SET status = 'queued'") && q.includes('WHERE id = ?')) {
          const row = queue.get(String(params[0]));
          if (row) {
            row.status = 'queued';
            if (q.includes('dispatched_at = NULL')) row.dispatched_at = null;
          }
        } else if (q.includes("SET status = 'processing' WHERE id = ?")) {
          const row = queue.get(String(params[0]));
          if (row) row.status = 'processing';
        } else if (q.includes("SET status = 'completed' WHERE id = ?")) {
          const row = queue.get(String(params[0]));
          if (row) row.status = 'completed';
        }
        return cursor([]);
      }

      if (q.startsWith('DELETE FROM prompt_queue')) {
        if (q.includes("status = 'completed'")) {
          for (const [id, row] of queue.entries()) {
            if (row.status === 'completed') queue.delete(id);
          }
        } else if (q.includes("status = 'queued' AND channel_key = ?")) {
          const channelKey = String(params[0]);
          for (const [id, row] of queue.entries()) {
            if (row.status === 'queued' && row.channel_key === channelKey) queue.delete(id);
          }
        } else if (q.includes("status = 'queued'")) {
          for (const [id, row] of queue.entries()) {
            if (row.status === 'queued') queue.delete(id);
          }
        } else if (q.includes('WHERE id = ?')) {
          queue.delete(String(params[0]));
        } else {
          queue.clear();
        }
        return cursor([]);
      }

      if (q.startsWith('INSERT INTO interactive_prompts') || q.startsWith('INSERT OR REPLACE INTO interactive_prompts')) {
        const hasBodyColumn = q.includes('body, actions');
        interactivePrompts.set(String(params[0]), {
          id: String(params[0]),
          type: String(q.includes("'approval'") ? 'approval' : 'question'),
          request_id: (params[1] as string) || null,
          title: String(params[2] ?? ''),
          body: hasBodyColumn ? String(params[3] ?? '') : null,
          actions: String(params[hasBodyColumn ? 4 : 3] ?? ''),
          context: String(params[hasBodyColumn ? 5 : 4] ?? ''),
          status: 'pending',
          expires_at: typeof params[hasBodyColumn ? 6 : 5] === 'number' ? params[hasBodyColumn ? 6 : 5] as number : null,
          channel_refs: null,
        });
        return cursor([]);
      }

      if (q.startsWith('SELECT') && q.includes('FROM interactive_prompts')) {
        if (q.includes('WHERE id = ?')) {
          const row = interactivePrompts.get(String(params[0]));
          if (!row) return cursor([]);
          if (q.includes("status = 'pending'") && row.status !== 'pending') return cursor([]);
          return cursor([row]);
        }
        let rows = Array.from(interactivePrompts.values());
        if (q.includes("status = 'pending'")) {
          rows = rows.filter((row) => row.status === 'pending');
        }
        if (q.includes('expires_at IS NOT NULL') && typeof params[0] === 'number') {
          rows = rows.filter((row) => row.expires_at !== null && row.expires_at <= Number(params[0]));
        }
        return cursor(rows);
      }

      if (q.startsWith("UPDATE interactive_prompts SET status = 'resolving'")) {
        const row = interactivePrompts.get(String(params[0]));
        if (row?.status === 'pending') {
          row.status = 'resolving';
          return cursor(q.includes('RETURNING') ? [{ id: row.id }] : []);
        }
        return cursor([]);
      }

      if (q.startsWith("UPDATE interactive_prompts SET status = 'pending'")) {
        const row = interactivePrompts.get(String(params[0]));
        if (row?.status === 'resolving') row.status = 'pending';
        return cursor([]);
      }

      if (q.startsWith('UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?')) {
        const row = interactivePrompts.get(String(params[1]));
        if (row) row.channel_refs = (params[0] as string) || null;
        return cursor([]);
      }

      if (q.startsWith('DELETE FROM interactive_prompts')) {
        interactivePrompts.delete(String(params[0]));
        return cursor([]);
      }

      return cursor([]);
    },
  } as unknown as SqlStorage & {
    queue: Map<string, QueueRow>;
    state: Map<string, string>;
    interactivePrompts: Map<string, InteractivePromptRow>;
    messages: Map<string, Record<string, unknown>>;
    channelState: Map<string, { busy: number; opencode_session_id: string | null; idle_queued_since: number | null; error_safety_net_at: number | null }>;
  };
}

export function createMockCtx() {
  const sql = createMockSql();
  let initPromise: Promise<void> = Promise.resolve();
  const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
  const acceptedSockets: Array<{ socket: unknown; tags: string[] }> = [];

  const ctx = {
    storage: {
      sql,
      setAlarm: vi.fn(),
      getAlarm: vi.fn(),
    },
    blockConcurrencyWhile(fn: () => Promise<void>) {
      initPromise = Promise.resolve(fn());
      return initPromise;
    },
    acceptWebSocket(socket: unknown, tags: string[]) {
      acceptedSockets.push({ socket, tags });
    },
    getWebSockets: vi.fn(() => []),
    getTags(socket: unknown) {
      return acceptedSockets.find((entry) => entry.socket === socket)?.tags ?? [];
    },
    waitUntil,
  } as unknown as DurableObjectState;

  return { ctx, sql, waitUntil, initPromise: () => initPromise, acceptedSockets };
}

export function createMockDb(options?: {
  threadRow?: { session_id?: string | null; opencode_session_id?: string | null } | null;
  threadMessages?: Array<{ role?: string; content?: string }>;
  // Explicit return type keeps the emitted declaration portable (TS2742).
}): { prepare: Mock } {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(
          query.includes('FROM session_threads')
            ? (options?.threadRow ?? null)
            : null
        ),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({
          results: query.includes('FROM messages')
            ? (options?.threadMessages ?? [])
            : [],
        }),
      })),
    })),
  };
}

export async function createTestAgent(opts?: {
  sockets?: Array<{ send: ReturnType<typeof vi.fn> }>;
  dbOptions?: {
    threadRow?: { session_id?: string | null; opencode_session_id?: string | null } | null;
    threadMessages?: Array<{ role?: string; content?: string }>;
  };
}) {
  const { ctx, sql, waitUntil, initPromise } = createMockCtx();
  const sockets = opts?.sockets ?? [];
  (ctx.getWebSockets as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sockets);

  const agent = new SessionAgentDO(ctx, { DB: createMockDb(opts?.dbOptions) } as any);
  await initPromise();

  (agent as any).sessionState.set('sessionId', 'orchestrator:user-1');
  (agent as any).sessionState.set('userId', 'user-1');
  (agent as any).sessionState.set('status', 'running');

  const broadcasts: Array<Record<string, unknown>> = [];
  (agent as any).broadcastToClients = vi.fn((message: Record<string, unknown>) => {
    broadcasts.push(message);
  });
  (agent as any).sendChannelInteractivePrompts = vi.fn().mockResolvedValue(undefined);
  (agent as any).notifyEventBus = vi.fn();
  (agent as any).emitEvent = vi.fn();
  (agent as any).emitAuditEvent = vi.fn();
  (agent as any).flushMessagesToD1 = vi.fn().mockResolvedValue(undefined);
  (agent as any).isUserConnected = vi.fn().mockReturnValue(true);
  (agent as any).sendToastToUser = vi.fn();
  (agent as any).enqueueOwnerNotification = vi.fn().mockResolvedValue(undefined);
  (agent as any).getUserDetails = vi.fn().mockResolvedValue(undefined);
  (agent as any).resolveModelPreferences = vi.fn().mockResolvedValue([]);
  (agent as any).rescheduleIdleAlarm = vi.fn();
  (agent as any).lifecycle.touchActivity = vi.fn();

  return { agent, sql, waitUntil, broadcasts, ctx, sockets };
}

