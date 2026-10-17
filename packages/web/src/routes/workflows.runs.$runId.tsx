import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the run page is `/presence/runs/$runId` now
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/workflows/runs/$runId")({
  beforeLoad: redirectToPresence("/workflows/runs/$runId"),
});
