import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpToolDef, McpToolPort, ValetPlugin } from "@valet/engine";
import { withMcpAuth } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../lib/drizzle.js";
import {
  persistInvocationAuditStrict,
  updateInvocationOutcomeStrict,
  type AuditInvocationRow,
  type InvocationOutcome,
} from "../policies/service.js";
import { orgMembers, users } from "../schema/index.js";
import type { ValetAuth } from "./index.js";

const BUILTIN_TOOLS = new Set(["whoami", "list_sessions"]);
const INVALID_TOOL_NAME = "<invalid-tool-name>";
const REDACTED_ARGUMENTS = { arguments: "[redacted unvalidated arguments]" };
const AUDIT_FAILURE = "Valet could not record the required MCP audit entry. Retry after audit storage is available.";

export interface McpAuditStore {
  start(row: AuditInvocationRow): Promise<void>;
  finish(invocationId: string, orgId: string, outcome: InvocationOutcome): Promise<void>;
}

export interface McpHandlerOpts {
  auth: ValetAuth;
  db: AppDb;
  plugins: ValetPlugin[];
  portForPlugin: (pluginName: string, userId: string) => McpToolPort | undefined;
  listSessions: (userId: string) => Promise<Array<{ id: string; title: string | null; status: string }>>;
  auditStore?: McpAuditStore;
}

interface AuditLifecycle {
  invocationId: string;
  orgId: string;
  startedAt: number;
  handled: boolean;
}

interface ToolAttempt {
  requestKey: string;
  tool: string;
  args: Record<string, unknown>;
  dispatchable: boolean;
}

type LifecycleQueues = Map<string, AuditLifecycle[]>;

function requestKey(id: unknown): string {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  return "invalid";
}

function lifecycleKey(id: unknown, tool: string): string {
  return `${requestKey(id)}:${tool}`;
}

function takeLifecycle(queues: LifecycleQueues, id: unknown, tool: string): AuditLifecycle | undefined {
  return queues.get(lifecycleKey(id, tool))?.shift();
}

function inputSchema(tool: McpToolDef): z.ZodRawShape {
  // The engine keeps this Zod raw shape opaque. The API owns schema parsing.
  return tool.inputSchema as z.ZodRawShape;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function auditArguments(tool: McpToolDef | undefined, args: unknown): Record<string, unknown> {
  const values = record(args);
  if (!tool || !values) return REDACTED_ARGUMENTS;
  try {
    return tool.auditArguments ? tool.auditArguments(values) : values;
  } catch {
    return REDACTED_ARGUMENTS;
  }
}

async function toolAttempts(req: Request, tools: Map<string, McpToolDef>): Promise<ToolAttempt[]> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return [];
  }
  const messages = Array.isArray(body) ? body : [body];
  const attempts: ToolAttempt[] = [];
  for (const message of messages) {
    const request = record(message);
    if (!request || request.method !== "tools/call") continue;
    const params = record(request.params);
    const tool = typeof params?.name === "string" ? params.name : INVALID_TOOL_NAME;
    const definition = tools.get(tool);
    const values = record(params?.arguments);
    attempts.push({
      requestKey: lifecycleKey(request.id, tool),
      tool,
      args: BUILTIN_TOOLS.has(tool) ? {} : auditArguments(definition, values),
      dispatchable: BUILTIN_TOOLS.has(tool)
        || (definition !== undefined && values !== undefined && z.object(inputSchema(definition)).safeParse(values).success),
    });
  }
  return attempts;
}

export function validateMcpToolConfiguration(plugins: ValetPlugin[], portPlugins: ReadonlySet<string>): void {
  const ownerByTool = new Map<string, string>([...BUILTIN_TOOLS].map((name) => [name, "Valet"]));
  for (const plugin of plugins) {
    const tools = plugin.mcpTools ?? [];
    if (tools.length > 0 && !portPlugins.has(plugin.name)) {
      throw new Error(`MCP plugin "${plugin.name}" has tools but no host port. Add its port factory and restart the API.`);
    }
    for (const tool of tools) {
      const owner = ownerByTool.get(tool.name);
      if (owner) {
        throw new Error(`MCP tool "${tool.name}" is declared by both "${owner}" and "${plugin.name}". Rename one tool and restart the API.`);
      }
      ownerByTool.set(tool.name, plugin.name);
    }
  }
}

async function resolveMcpOrgId(db: AppDb, userId: string): Promise<string> {
  const memberships = await db.select({ orgId: orgMembers.orgId })
    .from(orgMembers).where(eq(orgMembers.userId, userId)).limit(2);
  if (memberships.length !== 1) {
    throw new Error("Your OAuth account must belong to exactly one organization. Ask an administrator to correct your organization membership.");
  }
  return memberships[0].orgId;
}

function defaultAuditStore(db: AppDb): McpAuditStore {
  return {
    start: (row) => persistInvocationAuditStrict(db, row),
    finish: (invocationId, orgId, outcome) => updateInvocationOutcomeStrict(db, invocationId, orgId, outcome),
  };
}

