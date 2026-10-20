import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** `/events`: redirect-only. The Log opens Presence Activity, a
 * Subscriptions review link opens that line's rule page, and every other URL
 * opens `/presence` (`-presence-redirects.ts`). */
export const Route = createFileRoute("/events/")({
  beforeLoad: redirectToPresence("/events"),
});
