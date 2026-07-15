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
 * Two tools, scoped to the token's own user (`session.userId` from
 * `withMcpAuth`'s verified `OAuthAccessToken` row — never a caller-supplied
 * id):
 *   - `whoami` — `{ userId, email, role }` for the acting user.
 *   - `list_sessions` — the acting user's sessions, via the injected
 *     `listSessions` (reuses `routes/sessions.ts`'s `listStandaloneSessions`
 *     query — no bespoke SQL).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withMcpAuth } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { users } from "../schema/index.js";
import type { ValetAuth } from "./index.js";

export interface McpHandlerOpts {
  auth: ValetAuth;
  db: AppDb;
  listSessions: (userId: string) => Promise<Array<{ id: string; title: string | null; status: string }>>;
}

export function mcpHandler(opts: McpHandlerOpts): (req: Request) => Promise<Response> {
  const { auth, db, listSessions } = opts;

  return withMcpAuth(auth, async (req, session) => {
    const server = new McpServer({ name: "valet", version: "1.0.0" });

    server.registerTool(
      "whoami",
      { description: "Returns the authenticated user's identity: userId, email, role." },
      async () => {
        const user = await db.select().from(users).where(eq(users.id, session.userId)).get();
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
