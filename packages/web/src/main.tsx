import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { applyStoredPalette, applyStoredTheme } from "./lib/theme";

// Apply the persisted appearance choices (Settings → Appearance) before the
// first React paint. The inline script in `index.html` has normally done
// this already; these two calls repeat it because that script is a
// best-effort fast path that a storage error can skip, and because they are
// the only step that CLEARS a stale attribute when the stored value is
// invalid.
applyStoredTheme();
applyStoredPalette();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Sessions list, etc. — moderate freshness; WS will push live updates.
      staleTime: 5_000,
      retry: 1,
    },
  },
});

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
