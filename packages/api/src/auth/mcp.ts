import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpToolDef, McpToolPort, ValetPlugin } from "@valet/engine";
import { withMcpAuth } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { AppDb } from "../lib/drizzle.js";
import { persistInvocationAudit } from "../policies/service.js";
import { users } from "../schema/index.js";
import type { ValetAuth } from "./index.js";

export interface McpHandlerOpts {
  auth: ValetAuth;
  db: AppDb;
  plugins: ValetPlugin[];
  portForPlugin: (pluginName: string, userId: string) => McpToolPort | undefined;
  listSessions: (userId: string) => Promise<Array<{ id: string; title: string | null; status: string }>>;
}

interface AuditCall {
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  sourceIp: string;
}

async function auditCall(
  db: AppDb,
  call: AuditCall,
  run: () => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const startedAt = Date.now();
  try {
    const result = await run();
    await persistInvocationAudit(db, {
      invocationId: `mcp:${randomUUID()}`,
      createdAt: startedAt,
      startedAt,
      service: "mcp",
      actionId: call.tool,
      status: result.isError ? "error" : "completed",
      userId: call.userId,
      params: call.args,
      sourceIp: call.sourceIp,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistInvocationAudit(db, {
      invocationId: `mcp:${randomUUID()}`,
      createdAt: startedAt,
      startedAt,
      service: "mcp",
      actionId: call.tool,
      status: "error",
      userId: call.userId,
      params: call.args,
      sourceIp: call.sourceIp,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function registerPluginTool(
  server: McpServer,
  db: AppDb,
  tool: McpToolDef,
  port: McpToolPort,
  userId: string,
  sourceIp: string,
): void {
  // The engine keeps this Zod raw shape opaque to stay portable. The plugin
  // creates it with Zod, and the MCP SDK is the first boundary that needs its type.
  const inputSchema = tool.inputSchema as z.ZodRawShape;
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema,
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: false,
        idempotentHint: tool.readOnly,
      },
    },
    async (args) => auditCall(
      db,
      {
        userId,
        tool: tool.name,
        args: tool.auditArguments ? tool.auditArguments(args) : args,
        sourceIp,
      },
      async () => {
        const result = await tool.execute(args, port);
        return { content: [{ type: "text", text: result.text }] };
      },
    ),
  );
}

export function mcpHandler(opts: McpHandlerOpts): (req: Request, sourceIp?: string) => Promise<Response> {
  const { auth, db, listSessions } = opts;

  return (request, sourceIp = "unknown") => withMcpAuth(auth, async (req, session) => {
    const server = new McpServer({ name: "valet", version: "1.0.0" });

    server.registerTool(
      "whoami",
      { description: "Returns the authenticated user's identity: userId, email, role." },
      async () => auditCall(db, { userId: session.userId, tool: "whoami", args: {}, sourceIp }, async () => {
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
      async () => auditCall(db, { userId: session.userId, tool: "list_sessions", args: {}, sourceIp }, async () => ({
        content: [{ type: "text", text: JSON.stringify(await listSessions(session.userId)) }],
      })),
    );

    const names = new Set(["whoami", "list_sessions"]);
    for (const plugin of opts.plugins) {
      const port = opts.portForPlugin(plugin.name, session.userId);
      if (!port) continue;
      for (const tool of plugin.mcpTools ?? []) {
        if (names.has(tool.name)) {
          throw new Error(`MCP tool name "${tool.name}" is duplicated. Rename one plugin tool and restart the API.`);
        }
        names.add(tool.name);
        registerPluginTool(server, db, tool, port, session.userId, sourceIp);
      }
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  })(request);
}
