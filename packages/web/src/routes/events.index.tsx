import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** `/events`: redirect-only. The Log is the Presence Activity tab, a
 * Subscriptions review link opens the listener page, and every other URL
 * opens Places (`-presence-redirects.ts`). */
export const Route = createFileRoute("/events/")({
  beforeLoad: redirectToPresence("/events"),
});
