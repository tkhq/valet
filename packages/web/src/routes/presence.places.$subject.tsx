import { createFileRoute } from "@tanstack/react-router";
import { PlacePage } from "~/components/presence/place-page";

/** `/presence/places/$subject`: one place, such as `#incidents` or `acme/api`. It
 * replaces `/channel?key=`. The param is the place key, such as `slack:T1/C123`. */
export const Route = createFileRoute("/presence/places/$subject")({
  component: PlacePageRoute,
});

function PlacePageRoute() {
  const { subject } = Route.useParams();
  return <PlacePage subject={subject} />;
}
