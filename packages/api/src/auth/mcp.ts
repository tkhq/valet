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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withMcpAuth } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { resolveOrgId } from "../lib/org.js";
import type { Providers } from "../providers/types.js";
import { users } from "../schema/index.js";
import type { ValetAuth } from "./index.js";
import { attachMcpCaller } from "./mcp-caller.js";
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
    const server = new McpServer({ name: "valet", version: "1.0.0" });
    // Links use the public auth URL (`BETTER_AUTH_URL`), the same base the
    // `WWW-Authenticate` challenge names; behind an ingress `req.url` can be internal.
    const origin = new URL(auth.options.baseURL ?? req.url).origin;

    const [row] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (row) {
      const caller = { id: row.id, email: row.email, name: row.name ?? undefined, role: row.role, orgId: await resolveOrgId(db) };
      const api: ApiCaller = async (method, path, body) => {
        const inner = attachMcpCaller(new Request(`${origin}${path}`, {
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), { user: caller, clientId: session.clientId });
        const res = await dispatch(inner);
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // Keep the raw text; the tool reports the status.
        }
        return { status: res.status, body: parsed };
      };
      const latestQueueItem = async (sessionId: string, threadId: string, status?: "blocked_on_decision_gate") => {
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

    server.registerTool(
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

    server.registerTool(
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
    await server.connect(transport);
    return transport.handleRequest(req);
  });
}
