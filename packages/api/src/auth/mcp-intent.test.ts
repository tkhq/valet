import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { intentSchema, registerTool } from "./mcp-intent.js";
import { registerAgentTools, type McpToolDeps } from "./mcp-tools.js";
import { registerWorkspaceTools } from "./mcp-workspace-tools.js";

const servers: McpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function clientFor(server: McpServer) {
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "intent-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCP intent boundary", () => {
  it.each([undefined, null, 123, "", "   ", "x".repeat(501)])("rejects invalid intent without throwing from safeParse: %s", intent => {
    expect(intentSchema.safeParse(intent).success).toBe(false);
  });
  it("trims before enforcing the length limit", () => {
    expect(intentSchema.parse(`  ${"x".repeat(500)}  `)).toHaveLength(500);
  });
  it("advertises intent on every registered agent and workspace tool", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const deps: McpToolDeps = { api: async () => ({ status: 200, body: {} }), engineStore: { getQueueItem: async () => null }, latestQueueItem: async () => undefined, origin: "https://example.test" };
    registerAgentTools(server, deps);
    registerWorkspaceTools(server, deps);
    const client = await clientFor(server);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(25);
    for (const tool of tools) {
      const field = tool.name === "call_tool" ? "summary" : "intent";
      expect(tool.inputSchema.required, tool.name).toContain(field);
      expect(tool.inputSchema.properties?.[field], tool.name).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    }
  });

  it("strips intent before handlers and call_tool payloads or idempotency inputs", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const handler = vi.fn(async (_args: { value: string }) => ({ content: [{ type: "text" as const, text: "ok" }] }));
    registerTool(server, "probe", { description: "Probe", inputSchema: { value: z.string() } }, handler);
    const api = vi.fn(async () => ({ status: 200, body: { status: "completed" } }));
    registerAgentTools(server, { api, engineStore: { getQueueItem: async () => null }, latestQueueItem: async () => undefined, origin: "https://example.test" });
    const client = await clientFor(server);
    const missing = await client.callTool({ name: "probe", arguments: { value: "x" } });
    expect(missing.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    await client.callTool({ name: "probe", arguments: { value: "x", intent: "  Check the probe to verify access.  " } });
    expect(handler).toHaveBeenCalledWith({ value: "x" }, expect.objectContaining({ signal: expect.any(AbortSignal), sendNotification: expect.any(Function) }));
    for (const intent of ["Read the value to check access.", "Retry the read to confirm the result."]) {
      await client.callTool({ name: "call_tool", arguments: { tool_id: "demo.read", params: { value: "x" }, idempotency_key: "same", summary: intent } });
    }
    expect(api.mock.calls).toEqual([
      ["POST", "/api/actions/demo.read/invoke", { params: { value: "x" }, idempotencyKey: "same" }],
      ["POST", "/api/actions/demo.read/invoke", { params: { value: "x" }, idempotencyKey: "same" }],
    ]);
  });
});
