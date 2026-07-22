/**
 * Hono app factory. Wiring lives here; main.ts only handles boot + listen.
 *
 * Splitting `createApp(providers)` from `main.ts` keeps tests fast (build a
 * test app with stub providers, no node-server). It also keeps boot-time
 * I/O (open sqlite, build providers) out of the hot test path.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppEnv } from "./env.js";
import type { RunningServer, ServerAdapter } from "./server-adapter.js";
import { nodeServerAdapter } from "./server-adapter.node.js";
import type { Providers } from "./providers/types.js";
import { providersMiddleware } from "./middleware/providers.js";
import { buildAuthMiddleware } from "./middleware/auth.js";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, type ValetAuth } from "./auth/index.js";
import { mcpHandler } from "./auth/mcp.js";
import type { AuthConfig } from "./auth/config.js";
import type { AuthConfigResponse, HealthResponse } from "./wire/types.js";
import { VALET_VERSION } from "./version.js";
import { parseSandboxBackend } from "./providers/sandbox-backend.js";
import { sessionsRouter, listStandaloneSessions } from "./routes/sessions.js";
import { messagesRouter } from "./routes/messages.js";
import { adminRouter } from "./routes/admin.js";
import { teamsRouter } from "./routes/teams.js";
import { memoryRouter } from "./routes/memory.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { notificationsRouter } from "./routes/notifications.js";
import { workflowsRouter } from "./routes/workflows.js";
import { pluginsRouter } from "./routes/plugins.js";
import { credentialsRouter } from "./routes/credentials.js";
import { onePasswordRouter } from "./routes/onepassword.js";
import { credentialConnectRouter } from "./routes/credential-connect.js";
import { identityLinksRouter } from "./routes/identity-links.js";
import { meRouter } from "./routes/me.js";
import { modelsRouter } from "./routes/models.js";
import { orgRouter } from "./routes/org.js";
import { orgInvitesRouter } from "./routes/org-invites.js";
import { llmProvidersRouter } from "./routes/llm-providers.js";
import { githubAppRouter, githubAppWebhookRouter } from "./routes/github-app.js";
import { githubConnectRouter } from "./routes/github-connect.js";
import { reposRouter } from "./routes/repos.js";
import { imageCatalogRouter } from "./routes/image-catalog.js";
import { prebuildsRouter, prebuildsPublicRouter } from "./routes/prebuilds.js";
import { sandboxGitCredentialRouter } from "./routes/sandbox-git-credential.js";
import { registerWsRoutes } from "./routes/ws.js";
import { registerGatewayHttpProxy, registerGatewayWsProxy } from "./routes/gateway-proxy.js";
import { channelsRouter } from "./routes/channels.js";
import { mountWebStatic } from "./static-web.js";

export interface CreatedApp {
  app: Hono<AppEnv>;
  /**
   * Start listening on `port` and attach the WS upgrade handler, using the
   * runtime adapter passed to `createApp`. Returns a uniform handle whose
   * `close()` stops the socket. The WS `attach` token is captured internally,
   * so callers never touch runtime-specific plumbing.
   */
  startServer(opts: { port: number; onListen?: (port: number) => void }): RunningServer;
  /** True when `opts.webDistDir` pointed at a real build and the SPA was
   * mounted. `false` when unset (dev mode) OR set-but-missing-index.html —
   * the caller distinguishes those two (a set-but-unmounted dist is fatal). */
  webServed: boolean;
}

export interface CreateAppOpts {
  /**
   * Absolute path to the built `@valet/web` output (`vite build`'s `dist`).
   * Only set by `main.ts` in the bundled production image via
   * `VALET_WEB_DIST_DIR` — unset in `make dev-local`, where Vite's own dev
   * server serves the web app. See `static-web.ts`.
   */
  webDistDir?: string;
}

