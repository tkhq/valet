import { createFileRoute } from "@tanstack/react-router";
import { PresenceDetailPage, PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/events/$eventId`: one event at its own URL. It replaces
 * `/events/$eventId`. */
export const Route = createFileRoute("/presence/events/$eventId")({
  component: PresenceEventPage,
});

export function PresenceEventPage() {
  return (
    <PresenceDetailPage back="/presence/activity" backLabel="Activity" title="Event">
      <PresencePlaceholder>This page shows the event and what Valet did with it.</PresencePlaceholder>
    </PresenceDetailPage>
  );
}