async function requireAudit(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.error("required MCP audit write failed:", error);
    throw new Error(AUDIT_FAILURE);
  }
}

async function runAudited(
  auditStore: McpAuditStore,
  lifecycle: AuditLifecycle | undefined,
  run: () => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!lifecycle) throw new Error(AUDIT_FAILURE);
  lifecycle.handled = true;
  try {
    const result = await run();
    await requireAudit(() => auditStore.finish(lifecycle.invocationId, lifecycle.orgId, {
      status: result.isError ? "error" : "completed",
      durationMs: Date.now() - lifecycle.startedAt,
    }));
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === AUDIT_FAILURE) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await requireAudit(() => auditStore.finish(lifecycle.invocationId, lifecycle.orgId, {
      status: "error",
      error: message,
      durationMs: Date.now() - lifecycle.startedAt,
    }));
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function finalizeUnhandled(
  auditStore: McpAuditStore,
  lifecycles: AuditLifecycle[],
  error: string,
): Promise<void> {
  await Promise.all(lifecycles.filter((lifecycle) => !lifecycle.handled).map((lifecycle) =>
    requireAudit(() => auditStore.finish(lifecycle.invocationId, lifecycle.orgId, {
      status: "error",
      error,
      durationMs: Date.now() - lifecycle.startedAt,
    })),
  ));
}

function registerPluginTool(
  server: McpServer,
  tool: McpToolDef,
  port: McpToolPort,
  lifecycles: LifecycleQueues,
  auditStore: McpAuditStore,
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: inputSchema(tool),
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: false,
        idempotentHint: tool.readOnly,
      },
    },
    async (args, extra) => runAudited(auditStore, takeLifecycle(lifecycles, extra.requestId, tool.name), async () => {
      const result = await tool.execute(args, port);
      return { content: [{ type: "text", text: result.text }] };
    }),
  );
}

export function mcpHandler(opts: McpHandlerOpts): (req: Request, sourceIp?: string) => Promise<Response> {
  const { auth, db, listSessions } = opts;
  const pluginTools = new Map(opts.plugins.flatMap((plugin) => (plugin.mcpTools ?? []).map((tool) => [tool.name, tool] as const)));
  const auditStore = opts.auditStore ?? defaultAuditStore(db);

  return (request, sourceIp = "unknown") => withMcpAuth(auth, async (req, session) => {
    const attempts = await toolAttempts(req, pluginTools);
    const lifecycles: AuditLifecycle[] = [];
    const lifecycleQueues: LifecycleQueues = new Map();
    if (attempts.length > 0) {
      const orgId = await resolveMcpOrgId(db, session.userId);
      try {
        for (const attempt of attempts) {
          const startedAt = Date.now();
          const lifecycle = { invocationId: `mcp:${randomUUID()}`, orgId, startedAt, handled: false };
          await requireAudit(() => auditStore.start({
            invocationId: lifecycle.invocationId,
            createdAt: startedAt,
            startedAt,
            service: "mcp",
            actionId: attempt.tool,
            status: "pending",
            userId: session.userId,
            orgId,
            params: attempt.args,
            sourceIp,
          }));
          lifecycles.push(lifecycle);
          if (attempt.dispatchable) {
            const queue = lifecycleQueues.get(attempt.requestKey) ?? [];
            queue.push(lifecycle);
            lifecycleQueues.set(attempt.requestKey, queue);
          }
        }
      } catch (error) {
        await finalizeUnhandled(auditStore, lifecycles, "The MCP batch audit could not start.");
        throw error;
      }
    }

    const server = new McpServer({ name: "valet", version: "1.0.0" });
    server.registerTool(
      "whoami",
      { description: "Returns the authenticated user's identity: userId, email, role." },
      async (extra) => runAudited(auditStore, takeLifecycle(lifecycleQueues, extra.requestId, "whoami"), async () => {
        const rows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
        const user = rows[0];
        if (!user) {
          return {
            content: [{ type: "text", text: "Your OAuth user no longer exists. Sign in again with an active account." }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify({ userId: user.id, email: user.email, role: user.role }) }] };
      }),
    );
    server.registerTool(
      "list_sessions",
      { description: "Lists the authenticated user's sessions: id, title, status." },
      async (extra) => runAudited(auditStore, takeLifecycle(lifecycleQueues, extra.requestId, "list_sessions"), async () => ({
        content: [{ type: "text", text: JSON.stringify(await listSessions(session.userId)) }],
      })),
    );

    for (const plugin of opts.plugins) {
      const tools = plugin.mcpTools ?? [];
      if (tools.length === 0) continue;
      const port = opts.portForPlugin(plugin.name, session.userId);
      if (!port) throw new Error(`MCP plugin "${plugin.name}" lost its host port. Restart the API after restoring the port factory.`);
      for (const tool of tools) registerPluginTool(server, tool, port, lifecycleQueues, auditStore);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    await finalizeUnhandled(auditStore, lifecycles, "The MCP server rejected the tool name or arguments.");
    return response;
  })(request);
}
