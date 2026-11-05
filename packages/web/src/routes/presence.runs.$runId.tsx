import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the run page is `/workflows/runs/$runId` again
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/presence/runs/$runId")({
  beforeLoad: redirectToPresence("/presence/runs/$runId"),
});
