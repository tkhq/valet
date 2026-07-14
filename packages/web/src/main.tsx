import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { applyStoredTheme } from "./lib/theme";

// Apply the persisted theme choice (Settings → Appearance) before the first
// paint so a returning `dark`/`light` user doesn't see a light-mode flash.
applyStoredTheme();

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
