import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** Redirect-only: the editor is `/workflows/$workflowId` again
 * (`-presence-redirects.ts`). */
export const Route = createFileRoute("/presence/workflows/$workflowId")({
  beforeLoad: redirectToPresence("/presence/workflows/$workflowId"),
});
