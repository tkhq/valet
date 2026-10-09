/**
 * Integration tests for the agent-facing MCP tools (`mcp-tools.ts`).
 *
 * A real `bootTestApi({ auth: true })` instance, seeded OAuth access tokens,
 * and the faux model provider drive full JSON-RPC round trips over `/mcp`:
 * delegation with a server-side wait, follow-ups, thread reads, the
 * question-decision loop, and cross-user isolation. The tools reach data
 * only through the `/api` routes, so these tests also prove that route
 * access rules hold for MCP callers.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { oauthAccessToken, orgMembers, orgs, users } from "../schema/index.js";
import { seedMcpConsent } from "../integration/_mcp-consent.js";
import { attachMcpCaller } from "./mcp-caller.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;

afterEach(async () => {
  faux?.unregister();
  faux = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function seedUser(testApi: TestApi, id: string): Promise<string> {
  const { db } = testApi.providers;
  const now = Date.now();
  await db.insert(orgs).values({ id: "mcp-org", name: "MCP Org", createdAt: now }).onConflictDoNothing();
  await db.insert(users).values({ id, name: `User ${id}`, email: `${id}@nowhere.test`, role: "member", createdAt: new Date(now), updatedAt: new Date(now) });
  await db.insert(orgMembers).values({ orgId: "mcp-org", userId: id, role: "member", createdAt: now });
  const token = `token-${id}`;
  await seedMcpConsent(db, id, `client-${id}`);
  await db.insert(oauthAccessToken).values({
    id: `oauth-${id}`,
    accessToken: token,
    refreshToken: `refresh-${id}`,
    accessTokenExpiresAt: new Date(now + 600_000),
    refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: `client-${id}`,
    userId: id,
    scopes: "mcp",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  return token;
}

let rpcId = 0;
async function rpc(baseUrl: string, token: string, method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
}

interface ToolResult { isError?: boolean; text: string; data: Record<string, unknown> }

async function tool(baseUrl: string, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { result, error } = await rpc(baseUrl, token, "tools/call", { name, arguments: args });
  expect(error).toBeUndefined();
  const content = (result?.content as Array<{ type: string; text: string }> | undefined) ?? [];
  const text = content.map((c) => c.text).join("\n");
  const isError = result?.isError === true;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function boot(): Promise<TestApi> {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  api = await bootTestApi({ auth: true });
  return api;
}

describe("MCP agent tools", () => {
  it("lists the agent tools alongside the existing ones", async () => {
    const testApi = await boot();
    const token = await seedUser(testApi, "alice");
    const { result } = await rpc(testApi.baseUrl, token, "tools/list", {});
    const names = ((result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "call_tool", "cancel_workflow_run", "delete_memory", "describe_tool", "get_skill", "get_thread",
      "get_workflow_run", "list_artifacts", "list_decisions", "list_inbox", "list_sessions", "list_skills",
      "list_threads", "list_workflows", "list_workspaces", "move_memory", "patch_memory", "publish_artifact",
      "read_memory", "resolve_decision", "retry_workflow_run", "run_workflow", "search_memory", "search_tools",
      "send_message", "start_thread", "stop_thread", "unpublish_artifact", "whoami", "write_memory",
    ]);
  });

  it("delegates a task, waits on the server for the reply, and reads the thread back", async () => {
    const testApi = await boot();
    const token = await seedUser(testApi, "alice");
    faux?.appendResponses([fauxAssistantMessage("First reply from Valet"), fauxAssistantMessage("Second reply from Valet")]);

    const workspaces = await tool(testApi.baseUrl, token, "list_workspaces", {});
    expect(workspaces.data.workspaces).toEqual([expect.objectContaining({ workspace: "user", name: "Personal" })]);

    const started = await tool(testApi.baseUrl, token, "start_thread", { prompt: "Summarize the repo.", title: "MCP delegation", wait_seconds: 30 });
    expect(started.isError).toBe(false);
    expect(started.data).toMatchObject({ status: "completed", reply: "First reply from Valet" });
    const threadId = started.data.thread_id as string;
    // Links use the public auth URL (`BETTER_AUTH_URL`), not the request's host.
    expect(started.data.url).toMatch(new RegExp(`^https?://[^/]+/threads/${threadId}$`));

    const followUp = await tool(testApi.baseUrl, token, "send_message", { thread_id: threadId, prompt: "And the tests?", wait_seconds: 30 });
    expect(followUp.data).toMatchObject({ status: "completed", reply: "Second reply from Valet", thread_id: threadId });

    const listed = await tool(testApi.baseUrl, token, "list_threads", {});
    expect(listed.data.threads).toEqual(expect.arrayContaining([expect.objectContaining({ thread_id: threadId, title: "MCP delegation" })]));

    const read = await tool(testApi.baseUrl, token, "get_thread", { thread_id: threadId });
    expect(read.data.status).toBe("completed");
    expect((read.data.messages as Array<{ role: string; text: string }>).map((m) => [m.role, m.text])).toEqual([
      ["user", "Summarize the repo."],
      ["assistant", "First reply from Valet"],
      ["user", "And the tests?"],
      ["assistant", "Second reply from Valet"],
    ]);
  });

  it("keeps one user's threads hidden from another user's MCP token", async () => {
    const testApi = await boot();
    const alice = await seedUser(testApi, "alice");
    const bob = await seedUser(testApi, "bob");
    faux?.appendResponses([fauxAssistantMessage("Private to Alice")]);

    const started = await tool(testApi.baseUrl, alice, "start_thread", { prompt: "Secret plan.", wait_seconds: 30 });
    const threadId = started.data.thread_id as string;

    for (const [name, args] of [
      ["get_thread", { thread_id: threadId }],
      ["send_message", { thread_id: threadId, prompt: "Let me in.", wait_seconds: 0 }],
      ["list_decisions", { thread_id: threadId }],
    ] as const) {
      const denied = await tool(testApi.baseUrl, bob, name, args);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("not found, or you do not have access");
    }
    const bobThreads = await tool(testApi.baseUrl, bob, "list_threads", {});
    expect((bobThreads.data.threads as Array<{ thread_id: string }>).map((t) => t.thread_id)).not.toContain(threadId);

    const aliceView = await tool(testApi.baseUrl, alice, "get_thread", { thread_id: threadId });
    expect((aliceView.data.messages as unknown[]).length).toBe(2);
  });

  it("stops on a question, returns its options, and resumes after resolve_decision", async () => {
    const testApi = await boot();
    const token = await seedUser(testApi, "alice");
    faux?.appendResponses([
      fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which color?", options: ["red", "blue"] }, { id: "tc-question" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("You picked blue"),
    ]);

    const started = await tool(testApi.baseUrl, token, "start_thread", { prompt: "Ask me for a color.", wait_seconds: 30 });
    expect(started.data.status).toBe("waiting_for_decision");
    const [decision] = started.data.pending_decisions as Array<{ gate_id: string; title: string; options: Array<{ action_id: string; label: string }> }>;
    expect(decision?.title).toBe("Which color?");
    expect(decision?.options.map((o) => o.label)).toEqual(["red", "blue"]);
    const blue = decision?.options.find((o) => o.label === "blue");

    const listed = await tool(testApi.baseUrl, token, "list_decisions", { thread_id: started.data.thread_id });
    expect((listed.data.decisions as unknown[]).length).toBe(1);

    const resolved = await tool(testApi.baseUrl, token, "resolve_decision", {
      thread_id: started.data.thread_id, gate_id: decision?.gate_id, action_id: blue?.action_id, wait_seconds: 30,
    });
    expect(resolved.data).toMatchObject({ status: "completed", reply: "You picked blue" });
  });

  it("does not let an external request use the MCP identity", async () => {
    const testApi = await boot();
    await seedUser(testApi, "alice");
    // A plain HTTP request has no in-process attachment, so it is anonymous.
    expect((await fetch(`${testApi.baseUrl}/api/threads`)).status).toBe(401);
  });
});

describe("MCP route allow-list", () => {
  it("refuses an attached identity on a route the tools do not use", async () => {
    // With no auth instance, VALET_LOCAL_AUTH=1 makes the stub rung answer every
    // request. CI sets it, so pin it off: the last check must see the real 401.
    vi.stubEnv("VALET_LOCAL_AUTH", "");
    const { Hono } = await import("hono");
    const { buildAuthMiddleware } = await import("../middleware/auth.js");
    const { freshTestPgDb } = await import("../test-helpers/pg-test-db.js");
    const { appDb } = await freshTestPgDb();
    const app = new Hono<import("../env.js").AppEnv>();
    app.use("/api/*", buildAuthMiddleware({ auth: null, db: appDb }));
    app.get("/api/me", (c) => c.json({ id: c.var.user.id, via: c.var.authVia }));
    app.patch("/api/me", (c) => c.json({ changed: true }));
    const user = { id: "alice", email: "alice@nowhere.test", role: "member", orgId: "mcp-org" } as const;

    const allowed = await app.fetch(attachMcpCaller(new Request("http://x/api/me"), { user, clientId: "c1" }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ id: "alice", via: "mcp" });
    const refused = await app.fetch(attachMcpCaller(new Request("http://x/api/me", { method: "PATCH", body: "{}" }), { user, clientId: "c1" }));
    expect(refused.status).toBe(403);
    // Without the attachment the same request is anonymous.
    expect((await app.fetch(new Request("http://x/api/me"))).status).toBe(401);
  });

  // Each new tool's route must pass both lists. Neighbours that change a
  // definition, a grant, or an approval must still be refused.
  it("lets the stop, run-control, memory-edit, and unpublish tools through and nothing next to them", async () => {
    const { mcpRouteAllowed } = await import("./mcp-caller.js");
    const { agentRefusedRoute } = await import("../middleware/auth.js");
    const allowed: Array<[string, string]> = [
      ["POST", "/api/threads/t1/abort"],
      ["DELETE", "/api/memory"],
      ["POST", "/api/memory/patch"],
      ["POST", "/api/memory/move"],
      ["POST", "/api/workflows/runs/r1/cancel"],
      ["POST", "/api/workflows/runs/r1/retry"],
      ["DELETE", "/api/artifacts/a1"],
    ];
    for (const [method, path] of allowed) {
      expect(mcpRouteAllowed(method, path), `${method} ${path}`).toBe(true);
      expect(agentRefusedRoute(method, path), `${method} ${path}`).toBe(false);
    }
    const refused: Array<[string, string]> = [
      ["POST", "/api/workflows/runs/r1/approvals/n1"],
      ["POST", "/api/workflows/runs/r1/dismiss"],
      ["DELETE", "/api/workflows/w1"],
      ["POST", "/api/threads/t1/decisions/g1/withdraw"],
      ["POST", "/api/memory/import"],
      ["PATCH", "/api/artifacts/a1"],
      ["POST", "/api/artifacts/copy-to-team"],
    ];
    for (const [method, path] of refused) {
      expect(mcpRouteAllowed(method, path), `${method} ${path}`).toBe(false);
      expect(agentRefusedRoute(method, path), `${method} ${path}`).toBe(true);
    }
  });
});

describe("stop_thread", () => {
  async function connect(deps: Parameters<typeof import("./mcp-tools.js")["registerAgentTools"]>[1]) {
    const { registerAgentTools } = await import("./mcp-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "t", version: "0" });
    registerAgentTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  it("stops the newest turn by its queue item and reports it aborted", async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    let stopped = false;
    const client = await connect({
      api: async (method, path, body) => {
        if (method === "POST") {
          posted.push({ path, body });
          stopped = true;
          return { status: 200, body: { ok: true } };
        }
        if (path === "/api/threads/t") return { status: 200, body: { sessionId: "s" } };
        if (path.endsWith("/decisions")) return { status: 200, body: { gates: [] } };
        return { status: 200, body: { messages: [] } };
      },
      engineStore: { getQueueItem: async () => (stopped ? { status: "settled", outcome: { outcome: "aborted" } } : { status: "running" }) as never },
      // A follow-up is queued behind the running turn; Stop must hit the running one.
      latestQueueItem: async (_s, _t, status) => (status === "running" ? "q-live" : status === undefined ? "q-queued" : undefined),
      origin: "https://valet.test",
      sleep: async () => undefined,
    });
    const res = await client.callTool({ name: "stop_thread", arguments: { thread_id: "t" } });
    // The route needs the turn's id, so a Stop can never hit a turn queued later.
    expect(posted).toEqual([{ path: "/api/threads/t/abort", body: { targetItemId: "q-live" } }]);
    expect(res.structuredContent).toMatchObject({ thread_id: "t", message_id: "q-live", status: "aborted" });
    await client.close();
  });

  it("reports idle and posts nothing for a thread with no turns", async () => {
    let posts = 0;
    const client = await connect({
      api: async (method) => {
        if (method === "POST") posts += 1;
        return { status: 200, body: { sessionId: "s" } };
      },
      engineStore: { getQueueItem: async () => null as never },
      latestQueueItem: async () => undefined,
      origin: "https://valet.test",
    });
    const res = await client.callTool({ name: "stop_thread", arguments: { thread_id: "t" } });
    expect(res.structuredContent).toMatchObject({ status: "idle" });
    expect(posts).toBe(0);
    await client.close();
  });
});

describe("waitForTurn", () => {
  it("reports running, not an error, when the wait ends before the turn", async () => {
    const { waitForTurn } = await import("./mcp-tools.js");
    let clock = 0;
    const result = await waitForTurn({
      api: async () => ({ status: 200, body: { gates: [] } }),
      engineStore: { getQueueItem: async () => ({ status: "running" }) as never },
      latestQueueItem: async () => "q",
      origin: "https://valet.test",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }, { sessionId: "s", threadId: "t", queueItemId: "q", waitSeconds: 3 });
    expect(result).toEqual({ thread_id: "t", message_id: "q", status: "running", url: "https://valet.test/threads/t" });
    expect(clock).toBe(3000);
  });
});

describe("get_thread turn targeting", () => {
  it("waits on the newest queue item, not the last user message in the window", async () => {
    const { registerAgentTools } = await import("./mcp-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "t", version: "0" });
    // The last 50 messages hold only an older, finished turn: a long
    // tool-heavy turn has pushed its own prompt out of the window.
    const oldTurn = [
      { id: "u1", role: "user", content: "old prompt", parts: [], createdAt: 1, queueItemId: "q-old" },
      { id: "a1", role: "assistant", content: "old reply", parts: [], createdAt: 2, queueItemId: "q-old", stopReason: "end_turn" },
    ];
    const items: Record<string, unknown> = { "q-old": { status: "settled", outcome: { outcome: "completed" } }, "q-new": { status: "running" } };
    registerAgentTools(server, {
      api: async (_m, path) => path.includes("/decisions") ? { status: 200, body: { gates: [] } }
        : path.endsWith("/messages?limit=50") || path.includes("/messages?") ? { status: 200, body: { messages: oldTurn, hasMore: true } }
        : { status: 200, body: { sessionId: "s" } },
      engineStore: { getQueueItem: async (_s: string, id: string) => (items[id] ?? null) as never },
      latestQueueItem: async () => "q-new",
      origin: "https://valet.test",
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const res = await client.callTool({ name: "get_thread", arguments: { thread_id: "t" } });
    expect(res.structuredContent).toMatchObject({ status: "running" });
    await client.close();
  });
});

describe("resolve_decision turn targeting", () => {
  async function connect(deps: Parameters<typeof import("./mcp-tools.js")["registerAgentTools"]>[1]) {
    const { registerAgentTools } = await import("./mcp-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "t", version: "0" });
    registerAgentTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  it("returns the reply of the turn the question blocked, not a follow-up queued behind it", async () => {
    const posted: unknown[] = [];
    const client = await connect({
      api: async (method, path, body) => {
        if (method === "POST") {
          posted.push(body);
          return { status: 200, body: {} };
        }
        if (path === "/api/threads/t") return { status: 200, body: { sessionId: "s" } };
        if (path.endsWith("/decisions")) return { status: 200, body: { gates: [] } };
        if (path.includes("queueItemId=A")) {
          return { status: 200, body: { messages: [{ id: "m", role: "assistant", queueItemId: "A", content: "answer to A", stopReason: "end_turn", parts: [], createdAt: 1 }] } };
        }
        return { status: 200, body: { messages: [] } };
      },
      // Turn A was blocked on the question; follow-up B is queued behind it.
      engineStore: { getQueueItem: async (_s: string, id: string) => (id === "A" ? { status: "settled", outcome: { outcome: "completed" } } : { status: "queued" }) as never },
      latestQueueItem: async (_s, _t, status) => (status === "blocked_on_decision_gate" ? "A" : "B"),
      origin: "https://valet.test",
      sleep: async () => undefined,
    });
    // A typed answer, with no option id.
    const res = await client.callTool({ name: "resolve_decision", arguments: { thread_id: "t", gate_id: "g", value: "staging", wait_seconds: 5 } });
    expect(posted).toEqual([{ value: "staging" }]);
    expect(res.structuredContent).toMatchObject({ message_id: "A", reply: "answer to A" });
    const empty = await client.callTool({ name: "resolve_decision", arguments: { thread_id: "t", gate_id: "g" } });
    expect(empty.isError).toBe(true);
    await client.close();
  });
});

describe("slash command prompts", () => {
  async function connect(deps: Parameters<typeof import("./mcp-tools.js")["registerAgentTools"]>[1]) {
    const { registerAgentTools } = await import("./mcp-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "t", version: "0" });
    registerAgentTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  it("reports command_ran, not completed, when the send route runs a slash command", async () => {
    const client = await connect({
      // The send route answers a slash command with messageId null: no turn starts.
      api: async (method, path) => {
        if (method === "POST" && path === "/api/threads") return { status: 200, body: { id: "t" } };
        if (method === "POST") return { status: 200, body: { messageId: null } };
        return { status: 200, body: { sessionId: "s" } };
      },
      engineStore: { getQueueItem: async () => { throw new Error("a command has no queue item to read"); } },
      latestQueueItem: async () => undefined,
      origin: "https://valet.test",
    });
    for (const [name, args] of [["send_message", { thread_id: "t", prompt: "/model haiku" }], ["start_thread", { prompt: "/model haiku" }]] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.structuredContent).toEqual({
        thread_id: "t",
        status: "command_ran",
        message: expect.stringContaining("slash command"),
        url: "https://valet.test/threads/t",
      });
    }
    await client.close();
  });

  it("lists every status each tool can return in its description", async () => {
    const { registerAgentTools } = await import("./mcp-tools.js");
    const { registerWorkspaceTools } = await import("./mcp-workspace-tools.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "t", version: "0" });
    const deps = {
      api: async () => ({ status: 200, body: {} }),
      engineStore: { getQueueItem: async () => null },
      latestQueueItem: async () => undefined,
      origin: "https://valet.test",
    };
    registerAgentTools(server, deps);
    registerWorkspaceTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    const turn = ["completed", "failed", "aborted", "superseded", "waiting_for_decision", "running"];
    const expected: Record<string, string[]> = {
      start_thread: [...turn, "command_ran"],
      send_message: [...turn, "command_ran"],
      get_thread: [...turn, "idle"],
      resolve_decision: [...turn, "idle"],
      call_tool: ["completed", "failed", "approval_required", "in_progress"],
      describe_tool: ["allow", "require_approval", "deny"],
      ...Object.fromEntries(["list_workflows", "run_workflow", "get_workflow_run"].map((name) => [name,
        ["pending", "running", "parked", "terminalizing", "settled", "completed", "failed", "cancelled"]])),
    };
    for (const [name, statuses] of Object.entries(expected)) {
      for (const status of statuses) expect(description(name), `${name} lists ${status}`).toContain(status);
    }
    await client.close();
  });
});

describe("attachMcpCaller", () => {
  it("binds the identity to the exact Request object only", () => {
    const user = { id: "u", email: "u@x", role: "member", orgId: "o" } as const;
    const attached = attachMcpCaller(new Request("http://x/api/threads"), { user, clientId: "c1" });
    const copy = new Request(attached);
    return import("./mcp-caller.js").then(({ mcpCallerFor }) => {
      expect(mcpCallerFor(attached)).toEqual({ user, clientId: "c1" });
      expect(mcpCallerFor(copy)).toBeUndefined();
    });
  });
});
