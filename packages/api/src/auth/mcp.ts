/**
 * MCP endpoint (auth-v2 design, Task 9): a single `app.all("/mcp", ...)`
 * mount, public (outside `/api/*`, not behind `authMiddleware`) — guarded
 * instead by `withMcpAuth`, which validates the request's `Bearer` token
 * against the `oauth_access_token` table the `mcp` plugin (Task 6) already
 * writes via its OAuth Authorization Code flow, and 401s with a
 * `WWW-Authenticate` challenge on a missing/invalid/expired token.
 *
 * One `McpServer` + `WebStandardStreamableHTTPServerTransport` per request,
 * stateless (`sessionIdGenerator: undefined`) — no session state to manage
 * server-side between requests, matching the SDK's Hono usage example in
 * `webStandardStreamableHttp.d.ts`. `WebStandardStreamableHTTPServerTransport`
 * (not the node-http `StreamableHTTPServerTransport`) speaks WHATWG
 * `Request`/`Response` directly, so `c.req.raw` passes straight through
 * with no node req/res bridging.
 *
 * Every tool acts as the token's own user (`session.userId` from
 * `withMcpAuth`'s verified `OAuthAccessToken` row — never a caller-supplied
 * id):
 *   - `whoami` — `{ userId, email, role }` for the acting user.
 *   - `list_sessions` — the acting user's legacy sessions, via the injected
 *     `listSessions` (reuses `routes/sessions.ts`'s `listStandaloneSessions`
 *     query — no bespoke SQL).
 *   - The agent tools in `mcp-tools.ts` (workspaces, threads, delegation,
 *     decisions). They call `/api` routes in-process through `dispatch`, with
 *     the verified user attached by `mcp-caller.ts`, so the routes keep sole
 *     ownership of access control.
 */
import { bestEffortTelemetry, externalCallOwner, newExternalCallId, recordExternalCall, saveMcpClientInfo } from "../services/external-usage.js";
import { intentSchema, registerTool } from "./mcp-intent.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withMcpAuth } from "better-auth/plugins";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { resolveOrgId } from "../lib/org.js";
import type { Providers } from "../providers/types.js";
import { mcpClientInfo, users } from "../schema/index.js";
import type { ValetAuth } from "./index.js";
import { attachMcpCaller } from "./mcp-caller.js";
import { hasMcpConsent } from "../routes/oauth-consent.js";
import { registerAgentTools, type ApiCaller } from "./mcp-tools.js";
import { registerWorkspaceTools } from "./mcp-workspace-tools.js";

export interface McpHandlerOpts {
  auth: ValetAuth;
  db: AppDb;
  listSessions: (userId: string) => Promise<Array<{ id: string; title: string | null; status: string }>>;
  /** Handles an in-process request with the full app (`app.fetch`). */
  dispatch: (req: Request) => Promise<Response>;
  engineStore: Pick<Providers["engineStore"], "getQueueItem">;
}

