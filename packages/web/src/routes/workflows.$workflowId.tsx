import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the editor is `/presence/workflows/$workflowId` now
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/workflows/$workflowId")({
  beforeLoad: redirectToPresence("/workflows/$workflowId"),
});
