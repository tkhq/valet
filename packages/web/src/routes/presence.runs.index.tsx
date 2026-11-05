import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the Runs view is `/workflows/runs` again
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/presence/runs/")({
  beforeLoad: redirectToPresence("/presence/runs"),
});
