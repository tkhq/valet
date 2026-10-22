import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { applyStoredPalette, applyStoredTheme } from "./lib/theme";
import { registerServiceWorker } from "./pwa/register";
import { api } from "./api/client";
import { createQueryClient } from "./api/query-client";
import { loadPublicOrigin } from "./lib/public-origin";

// Apply the persisted appearance choices (Settings → Appearance) before the
// first React paint. The inline script in `index.html` has normally done
// this already; these two calls repeat it because that script is a
// best-effort fast path that a storage error can skip, and because they are
// the only step that CLEARS a stale attribute when the stored value is
// invalid.
applyStoredTheme();
applyStoredPalette();

// PWA install support. Production-only; see src/pwa/register.ts.
registerServiceWorker();

// Generated file links name the deployment's public origin. Markdown opens
// them on this hostname once the origin is known (lib/public-origin.ts).
void loadPublicOrigin(() => api.getAuthConfig());

const queryClient = createQueryClient();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
