/**
 * Agent-facing MCP tools (`docs/specs/2026-10-07-mcp-agent-tools-design.md`).
 *
 * A local agent (Claude Code, Codex, Cursor) uses these tools to delegate
 * work to a Valet workspace, follow the result, and answer the decisions the
 * assistant raises. Every tool calls the app's own `/api` routes through
 * `ApiCaller` as the OAuth-verified user, so the routes keep sole ownership
 * of access control. The tools only reshape requests and responses.
 *
 * `wait_seconds` waits on the server. The tool reads the queue item and the
 * thread's pending decisions until the turn settles, the turn stops on a
 * decision, or the time runs out. A timed-out wait is not an error: the
 * result says `running`, and the agent calls `get_thread` to wait again.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Providers } from "../providers/types.js";
import { z } from "zod";
import type {
  CreateThreadResponse,
  DecisionGate,
  GetMeResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListTeamsResponse,
  ListThreadsResponse,
  Message,
  SendPromptResponse,
  ThreadSummary,
} from "../wire/types.js";

/** One in-process call to an `/api` route as the verified MCP user. */
export type ApiCaller = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

export interface McpToolDeps {
  api: ApiCaller;
  engineStore: Pick<Providers["engineStore"], "getQueueItem">;
  /** Public origin for thread links, e.g. `https://valet.example.com`. */
  origin: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const POLL_MS = 1_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_MERGE_HOPS = 5;

class ApiError extends Error {}

/** The workspace id the routes accept: `user` or a team id. */
const workspaceArg = z.string().min(1).optional()
  .describe('Workspace to use: "user" for your personal workspace, or a team id from list_workspaces. Default: "user".');
const waitArg = z.number().int().min(0).max(MAX_WAIT_SECONDS).optional()
  .describe(`Seconds to wait for the assistant to finish (0-${MAX_WAIT_SECONDS}). Default: ${DEFAULT_WAIT_SECONDS}. If the turn is still running when the wait ends, call get_thread to wait again.`);

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(status: number, body: unknown, what: string): string {
  const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
  if (status === 404) return `${what} not found, or you do not have access to it. Use list_threads or list_workspaces to find a valid id.`;
  if (status === 403) return detail ?? `You do not have permission for this ${what.toLowerCase()}.`;
  return detail ? `${what} request failed (${status}): ${detail}` : `${what} request failed with status ${status}.`;
}

async function call<T>(deps: McpToolDeps, method: "GET" | "POST", path: string, what: string, body?: unknown): Promise<T> {
  const res = await deps.api(method, path, body);
  if (res.status < 200 || res.status >= 300) throw new ApiError(errorText(res.status, res.body, what));
  return res.body as T;
}

function wsQuery(workspace: string | undefined): string {
  return workspace && workspace !== "user" ? `?workspace=${encodeURIComponent(workspace)}` : "";
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated ${text.length - MAX_TEXT_CHARS} characters]` : text;
}

function threadUrl(deps: McpToolDeps, threadId: string): string {
  return `${deps.origin}/threads/${encodeURIComponent(threadId)}`;
}

function gateView(gate: DecisionGate) {
  return {
    gate_id: gate.id,
    type: gate.type,
    title: gate.title,
    ...(gate.body ? { body: clip(gate.body) } : {}),
    options: gate.actions.map((action) => ({ action_id: action.id, label: action.label })),
  };
}

function messageView(message: Message) {
  const tools = message.parts.filter((part) => part.kind === "tool_call").length;
  return {
    id: message.id,
    role: message.role,
    text: clip(message.content),
    created_at: new Date(message.createdAt).toISOString(),
    ...(tools > 0 ? { tool_calls: tools } : {}),
  };
}

async function pendingGates(deps: McpToolDeps, threadId: string): Promise<DecisionGate[]> {
  const res = await call<ListDecisionsResponse>(deps, "GET", `/api/threads/${encodeURIComponent(threadId)}/decisions`, "Thread");
  return res.gates.filter((gate) => gate.status === "pending");
}

async function threadMessages(deps: McpToolDeps, threadId: string, limit: number): Promise<Message[]> {
  const res = await call<ListMessagesResponse>(deps, "GET", `/api/threads/${encodeURIComponent(threadId)}/messages?limit=${limit}`, "Thread");
  return res.messages;
}

/** The final assistant text for a queue item: its last `end_turn` entry, else its last assistant entry. */
function replyFor(messages: Message[], queueItemId: string): string | undefined {
  const mine = messages.filter((m) => m.role === "assistant" && m.queueItemId === queueItemId && m.content.trim() !== "");
  const final = mine.filter((m) => m.stopReason === "end_turn").at(-1) ?? mine.at(-1);
  return final ? clip(final.content) : undefined;
}

export type TurnStatus = "completed" | "failed" | "aborted" | "superseded" | "waiting_for_decision" | "running";

export interface TurnView {
  thread_id: string;
  message_id: string;
  status: TurnStatus;
  reply?: string;
  error?: string;
  pending_decisions?: ReturnType<typeof gateView>[];
  url: string;
}

/**
 * Wait on the server for one submission. The routes already authorized
 * `sessionId` and `queueItemId` (they came from this caller's own send or
 * message list), so reading the queue item directly widens no access.
 */
export async function waitForTurn(
  deps: McpToolDeps,
  opts: { sessionId: string; threadId: string; queueItemId: string; waitSeconds: number },
): Promise<TurnView> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + opts.waitSeconds * 1000;
  let itemId = opts.queueItemId;
  let hops = 0;
  const base = { thread_id: opts.threadId, message_id: opts.queueItemId, url: threadUrl(deps, opts.threadId) };

  for (;;) {
    const item = await deps.engineStore.getQueueItem(opts.sessionId, itemId);
    if (item?.status === "settled") {
      const outcome = item.outcome ?? { outcome: "failed" as const, error: "The turn settled without a recorded outcome." };
      if (outcome.outcome === "merged" && item.mergedIntoItemId && hops < MAX_MERGE_HOPS) {
        itemId = item.mergedIntoItemId;
        hops += 1;
        continue;
      }
      const status: TurnStatus = outcome.outcome === "merged" ? "completed" : outcome.outcome;
      const reply = replyFor(await threadMessages(deps, opts.threadId, 50), itemId);
      return { ...base, status, ...(reply ? { reply } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
    }
    const gates = await pendingGates(deps, opts.threadId);
    if (gates.length > 0) {
      return { ...base, status: "waiting_for_decision", pending_decisions: gates.map(gateView) };
    }
    if (now() >= deadline) return { ...base, status: "running" };
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

async function sessionOf(deps: McpToolDeps, threadId: string): Promise<string> {
  const thread = await call<{ sessionId: string }>(deps, "GET", `/api/threads/${encodeURIComponent(threadId)}`, "Thread");
  return thread.sessionId;
}

async function sendAndWait(deps: McpToolDeps, threadId: string, prompt: string, waitSeconds: number): Promise<TurnView> {
  const sessionId = await sessionOf(deps, threadId);
  const sent = await call<SendPromptResponse>(deps, "POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, "Thread", { text: prompt });
  if (sent.messageId === null) {
    return { thread_id: threadId, message_id: "", status: "completed", reply: "The text ran as a slash command. Call get_thread to read its result.", url: threadUrl(deps, threadId) };
  }
  return waitForTurn(deps, { sessionId, threadId, queueItemId: sent.messageId, waitSeconds });
}

function run<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message);
      throw err;
    }
  };
}

export function registerAgentTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "list_workspaces",
    {
      description: "Lists the Valet workspaces you can delegate work to: your personal workspace and the teams you belong to.",
      annotations: { readOnlyHint: true },
    },
    run(async () => {
      const me = await call<GetMeResponse>(deps, "GET", "/api/me", "Profile");
      const teams = await call<ListTeamsResponse>(deps, "GET", "/api/teams", "Teams");
      return {
        workspaces: [
          { workspace: "user", name: "Personal", ...("name" in me && me.name ? { owner: me.name } : {}) },
          ...teams.teams.filter((team) => team.callerRole !== null).map((team) => ({ workspace: team.id, name: team.name, kind: "team" })),
        ],
      };
    }),
  );

  server.registerTool(
    "list_threads",
    {
      description: "Lists recent threads (conversations) in a workspace, newest activity first. Use the thread id with get_thread or send_message.",
      inputSchema: {
        workspace: workspaceArg,
        query: z.string().min(1).optional().describe("Only threads whose title or content matches this text."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum threads to return. Default: 20."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ workspace, query, limit }: { workspace?: string; query?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (workspace && workspace !== "user") params.set("workspace", workspace);
      if (query) params.set("q", query);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const res = await call<ListThreadsResponse>(deps, "GET", `/api/threads${suffix}`, "Workspace");
      const threads = [...res.threads]
        .sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt)
        .slice(0, limit ?? 20)
        .map((t: ThreadSummary) => ({
          thread_id: t.id,
          title: t.title ?? null,
          last_activity: new Date(t.lastUserActivityAt).toISOString(),
          url: threadUrl(deps, t.id),
        }));
      return { threads };
    }),
  );

  server.registerTool(
    "start_thread",
    {
      description:
        "Delegates a task to the Valet assistant in a new thread and, by default, waits for its reply. " +
        "Write the prompt as a complete brief: goal, context, repository, constraints, and what done looks like. " +
        "If the result status is waiting_for_decision, answer with resolve_decision. If it is running, call get_thread later.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task for the assistant, written as a self-contained brief."),
        workspace: workspaceArg,
        title: z.string().min(1).max(200).optional().describe("Thread title. Default: generated from the conversation."),
        wait_seconds: waitArg,
      },
    },
    run(async ({ prompt, workspace, title, wait_seconds }: { prompt: string; workspace?: string; title?: string; wait_seconds?: number }) => {
      const thread = await call<CreateThreadResponse>(deps, "POST", `/api/threads${wsQuery(workspace)}`, "Workspace", title ? { title } : {});
      return sendAndWait(deps, thread.id, prompt, wait_seconds ?? DEFAULT_WAIT_SECONDS);
    }),
  );

  server.registerTool(
    "send_message",
    {
      description: "Sends a follow-up message to an existing thread and, by default, waits for the assistant's reply.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Thread id from start_thread or list_threads."),
        prompt: z.string().min(1).describe("The message to send."),
        wait_seconds: waitArg,
      },
    },
    run(async ({ thread_id, prompt, wait_seconds }: { thread_id: string; prompt: string; wait_seconds?: number }) =>
      sendAndWait(deps, thread_id, prompt, wait_seconds ?? DEFAULT_WAIT_SECONDS)),
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "Reads a thread: its status, recent messages, and pending decisions. " +
        "With wait_seconds above 0, it first waits for the latest turn to finish.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Thread id from start_thread or list_threads."),
        messages: z.number().int().min(1).max(50).optional().describe("Number of recent messages to return. Default: 10."),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("Seconds to wait for the latest turn to finish. Default: 0."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ thread_id, messages, wait_seconds }: { thread_id: string; messages?: number; wait_seconds?: number }) => {
      const sessionId = await sessionOf(deps, thread_id);
      const recent = await threadMessages(deps, thread_id, 50);
      const latestUser = recent.filter((m) => m.role === "user" && m.queueItemId).at(-1);
      const turn = latestUser?.queueItemId
        ? await waitForTurn(deps, { sessionId, threadId: thread_id, queueItemId: latestUser.queueItemId, waitSeconds: wait_seconds ?? 0 })
        : undefined;
      const latest = turn && wait_seconds ? await threadMessages(deps, thread_id, 50) : recent;
      return {
        thread_id,
        status: turn?.status ?? "idle",
        ...(turn?.reply ? { reply: turn.reply } : {}),
        ...(turn?.error ? { error: turn.error } : {}),
        ...(turn?.pending_decisions ? { pending_decisions: turn.pending_decisions } : {}),
        messages: latest.slice(-(messages ?? 10)).map(messageView),
        url: threadUrl(deps, thread_id),
      };
    }),
  );

  server.registerTool(
    "list_decisions",
    {
      description: "Lists decisions (approvals and questions) waiting for you in a thread.",
      inputSchema: { thread_id: z.string().min(1).describe("Thread id.") },
      annotations: { readOnlyHint: true },
    },
    run(async ({ thread_id }: { thread_id: string }) => ({ thread_id, decisions: (await pendingGates(deps, thread_id)).map(gateView) })),
  );

  server.registerTool(
    "resolve_decision",
    {
      description:
        "Answers a pending decision (an approval or a question) with one of its options, then, by default, waits for the turn to continue. " +
        "Use the gate_id and action_id exactly as list_decisions or a waiting_for_decision result returned them.",
      inputSchema: {
        thread_id: z.string().min(1).describe("Thread id."),
        gate_id: z.string().min(1).describe("The decision's gate_id."),
        action_id: z.string().min(1).describe("The chosen option's action_id."),
        value: z.string().optional().describe("Free-text answer, for questions that accept one."),
        wait_seconds: waitArg,
      },
      annotations: { destructiveHint: false },
    },
    run(async ({ thread_id, gate_id, action_id, value, wait_seconds }: { thread_id: string; gate_id: string; action_id: string; value?: string; wait_seconds?: number }) => {
      const sessionId = await sessionOf(deps, thread_id);
      await call<unknown>(deps, "POST", `/api/threads/${encodeURIComponent(thread_id)}/decisions/${encodeURIComponent(gate_id)}/resolve`, "Decision",
        { actionId: action_id, ...(value !== undefined ? { value } : {}) });
      const recent = await threadMessages(deps, thread_id, 50);
      const latestUser = recent.filter((m) => m.role === "user" && m.queueItemId).at(-1);
      if (!latestUser?.queueItemId) return { thread_id, status: "idle", url: threadUrl(deps, thread_id) };
      return waitForTurn(deps, { sessionId, threadId: thread_id, queueItemId: latestUser.queueItemId, waitSeconds: wait_seconds ?? DEFAULT_WAIT_SECONDS });
    }),
  );
}
