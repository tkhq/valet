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
import { capOutput } from "./mcp-output.js";

/** One in-process call to an `/api` route as the verified MCP user. */
export type ApiCaller = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

export interface McpToolDeps {
  api: ApiCaller;
  engineStore: Pick<Providers["engineStore"], "getQueueItem">;
  /** The newest queue item (turn) in a thread, or the newest with `status`. Callers pass ids an authorized route returned. */
  latestQueueItem: (sessionId: string, threadId: string, status?: "running" | "blocked_on_decision_gate") => Promise<string | undefined>;
  /** Public origin for thread links, e.g. `https://valet.example.com`. */
  origin: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// An ingress often ends a request after 60 seconds (nginx's default), and the
// turn keeps running when it does. Waits stay under that; the agent calls
// get_thread again to keep waiting.
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 55;
const POLL_MS = 1_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_MERGE_HOPS = 5;
/** A stopped turn settles in well under a second; this bounds the report wait. */
const STOP_WAIT_SECONDS = 5;

class ApiError extends Error {}

/** The workspace id the routes accept: `user` or a team id. */
const workspaceArg = z.string().min(1).optional()
  .describe('Workspace to use: "user" for your personal workspace, or a team id from list_workspaces. Default: "user".');
const waitArg = z.number().int().min(0).max(MAX_WAIT_SECONDS).optional()
  .describe(`Seconds to wait for the assistant to finish (0-${MAX_WAIT_SECONDS}). Default: ${DEFAULT_WAIT_SECONDS}. If the turn is still running when the wait ends, call get_thread to wait again.`);

function ok(value: unknown, capNote?: string): CallToolResult {
  const capped = capOutput(value, capNote);
  return { content: [{ type: "text", text: JSON.stringify(capped, null, 2) }], structuredContent: capped };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(status: number, body: unknown, what: string): string {
  const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
  if (status === 404 && (what === "Thread" || what === "Workspace")) {
    return `${what} not found, or you do not have access to it. Use list_threads or list_workspaces to find a valid id.`;
  }
  if (status === 404 && detail) return detail;
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

/** One turn's messages, newest last, via the messages route's queue item filter. */
async function turnMessages(deps: McpToolDeps, threadId: string, queueItemId: string): Promise<Message[]> {
  const res = await call<ListMessagesResponse>(deps, "GET",
    `/api/threads/${encodeURIComponent(threadId)}/messages?limit=50&queueItemId=${encodeURIComponent(queueItemId)}`, "Thread");
  return res.messages;
}

/** The final assistant text for a queue item: its last `end_turn` entry, else its last assistant entry. */
function replyFor(messages: Message[], queueItemId: string): string | undefined {
  const mine = messages.filter((m) => m.role === "assistant" && m.queueItemId === queueItemId && m.content.trim() !== "");
  const final = mine.filter((m) => m.stopReason === "end_turn").at(-1) ?? mine.at(-1);
  return final ? clip(final.content) : undefined;
}

/**
 * The status of one prompt. `command_ran` means the text was a slash command:
 * the route ran it at once and started no assistant turn, so there is no
 * reply to wait for.
 */
export type TurnStatus = "completed" | "failed" | "aborted" | "superseded" | "waiting_for_decision" | "running" | "command_ran";

/** Every status `waitForTurn` returns, for tool descriptions. */
const TURN_STATUSES =
  "completed (the turn finished; reply has the answer), failed (error says why), aborted (a person or stop_thread stopped the turn), " +
  "superseded (a newer message replaced the turn), waiting_for_decision (answer pending_decisions with resolve_decision), " +
  "or running (the wait ended first; call get_thread with wait_seconds to wait again)";
const COMMAND_STATUS = "command_ran (the prompt was a slash command, so no turn started; call get_thread to see its effect)";
const IDLE_STATUS = "idle (the thread has no turns)";

export interface TurnView {
  thread_id: string;
  /** The queue item of the turn. Absent for `command_ran`, which starts no turn. */
  message_id?: string;
  status: TurnStatus;
  reply?: string;
  error?: string;
  /** What happened, for a status with no reply. */
  message?: string;
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
      const reply = replyFor(await turnMessages(deps, opts.threadId, itemId), itemId);
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
    return {
      thread_id: threadId,
      status: "command_ran",
      message: "Valet ran the prompt as a slash command, and no assistant turn started. Call get_thread to see its effect.",
      url: threadUrl(deps, threadId),
    };
  }
  return waitForTurn(deps, { sessionId, threadId, queueItemId: sent.messageId, waitSeconds });
}

/** `capNote` tells the agent how to get the rest of a result that `capOutput` shortened. */
function run<A>(fn: (args: A) => Promise<unknown>, capNote?: string): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args), capNote);
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
    }, "Set a smaller limit or a query to see fewer threads."),
  );

  server.registerTool(
    "start_thread",
    {
      description:
        "Delegates a task to the Valet assistant in a new thread and, by default, waits for its reply. " +
        "Write the prompt as a complete brief: goal, context, repository, constraints, and what done looks like. " +
        `Result status: ${TURN_STATUSES}, or ${COMMAND_STATUS}.`,
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
      description:
        "Sends a follow-up message to an existing thread and, by default, waits for the assistant's reply. " +
        `Result status: ${TURN_STATUSES}, or ${COMMAND_STATUS}.`,
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
        "With wait_seconds above 0, it first waits for the latest turn to finish. " +
        `Status of the latest turn: ${TURN_STATUSES}, or ${IDLE_STATUS}.`,
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
      // The newest turn comes from the queue, not the message window: a long
      // tool-heavy turn pushes its own prompt out of the last 50 messages.
      const latest = await deps.latestQueueItem(sessionId, thread_id);
      const turn = latest
        ? await waitForTurn(deps, { sessionId, threadId: thread_id, queueItemId: latest, waitSeconds: wait_seconds ?? 0 })
        : undefined;
      const shown = turn && wait_seconds ? await threadMessages(deps, thread_id, 50) : recent;
      return {
        thread_id,
        status: turn?.status ?? "idle",
        ...(turn?.reply ? { reply: turn.reply } : {}),
        ...(turn?.error ? { error: turn.error } : {}),
        ...(turn?.pending_decisions ? { pending_decisions: turn.pending_decisions } : {}),
        messages: shown.slice(-(messages ?? 10)).map(messageView),
        url: threadUrl(deps, thread_id),
      };
    }, "Set messages to a smaller number to see fewer, or open the thread url."),
  );

  server.registerTool(
    "stop_thread",
    {
      description:
        "Stops the thread's active turn, for example a delegated task that went the wrong way. " +
        "Work the turn already did is not undone. Send a follow-up with send_message to redirect it. " +
        `Result status: ${TURN_STATUSES}, or ${IDLE_STATUS}.`,
      inputSchema: { thread_id: z.string().min(1).describe("Thread id from start_thread or list_threads.") },
      annotations: { destructiveHint: true },
    },
    run(async ({ thread_id }: { thread_id: string }) => {
      const sessionId = await sessionOf(deps, thread_id);
      // Stop the active turn, as the web Stop button does. A follow-up queued
      // behind it is newer, so "newest" alone would stop the wrong turn.
      const target = await deps.latestQueueItem(sessionId, thread_id, "running")
        ?? await deps.latestQueueItem(sessionId, thread_id, "blocked_on_decision_gate")
        ?? await deps.latestQueueItem(sessionId, thread_id);
      if (!target) return { thread_id, status: "idle", url: threadUrl(deps, thread_id) };
      // The route stops only the named turn, so a turn queued after this
      // read is never stopped by mistake.
      await call<unknown>(deps, "POST", `/api/threads/${encodeURIComponent(thread_id)}/abort`, "Thread", { targetItemId: target });
      return waitForTurn(deps, { sessionId, threadId: thread_id, queueItemId: target, waitSeconds: STOP_WAIT_SECONDS });
    }),
  );

  server.registerTool(
    "search_tools",
    {
      description:
        "Searches the integrations Valet brokers for you (GitHub, Slack, Linear, Google, and the MCP servers your org connects). " +
        "Returns tool_ids for describe_tool and call_tool. Valet holds the credentials; you never see them.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Text to match against tool ids, names, and descriptions, e.g. \"create issue\"."),
        service: z.string().min(1).optional().describe("Only this service, e.g. \"github\" or \"linear\"."),
        workspace: workspaceArg,
        limit: z.number().int().min(1).max(100).optional().describe("Maximum tools to return. Default: 25."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ query, service, workspace, limit }: { query?: string; service?: string; workspace?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (service) params.set("service", service);
      if (workspace && workspace !== "user") params.set("workspace", workspace);
      if (limit) params.set("limit", String(limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return call<unknown>(deps, "GET", `/api/actions${suffix}`, "Tool search");
    }, "Set a smaller limit, a more specific query, or a service to see fewer tools."),
  );

  server.registerTool(
    "describe_tool",
    {
      description:
        "Returns one tool's description, JSON Schema parameters, and the policy that applies to you: " +
        "allow (call_tool runs it), require_approval (a person must approve), or deny.",
      inputSchema: {
        tool_id: z.string().min(1).describe("A tool_id from search_tools, e.g. \"github.create_issue\"."),
        params: z.record(z.string(), z.unknown()).optional()
          .describe("The params you plan to call with. A policy can depend on them, so pass them to check the policy for that exact call."),
        workspace: workspaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ tool_id, params, workspace }: { tool_id: string; params?: Record<string, unknown>; workspace?: string }) => {
      const q = new URLSearchParams();
      if (workspace && workspace !== "user") q.set("workspace", workspace);
      if (params) q.set("params", JSON.stringify(params));
      const suffix = q.size > 0 ? `?${q.toString()}` : "";
      return call<unknown>(deps, "GET", `/api/actions/${encodeURIComponent(tool_id)}${suffix}`, "Tool");
    }, "The tool description is too long to return in full. If call_tool rejects your params, its error names the problem."),
  );

  server.registerTool(
    "call_tool",
    {
      description:
        "Runs a tool through Valet with the workspace's credentials and policies. " +
        "Call describe_tool first for the parameter schema. Results: completed (with result), failed (with error), " +
        "approval_required (the action did not run; next_step says what to do), or in_progress (an earlier call with the " +
        "same idempotency_key and params is still running; call again later with the same key).",
      inputSchema: {
        tool_id: z.string().min(1).describe("A tool_id from search_tools."),
        params: z.record(z.string(), z.unknown()).optional().describe("Arguments matching the tool's parameter schema."),
        workspace: workspaceArg,
        idempotency_key: z.string().min(1).max(200).optional()
          .describe("Reuse the same key with the same params to retry safely: the retry returns the first result instead of running the tool again. A failed call is not kept, so a retry after a failure runs again."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    run(async ({ tool_id, params, workspace, idempotency_key }: { tool_id: string; params?: Record<string, unknown>; workspace?: string; idempotency_key?: string }) =>
      call<unknown>(deps, "POST", `/api/actions/${encodeURIComponent(tool_id)}/invoke`, "Tool", {
        params: params ?? {},
        ...(workspace ? { workspace } : {}),
        ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
      }), "The tool returned more than Valet can pass back. To get the rest, call it again with narrower params, such as a filter, a smaller limit, or a page."),
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
        "Answers a pending question, then, by default, waits for the turn that asked it to continue. " +
        "Send the action_id of one of its options, or value for a typed answer. " +
        "Use gate_id and action_id exactly as list_decisions or a waiting_for_decision result returned them. " +
        "Approvals and credential requests need a person: give them the thread url instead. " +
        `Result status: ${TURN_STATUSES}, or ${IDLE_STATUS}.`,
      inputSchema: {
        thread_id: z.string().min(1).describe("Thread id."),
        gate_id: z.string().min(1).describe("The decision's gate_id."),
        action_id: z.string().min(1).optional().describe("The chosen option's action_id. Omit it for a typed answer."),
        value: z.string().optional().describe("A typed answer. Send it when the question has no options or accepts free text."),
        wait_seconds: waitArg,
      },
      annotations: { destructiveHint: false },
    },
    run(async ({ thread_id, gate_id, action_id, value, wait_seconds }: { thread_id: string; gate_id: string; action_id?: string; value?: string; wait_seconds?: number }) => {
      if (action_id === undefined && value === undefined) {
        throw new ApiError("Send action_id for one of the question's options, or value for a typed answer.");
      }
      const sessionId = await sessionOf(deps, thread_id);
      // Wait on the turn the question blocked, read before the answer
      // unblocks it. A follow-up queued behind it is newer.
      const blocked = await deps.latestQueueItem(sessionId, thread_id, "blocked_on_decision_gate");
      await call<unknown>(deps, "POST", `/api/threads/${encodeURIComponent(thread_id)}/decisions/${encodeURIComponent(gate_id)}/resolve`, "Decision",
        { ...(action_id !== undefined ? { actionId: action_id } : {}), ...(value !== undefined ? { value } : {}) });
      const latest = blocked ?? await deps.latestQueueItem(sessionId, thread_id);
      if (!latest) return { thread_id, status: "idle", url: threadUrl(deps, thread_id) };
      return waitForTurn(deps, { sessionId, threadId: thread_id, queueItemId: latest, waitSeconds: wait_seconds ?? DEFAULT_WAIT_SECONDS });
    }),
  );
}
