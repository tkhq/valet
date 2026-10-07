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
  await db.insert(oauthAccessToken).values({
    id: `oauth-${id}`,
    accessToken: token,
    refreshToken: `refresh-${id}`,
    accessTokenExpiresAt: new Date(now + 600_000),
    refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: null,
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
      "call_tool", "describe_tool", "get_thread", "list_decisions", "list_sessions", "list_threads",
      "list_workspaces", "resolve_decision", "search_tools", "send_message", "start_thread", "whoami",
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
    const { Hono } = await import("hono");
    const { buildAuthMiddleware } = await import("../middleware/auth.js");
    const { freshTestPgDb } = await import("../test-helpers/pg-test-db.js");
    const { appDb } = await freshTestPgDb();
    const app = new Hono<import("../env.js").AppEnv>();
    app.use("/api/*", buildAuthMiddleware({ auth: null, db: appDb }));
    app.get("/api/me", (c) => c.json({ id: c.var.user.id, via: c.var.authVia }));
    app.patch("/api/me", (c) => c.json({ changed: true }));
    const user = { id: "alice", email: "alice@nowhere.test", role: "member", orgId: "mcp-org" } as const;

    const allowed = await app.fetch(attachMcpCaller(new Request("http://x/api/me"), user));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ id: "alice", via: "mcp" });
    const refused = await app.fetch(attachMcpCaller(new Request("http://x/api/me", { method: "PATCH", body: "{}" }), user));
    expect(refused.status).toBe(403);
    // Without the attachment the same request is anonymous.
    expect((await app.fetch(new Request("http://x/api/me"))).status).toBe(401);
  });
});

describe("waitForTurn", () => {
  it("reports running, not an error, when the wait ends before the turn", async () => {
    const { waitForTurn } = await import("./mcp-tools.js");
    let clock = 0;
    const result = await waitForTurn({
      api: async () => ({ status: 200, body: { gates: [] } }),
      engineStore: { getQueueItem: async () => ({ status: "running" }) as never },
      origin: "https://valet.test",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }, { sessionId: "s", threadId: "t", queueItemId: "q", waitSeconds: 3 });
    expect(result).toEqual({ thread_id: "t", message_id: "q", status: "running", url: "https://valet.test/threads/t" });
    expect(clock).toBe(3000);
  });
});

describe("attachMcpCaller", () => {
  it("binds the identity to the exact Request object only", () => {
    const user = { id: "u", email: "u@x", role: "member", orgId: "o" } as const;
    const attached = attachMcpCaller(new Request("http://x/api/threads"), user);
    const copy = new Request(attached);
    return import("./mcp-caller.js").then(({ mcpCallerFor }) => {
      expect(mcpCallerFor(attached)).toEqual(user);
      expect(mcpCallerFor(copy)).toBeUndefined();
    });
  });
});
