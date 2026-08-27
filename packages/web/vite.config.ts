import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";

const API_URL = process.env.VITE_API_URL ?? "http://localhost:8788";

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
  ],
  server: {
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
