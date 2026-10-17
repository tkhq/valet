import { createFileRoute } from "@tanstack/react-router";
import { PresenceDetailPage, PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/listeners/$id`: one listener. It replaces the inline edit and
 * review of the Subscriptions tab of `/events`. */
export const Route = createFileRoute("/presence/listeners/$id")({
  component: ListenerPage,
});

export function ListenerPage() {
  return (
    <PresenceDetailPage back="/presence" backLabel="Places" title="Listener">
      <PresencePlaceholder>This page shows what the listener does and lets you change it.</PresencePlaceholder>
    </PresenceDetailPage>
  );
}