export function mcpHandler(opts: McpHandlerOpts): (req: Request) => Promise<Response> {
  const { auth, db, listSessions, dispatch, engineStore } = opts;

  return withMcpAuth(auth, async (req, session) => {
    // Links use the public auth URL (`BETTER_AUTH_URL`), the same base the
    // `WWW-Authenticate` challenge names; behind an ingress `req.url` can be internal.
    const origin = new URL(auth.options.baseURL ?? req.url).origin;
    // A valid token is not enough: the person must have approved this app on
    // the consent page. The 401 matches `withMcpAuth`'s, so the client signs in again.
    if (!(await hasMcpConsent(db, session.clientId, session.userId))) {
      const challenge = `Bearer resource_metadata="${origin}${auth.options.basePath ?? "/api/auth"}/.well-known/oauth-protected-resource"`;
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: approve this app on the Valet consent page. Sign in to the MCP server again." }, id: null },
        { status: 401, headers: { "WWW-Authenticate": challenge, "Access-Control-Expose-Headers": "WWW-Authenticate" } },
      );
    }
    const started = Date.now();
    const orgId = await resolveOrgId(db);
    const identity = { orgId, userId: session.userId, clientId: session.clientId };
    const body: unknown = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
    const rpc = object(body);
    const params = object(rpc?.params);
    const args = object(params?.arguments);
    const clientInfo = object(params?.clientInfo);
    if (rpc?.method === "initialize" && typeof clientInfo?.name === "string" && typeof clientInfo.version === "string") {
      void saveMcpClientInfo(db, identity, { name: clientInfo.name, version: clientInfo.version });
    }
    let outcome: "ok" | "error" | "denied" | "pending-approval" = "error";
    let errorCode: string | null = null;
    let finalHttpStatus: number | undefined;
    let resolvedSessionId: string | undefined;
    let resolvedThreadId: string | undefined;
    let resolvedTeamId: string | undefined;
    let resolvedActionId: string | undefined;
    const server = new McpServer({ name: "valet", version: "1.0.0" });

    const [row] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (row) {
      const caller = { id: row.id, email: row.email, name: row.name ?? undefined, role: row.role, orgId };
      const api: ApiCaller = async (method, path, body) => {
        const inner = attachMcpCaller(new Request(`${origin}${path}`, {
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), { user: caller, clientId: session.clientId });
        const res = await dispatch(inner);
        finalHttpStatus = res.status;
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // Keep the raw text; the tool reports the status.
        }
        const action = object(parsed);
        // IDs come only from routes that admitted this user. Never retain the response.
        if (res.ok) {
          const url = new URL(inner.url);
          const pathParts = url.pathname.split("/");
          const invokeBody = pathParts[2] === "actions" && pathParts[4] === "invoke" ? object(body) : undefined;
          const team = url.searchParams.get("workspace") ?? (typeof invokeBody?.workspace === "string" ? invokeBody.workspace : null)
            ?? (url.searchParams.get("ownerType") === "team" ? url.searchParams.get("ownerId") : null);
          if (team && team !== "user") resolvedTeamId = team;
          if (typeof action?.tool_id === "string") resolvedActionId = action.tool_id;
          if (pathParts[2] === "threads") resolvedThreadId = typeof action?.id === "string" ? action.id : pathParts[3];
          if (typeof action?.threadId === "string") resolvedThreadId = action.threadId;
          if (typeof action?.sessionId === "string") resolvedSessionId = action.sessionId;
        }
        return { status: res.status, body: parsed };
      };
      const latestQueueItem = async (sessionId: string, threadId: string, status?: "running" | "blocked_on_decision_gate") => {
        const [item] = await db.select({ id: sql<string>`id` }).from(sql`engine_queue_items`)
          .where(status
            ? sql`session_id = ${sessionId} and thread_id = ${threadId} and status = ${status}`
            : sql`session_id = ${sessionId} and thread_id = ${threadId}`)
          .orderBy(sql`created_at desc, id desc`).limit(1);
        return item?.id;
      };
      const deps = { api, engineStore, origin, latestQueueItem };
      registerAgentTools(server, deps);
      registerWorkspaceTools(server, deps);
    }

    registerTool(server,
      "whoami",
      { description: "Returns the authenticated user's identity: userId, email, role." },
      async () => {
        const user = row;
        if (!user) {
          return { content: [{ type: "text", text: `no user found for id ${session.userId}` }], isError: true };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ userId: user.id, email: user.email, role: user.role }) },
          ],
        };
      },
    );

    registerTool(server,
      "list_sessions",
      { description: "Lists the authenticated user's sessions: id, title, status." },
      async () => {
        const sessions = await listSessions(session.userId);
        return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
      },
    );

    // `enableJsonResponse: true` — plain JSON response bodies instead of an
    // SSE stream. Stateless, one-shot request/response is exactly what this
    // mount does (no server-initiated notifications to push), and it's the
    // scenario the SDK's own docs call out `enableJsonResponse` for.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // Observe the final JSON-RPC reply before serialization. Inner requests may fail and recover.
    const send = transport.send.bind(transport);
    transport.send = async (message, ...rest) => {
      const reply = object(message);
      if (rpc?.method === "tools/call" && reply && "id" in reply && reply.id === rpc.id) {
        const result = object(reply.result);
        const error = object(reply.error);
        outcome = error || result?.isError === true ? finalHttpStatus === 403 ? "denied" : "error" : "ok";
        errorCode = error ? String(error.code ?? "rpc_error") : result?.isError === true ? "tool_error" : null;
        if (params?.name === "call_tool" && Array.isArray(result?.content)) {
          for (const block of result.content) {
            const text = object(block)?.text;
            if (typeof text !== "string") continue;
            let action: Record<string, unknown> | undefined;
            try { action = object(JSON.parse(text)); } catch { continue; }
            if (action?.status === "failed") { outcome = action.errorCode === "policy_denied" ? "denied" : "error"; errorCode = action.errorCode === "policy_denied" ? "policy_denied" : "action_failed"; }
            if (action?.status === "approval_required") { outcome = "pending-approval"; errorCode = "approval_required"; }
          }
        }
      }
      return send(message, ...rest);
    };
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req);
      return response;
    } catch (error) {
      outcome = "error";
      errorCode = "internal_error";
      throw error;
    } finally {
      if (rpc?.method === "tools/call" && typeof params?.name === "string") {
        const toolName = params.name;
        const durationMs = Date.now() - started;
        void bestEffortTelemetry(async () => {
          const [client] = await db.select().from(mcpClientInfo).where(and(
            eq(mcpClientInfo.orgId, orgId), eq(mcpClientInfo.userId, session.userId), eq(mcpClientInfo.clientId, session.clientId),
          )).limit(1);
          const intent = intentSchema.safeParse(params.name === "call_tool" ? args?.summary : args?.intent);
          await recordExternalCall(db, {
            id: newExternalCallId(), orgId, userId: session.userId, surface: "mcp", name: (toolName === "call_tool" ? resolvedActionId ?? (typeof args?.tool_id === "string" ? args.tool_id : toolName) : toolName).slice(0, 200),
            clientName: client?.name, clientVersion: client?.version,
            ...await externalCallOwner(db, orgId, session.userId, resolvedThreadId, resolvedSessionId, resolvedTeamId),
            outcome, errorCode, durationMs,
            intent: intent.success && typeof intent.data === "string" ? intent.data.trim() : null, createdAt: started,
          });
        });
      }
    }
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
