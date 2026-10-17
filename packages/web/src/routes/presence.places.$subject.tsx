import { createFileRoute } from "@tanstack/react-router";
import { PresenceDetailPage, PresencePlaceholder } from "~/components/presence/page-shell";

/** `/presence/places/$subject`: one place, such as `#incidents` or `acme/api`. It
 * replaces `/channel?key=`. The param is the place key, such as `slack:C123`. */
export const Route = createFileRoute("/presence/places/$subject")({
  component: PlacePageRoute,
});

function PlacePageRoute() {
  const { subject } = Route.useParams();
  return <PlacePage subject={subject} />;
}

export function PlacePage({ subject }: { subject: string }) {
  return (
    <PresenceDetailPage back="/presence" backLabel="Places" title={subject}>
      <PresencePlaceholder>This page shows who listens here and the threads that work here.</PresencePlaceholder>
    </PresenceDetailPage>
  );
}
