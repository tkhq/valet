/**
 * Serves the built `@valet/web` SPA from the api process (kubernetes-deployment
 * design decision 3 — one pod, one Service, no separate web deployment).
 *
 * Registered LAST in `app.ts`, after every `/api/*` router and the
 * `/mcp` / `/.well-known/*` auth routes, so it never shadows them: static
 * asset lookups AND the SPA index.html fallback both explicitly skip paths
 * under `/api`, `/mcp`, and `/.well-known` (adversarial-review catch — a
 * naive catch-all fallback would serve `index.html` for those paths when no
 * real handler matched, turning a JSON 404 or an OAuth discovery 404 into an
 * HTML page).
 *
 * Only mounted when `webDistDir` is provided AND contains an `index.html` —
 * `main.ts` only sets `VALET_WEB_DIST_DIR` in the bundled production image,
 * so `make dev-local` (Vite dev server + proxy) is unaffected.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppEnv } from "./env.js";

const RESERVED_PREFIXES = ["/api", "/mcp", "/.well-known"];

function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Mounts static-asset serving + SPA fallback rooted at `webDistDir` if it
 * looks like a real Vite build output (has `index.html`). No-op (returns
 * `false`) otherwise, so callers can log accordingly.
 */
export function mountWebStatic(app: Hono<AppEnv>, webDistDir: string | undefined): boolean {
  if (!webDistDir) return false;
  const indexPath = join(webDistDir, "index.html");
  if (!existsSync(indexPath)) return false;

  const indexHtml = readFileSync(indexPath, "utf-8");
  const staticMiddleware = serveStatic({ root: webDistDir });

  app.use("*", async (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    // Pass a no-op `next` so `serveStatic`'s internal not-found fallthrough
    // resolves to `undefined` from that no-op instead of continuing past
    // this middleware into the app's own 404 handler — the SPA fallback
    // below is what should run instead. NOTE: check the *return value*, not
    // `c.finalized` — Hono only flips `finalized` when the router commits a
    // handler's return value to `c.res`, which hasn't happened yet from
    // inside this nested call (verified against `serveStatic`'s source:
    // the found branch returns `c.body(...)`'s Response directly without
    // ever assigning `c.res`).
    const result = await staticMiddleware(c, async () => undefined);
    if (result) return result;
    return c.html(indexHtml);
  });

  return true;
}
