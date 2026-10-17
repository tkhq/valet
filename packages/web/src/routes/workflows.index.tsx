import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the list is the Workflows tab of Presence now, and the old
 * Scheduled tab is Routines (`-presence-redirects.ts`). `validateSearch`
 * stays so links that still name the old tabs keep their types. */
export const Route = createFileRoute("/workflows/")({
  beforeLoad: redirectToPresence("/workflows"),
  validateSearch: (search: Record<string, unknown>): { workspace?: string; tab?: "scheduled"; run?: string; gate?: string; review?: string } => ({
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    tab: search.tab === "scheduled" || search.tab === "triggers" ? "scheduled" : undefined,
    run: typeof search.run === "string" ? search.run : undefined,
    review: typeof search.review === "string" ? search.review : undefined,
    gate: typeof search.gate === "string" ? search.gate : undefined,
  }),
});
