import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { valetServiceWorker } from "./src/pwa/vite-plugin";

const API_URL = process.env.VITE_API_URL ?? "http://localhost:8788";

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
    valetServiceWorker(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Fail instead of auto-incrementing to :5174: the /api proxy target is
    // fixed, so a drifted port silently serves this checkout's frontend
    // against another running stack's api and database.
    strictPort: true,
    proxy: {
      "/api": {
        target: API_URL,
        changeOrigin: true,
        ws: true,
        // While the api restarts, answer 503 with a plain-text body as the
        // production load balancer does, so the web app shows its
        // reconnecting state (src/api/connection.ts). Vite's own handler,
        // which runs after this one, would answer 500, a real error.
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !res.headersSent && !res.writableEnded) {
              res.writeHead(503, { "Content-Type": "text/plain" }).end("The api is not running.");
            }
          });
        },
      },
      // The recording gateway is mounted at /proxy on the api (NOT under /api).
      // Forward it too so the onboarding snippet's `${origin}/proxy/...` URL —
      // which is same-origin in production — also works against the dev stack.
      "/proxy": {
        target: API_URL,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
