import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the workflow list is `/workflows` again
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/presence/workflows/")({
  beforeLoad: redirectToPresence("/presence/workflows"),
});
