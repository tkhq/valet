import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** `/presence/listeners/$id`: the revision 1 URL of one line of presence. It
 * holds no page and redirects to `/presence/rules/$id` (spec Part A step 4). */
export const Route = createFileRoute("/presence/listeners/$id")({
  beforeLoad: redirectToPresence("/presence/listeners/$id"),
});