/**
 * Real-auth wiring — both fields are only present when `BETTER_AUTH_SECRET`
 * resolved a config (auth-v2 design). Absent → stub-only mode (today's
 * `VALET_LOCAL_AUTH` behavior), and `GET /api/auth-config` reports
 * `{ stub: true }`.
 */
export interface AuthWiring {
  auth?: ValetAuth;
  authConfig?: AuthConfig;
}

export function createApp(
  providers: Providers,
  authWiring: AuthWiring = {},
  opts: CreateAppOpts = {},
  // Default to the Node adapter so the many HTTP-only test callers (and the
  // node bundle) need no change. Under Bun, `main.ts` passes the Bun adapter
  // explicitly via `selectServerAdapter()` — the Node adapter's `serve` /
  // `createWebSocket` are then never called. The Node adapter is import-safe
  // under Bun; only `hono/bun` (the Bun adapter's dep) is not import-safe
  // under Node, and it is never statically imported here.
  adapter: ServerAdapter = nodeServerAdapter,
): CreatedApp {
  const app = new Hono<AppEnv>();
  const { auth, authConfig } = authWiring;

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      credentials: true,
    }),
  );
  app.use("*", providersMiddleware(providers));

  // Public channel ingress (webhooks) — verification is transport-level
  // (`ChannelHost.handleWebhook` → `transport.verifyWebhook`), not the auth
  // gate below, since the caller is the provider (Telegram etc.), not a
  // logged-in Valet user. Mounting BEFORE `buildAuthMiddleware` is what
  // makes this route public — do not move it below that line.
  app.route("/api/channels", channelsRouter);

  // PUBLIC GitHub App webhook ingress — same reasoning as `channelsRouter`
  // above: the caller is GitHub, not a logged-in Valet user; verification
  // is HMAC-signature-level (`X-Hub-Signature-256`) inside the router
  // itself, not the auth gate below. Mounted BEFORE `buildAuthMiddleware`
  // for the same reason `channelsRouter` is.
  app.route("/webhooks/github-app", githubAppWebhookRouter);

  // Public health check (no auth). Carries the running binary's version and
  // the resolved sandbox backend so `valet status` can report client/server
  // versions + skew (single-binary CLI plan, T6; spec decisions 6 & 9).
  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      service: "valet-api",
      ts: Date.now(),
      version: VALET_VERSION,
      sandboxBackend: parseSandboxBackend(process.env.VALET_SANDBOX_BACKEND),
    };
    return c.json(body);
  });

  // better-auth owns everything under /api/auth/* (signup, login, session,
  // social + SSO callbacks, api-key endpoints, MCP OAuth). Mounted BEFORE
  // authMiddleware so it's public even when VALET_LOCAL_AUTH isn't set —
  // otherwise login/signup could never succeed in production.
  if (auth) {
    app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.get("/.well-known/oauth-authorization-server", (c) => oAuthDiscoveryMetadata(auth)(c.req.raw));
    app.get("/.well-known/oauth-protected-resource", (c) => oAuthProtectedResourceMetadata(auth)(c.req.raw));

    // MCP endpoint (Task 9): public mount, `withMcpAuth` guards it with the
    // `mcp` plugin's own bearer-token check (401 + `WWW-Authenticate` on
    // missing/invalid/expired tokens) — not `authMiddleware`.
    const mcp = mcpHandler({
      auth,
      db: providers.db,
      listSessions: async (userId) => {
        const rows = await listStandaloneSessions(providers.db, userId);
        return rows.map((r) => ({ id: r.id, title: r.title, status: r.status }));
      },
    });
    app.all("/mcp", (c) => mcp(c.req.raw));
  }

  // Unauthenticated: drives `/login`/`/signup` control rendering.
  app.get("/api/auth-config", (c) => {
    const body: AuthConfigResponse = authConfig
      ? {
          stub: false,
          social: [
            ...(authConfig.social.google ? (["google"] as const) : []),
            ...(authConfig.social.github ? (["github"] as const) : []),
          ],
          sso: authConfig.oidc ? { name: authConfig.oidc.name } : null,
        }
      : { stub: true, social: [], sso: null };
    return c.json(body);
  });

  // Everything under /api/* requires auth (stub in dev; 401 otherwise).
  app.use("/api/*", buildAuthMiddleware({ auth: auth ?? null, db: providers.db }));

  app.route("/api/sessions", sessionsRouter);
  // Messages + threads share /api/sessions/:id/* — mounted under same prefix.
  app.route("/api/sessions", messagesRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/teams", teamsRouter);
  app.route("/api/memory", memoryRouter);
  app.route("/api/orchestrator", orchestratorRouter);
  app.route("/api/notifications", notificationsRouter);
  app.route("/api/workflows", workflowsRouter);
  app.route("/api/plugins", pluginsRouter);
  app.route("/api/credentials", credentialConnectRouter);
  app.route("/api/credentials", credentialsRouter);
  app.route("/api/onepassword", onePasswordRouter);
  // Mounted BEFORE /api/me — defensive ordering only: meRouter today
  // registers just GET / and PATCH / (no wildcard/param routes), so there is
  // no actual collision to lose. Revisit this ordering if /api/me ever grows
  // a catch-all route that could shadow /api/me/identity-links.
  app.route("/api/me/identity-links", identityLinksRouter);
  // Mounted BEFORE /api/me for the same defensive-ordering reason as
  // identityLinksRouter above.
  app.route("/api/me/github", githubConnectRouter);
  app.route("/api/me", meRouter);
  app.route("/api/models", modelsRouter);
  app.route("/api/org", orgRouter);
  app.route("/api/org/invites", orgInvitesRouter);
  app.route("/api/org/llm-providers", llmProvidersRouter);
  app.route("/api/org/github-app", githubAppRouter);
  app.route("/api/org/image-catalog", imageCatalogRouter);
  app.route("/api/org/prebuilds", prebuildsRouter);
  app.route("/api/prebuilds", prebuildsPublicRouter);
  app.route("/api/repos", reposRouter);
  app.route("/api/sandbox", sandboxGitCredentialRouter);

  // WebSocket — must be registered against the same Hono instance the runtime
  // WS handler was constructed with. The adapter's `serve` (returned in
  // `startServer` below) attaches the upgrade handler at listen time (Node:
  // `injectWebSocket(server)`; Bun: `Bun.serve({ websocket })`).
  const { upgradeWebSocket, serve } = adapter.createWebSocket(app);
  registerWsRoutes(app, upgradeWebSocket);
  // Gateway reverse-proxy: WS upgrade `GET` registered before the HTTP
  // `ALL` on the same `/api/sessions/:id/gateway/*` path — `upgradeWebSocket`
  // only engages on `Upgrade: websocket`, so ordering here is what lets the
  // HTTP handler still answer everything else on that path.
  registerGatewayWsProxy(app, upgradeWebSocket);
  registerGatewayHttpProxy(app);

  // Web app static serving + SPA fallback — registered LAST (decision 3):
  // every real route above must get first crack at a request. No-op unless
  // `opts.webDistDir` points at a real build (has index.html).
  const webServed = mountWebStatic(app, opts.webDistDir);

  // Default 404 for anything no route (or the SPA fallback above) claimed —
  // JSON, not Hono's plain-text default, so `/api/*` typos and unmounted
  // `/mcp`/`/.well-known/*` routes 404 as JSON rather than falling through
  // to an HTML page.
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // Final fallback for anything thrown out of a route handler. Without this,
  // Hono returns a generic 500 with the HTML error page; we want JSON.
  app.onError((err, c) => {
    console.error(`route error ${c.req.method} ${c.req.path}:`, err);
    return c.json(
      {
        error: err.message ?? "internal error",
        code: (err as NodeJS.ErrnoException).code,
      },
      500,
    );
  });

  return {
    app,
    startServer: (startOpts) => serve(startOpts),
    webServed,
  };
}

export type App = ReturnType<typeof createApp>["app"];
