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
import { createNodeWebSocket } from "@hono/node-ws";
import type { AppEnv } from "./env.js";
import type { Providers } from "./providers/types.js";
import { providersMiddleware } from "./middleware/providers.js";
import { authMiddleware } from "./middleware/auth.js";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, type ValetAuth } from "./auth/index.js";
import type { AuthConfig } from "./auth/config.js";
import type { AuthConfigResponse } from "./wire/types.js";
import { sessionsRouter } from "./routes/sessions.js";
import { messagesRouter } from "./routes/messages.js";
import { adminRouter } from "./routes/admin.js";
import { teamsRouter } from "./routes/teams.js";
import { memoryRouter } from "./routes/memory.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { notificationsRouter } from "./routes/notifications.js";
import { workflowsRouter } from "./routes/workflows.js";
import { pluginsRouter } from "./routes/plugins.js";
import { credentialsRouter } from "./routes/credentials.js";
import { meRouter } from "./routes/me.js";
import { modelsRouter } from "./routes/models.js";
import { orgRouter } from "./routes/org.js";
import { orgInvitesRouter } from "./routes/org-invites.js";
import { registerWsRoutes } from "./routes/ws.js";

export interface CreatedApp {
  app: Hono<AppEnv>;
  /** Call after `serve()` to attach the WS upgrade handler to the http server. */
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
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

export function createApp(providers: Providers, authWiring: AuthWiring = {}): CreatedApp {
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

  // Public health check (no auth).
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "valet-api", ts: Date.now() }),
  );

  // better-auth owns everything under /api/auth/* (signup, login, session,
  // social + SSO callbacks, api-key endpoints, MCP OAuth). Mounted BEFORE
  // authMiddleware so it's public even when VALET_LOCAL_AUTH isn't set —
  // otherwise login/signup could never succeed in production.
  if (auth) {
    app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.get("/.well-known/oauth-authorization-server", (c) => oAuthDiscoveryMetadata(auth)(c.req.raw));
    app.get("/.well-known/oauth-protected-resource", (c) => oAuthProtectedResourceMetadata(auth)(c.req.raw));
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
  app.use("/api/*", authMiddleware);

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
  app.route("/api/credentials", credentialsRouter);
  app.route("/api/me", meRouter);
  app.route("/api/models", modelsRouter);
  app.route("/api/org", orgRouter);
  app.route("/api/org/invites", orgInvitesRouter);

  // WebSocket — must be registered against the same Hono instance that
  // node-ws was constructed with. main.ts calls injectWebSocket(server)
  // after serve().
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  registerWsRoutes(app, upgradeWebSocket);

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

  return { app, injectWebSocket };
}

export type App = ReturnType<typeof createApp>["app"];
