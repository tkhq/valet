import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** `/presence/routines`: the revision 2 Routines pane, now a redirect
 * (`-presence-redirects.ts`, INV-H1). `?routine=<id>` goes to that
 * routine's page; every other URL goes to the overview, whose `On a
 * schedule` group lists the routines. */
export const Route = createFileRoute("/presence/routines/")({
  beforeLoad: redirectToPresence("/presence/routines"),
});
