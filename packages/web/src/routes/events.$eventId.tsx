import { createFileRoute } from "@tanstack/react-router";
import { redirectToPresence } from "./-presence-redirects";

/** `/events/$eventId`: redirect-only. The event page is
 * `/presence/events/$eventId` (`-presence-redirects.ts`). */
export const Route = createFileRoute("/events/$eventId")({
  beforeLoad: redirectToPresence("/events/$eventId"),
});
